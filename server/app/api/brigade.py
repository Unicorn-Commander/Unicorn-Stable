"""Brigade agents API — list available Brigade agents, invite into rooms."""

from __future__ import annotations

import os
from typing import Annotated, Any
from urllib.parse import urljoin, urlparse

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from redis.asyncio import Redis

from app.deps import get_current_user, get_db, get_livekit, get_redis, rate_limit
from app.models.agent_gateway_key import AgentGatewayKey
from app.services.agent_access import ensure_agent_access, entitled_agent_ids
from app.services.agent_availability import classify, get_gateway_fresh
from app.services.livekit_service import LiveKitService
from app.services.resident_agents import (
    add_resident_agent,
    remove_resident_agent,
)

logger = structlog.get_logger(__name__)

router = APIRouter()


class BrigadeAgent(BaseModel):
    id: str
    name: str
    description: str = ""
    # May THIS caller reach this agent (grants + AGENT_ACCESS_DEFAULT)?
    # Annotation only — enforcement is server-side on the invite path. The
    # client renders un-entitled agents locked ("Ask an admin"), not hidden.
    entitled: bool = True


class BrigadeRosterAgent(BaseModel):
    """Rich agent record for the org-chart / roster view.

    Sourced from Brigade's native ``/agents`` endpoint (the source of truth),
    flattened to the shape the Stable frontend's ``Agent`` type expects plus the
    extra org-chart fields (rank, title, domain, tools). ``emoji`` carries
    Brigade's single-glyph fallback; ``avatar_url`` is the resolved image URL
    (see _resolve_agent_avatar), null only when the identity has no verified
    image binding.
    """

    id: str
    name: str
    display_name: str
    description: str = ""
    avatar_url: str | None = None
    emoji: str | None = None
    status: str = "active"
    capabilities: list[str] = []
    model: str = ""
    rank: str | None = None
    title: str | None = None
    domain: str | None = None
    # Who this agent reports to, as STATED by Brigade (agents.reports_to).
    # Brigade is the registry for agent identity — name, rank, title, avatar —
    # so it is the registry for the chain of command too. Stable renders this
    # instead of re-deriving parentage from rank + domain in a second
    # implementation that can (and did) disagree with Brigade's. None means
    # either "the apex" or "Brigade has not stated it", and the client falls
    # back to its own derivation only when NOBODY on the roster states a line.
    reports_to: str | None = None
    affiliation: str = "employee"
    tools: list[str] = []
    # Per-tool cost/permission detail + rollup (from Brigade's tool_catalog).
    tool_details: list[dict[str, Any]] = []
    tool_cost_summary: dict[str, Any] | None = None
    # Can this agent actually be invoked right now? Separate from `status`,
    # which is Brigade's own registration state and is not, by itself, the
    # answer: a bridge agent is not a Brigade persona at all, and Brigade being
    # unreachable is an unknown rather than a "no". "available" | "unavailable"
    # | "unknown"; see services/agent_availability.py for the truth table.
    availability: str = "unknown"
    availability_reason: str = "unknown"
    # May THIS caller reach this agent (grants + AGENT_ACCESS_DEFAULT)? The
    # org chart still shows everyone — it's a directory — but the client's
    # action affordances (Chat/Call) lock on entitled=False with an
    # "Ask an admin" hint. Enforcement is server-side on the invite path;
    # this flag only keeps the UI honest.
    entitled: bool = True


class InviteAgentRequest(BaseModel):
    brigade_agent_id: str
    # Optional per-conversation LLM override (model switcher), persisted on the
    # room so both the voice dispatch and the text responder use it.
    model: str | None = None
    # When False, only bind the agent to the room (membership + metadata for
    # the text responder) without dispatching a LiveKit voice worker. Text
    # contexts (creating a DM thread, switching the resident agent outside a
    # call) must pass False — a worker dispatched with no call to join sits in
    # an empty LiveKit room, and a second dispatch at call time then collides
    # with it (both jobs share the "agent-brigade" identity and kill each
    # other, leaving the call agentless).
    dispatch: bool = True


class InviteAgentResponse(BaseModel):
    room_name: str
    brigade_agent_id: str
    dispatched: bool
    dispatch_id: str | None = None
    reason: str | None = None


# Stable, machine-readable prefix for the human-DM bind refusal (409). Clients
# may branch on `detail.startswith(HUMAN_DM_AGENT_BIND_REFUSED)`.
HUMAN_DM_AGENT_BIND_REFUSED = "agent_bind_refused_human_dm"


def _is_human_pair_dm(
    room_type: str,
    metadata: dict[str, Any] | None,
    human_member_count: int,
) -> bool:
    """True when binding a resident agent would CONVERT a human 1:1 DM.

    Stamping ``metadata.brigade_agent_id`` on a room reclassifies it as an
    agent conversation everywhere (sidebar, home, quick switcher key off
    ``dm + brigade_agent_id``), so a bind onto a HUMAN pair DM makes the
    private human thread vanish from Chats — the Shafen/Majik field bug.
    That conversion must go through POST /rooms/{id}/start-group, which
    creates a NEW group room and leaves the DM untouched.

    A human pair DM is: ``room_type == "dm"``, NO existing agent binding, and
    either the canonical ``dm_pair`` stamp (every ensure-DM room) or at least
    two human members (legacy pre-``dm_pair`` DMs). Agent DMs pass because
    they carry ``brigade_agent_id`` from birth — and at the moment of that
    birth ("New chat" binds right after create) they have neither ``dm_pair``
    nor a second human, so first-bind passes too.
    """
    if room_type != "dm":
        return False
    meta = metadata or {}
    if meta.get("brigade_agent_id"):
        return False  # already an agent conversation — rebind/redispatch is fine
    return bool(meta.get("dm_pair")) or human_member_count >= 2


# ---------------------------------------------------------------------------
# AGENT AVATAR RESOLUTION
#
# Brigade is the canonical registry for agent identity, exactly as for rank and
# title. Stable resolves, in order:
#
#   1. the registered image  (Brigade `avatarUrl`)
#   2. the `/avatars/<id>.webp` convention, IF a base URL is configured
#   3. the EMOJI GLYPH       (Brigade `avatar` — a single character)
#   4. initials on the identity colour (client-side; see lib/avatar.ts)
#
# CURRENT CONTRACT (verified 2026-07-29): Brigade serves its portrait catalog
# at https://brigade.magicunicorn.dev/avatars/*.webp and its current database
# has avatar_url populated for part of the roster. Stable therefore configures
# BRIGADE_AVATAR_BASE_URL for the complete convention catalog while continuing
# to let an explicit avatarUrl win. Relative explicit URLs are resolved against
# the Brigade origin here — never against Stable's origin in the browser.
# ---------------------------------------------------------------------------

# Hosts we are willing to point an <img> at. An agent avatar URL comes from
# Brigade's database, which is not a trust boundary Stable controls, and it
# renders in every connected client — an arbitrary host would make every
# viewer's IP and user agent visible to whoever set that row. Same-origin
# (relative) paths are always fine.
_AVATAR_HOST_SUFFIXES = (
    "magicunicorn.dev",
    "magicunicorn.tech",
    "unicorncommander.ai",
)

# A convention URL is only useful when Brigade actually owns that filename.
# Do not synthesize 404s for every dynamically registered runtime agent.
_CONVENTION_AVATAR_IDS = frozenset(
    {
        "the-general",
        "gunny",
        "sgt-cipher",
        "cpt-fullstack",
        "maj-devops",
        "col-finance",
        "lt-taxstrat",
        "judge-advocate",
        "doc-medresearch",
        "detective-holmes",
        "prof-datasci",
        "support-agent",
        "code-reviewer",
        "sql-analyst",
        "sgt-scribe",
        "maj-leadgen",
        "lt-docanalyst",
        "iris",
        "perry",
        "prudence",
        "cpl.-colophon",
    }
)


def _safe_avatar_url(raw: Any) -> str | None:
    """Accept a relative path or an https URL on one of our own hosts; else None.

    Returning None is not a failure — it drops to a verified convention image,
    then emoji, then initials.
    """
    if not isinstance(raw, str):
        return None
    url = raw.strip()
    if not url:
        return None
    if url.startswith("/") and not url.startswith("//"):
        return url  # same-origin
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    if any(host == s or host.endswith("." + s) for s in _AVATAR_HOST_SUFFIXES):
        return url
    logger.debug("agent_avatar_url_rejected", url=url, host=host)
    return None


def _convention_avatar_url(agent_id: str) -> str | None:
    """Tier 2: the ``<base>/<id>.webp`` convention, only if configured.

    Set BRIGADE_AVATAR_BASE_URL to the Brigade-owned portrait directory.
    """
    base = (os.environ.get("BRIGADE_AVATAR_BASE_URL") or "").strip().rstrip("/")
    if not base or agent_id not in _CONVENTION_AVATAR_IDS:
        return None
    return _safe_avatar_url(f"{base}/{agent_id}.webp")


def _registered_avatar_url(raw: Any) -> str | None:
    """Resolve a Brigade ``avatarUrl`` into a browser-safe absolute URL.

    Brigade stores portable same-origin paths for its built-in roster. If those
    paths crossed the API unchanged, a Stable browser would request them from
    Stable and render a broken image. Anchor them to Brigade's configured
    public origin first; absolute trusted URLs are left unchanged.
    """

    if (
        isinstance(raw, str)
        and raw.startswith("/api/brands/")
        and not raw.startswith("//")
    ):
        # Brand-Ops asset routes are relative to Brand-Ops, not Brigade or
        # Stable. Brigade does not currently proxy them, and the Brand-Ops
        # public host requires its own browser session. Passing the path
        # through would make every Stable client request a guaranteed 404 from
        # Stable. Preserve the emoji/initials fallback until Brigade imports an
        # approved master or exposes an authenticated asset proxy.
        logger.warning("brand_ops_relative_avatar_not_proxyable", url=raw)
        return None
    if isinstance(raw, str) and raw.startswith("/") and not raw.startswith("//"):
        brigade_origin = get_settings().brigade_base_url.rstrip("/") + "/"
        return _safe_avatar_url(urljoin(brigade_origin, raw))
    return _safe_avatar_url(raw)


def _resolve_agent_avatar(item: dict[str, Any]) -> tuple[str | None, str | None]:
    """Return (avatar_url, emoji) for one Brigade roster record."""
    agent_id = str(item.get("id") or "")
    url = _registered_avatar_url(
        item.get("avatarUrl")
    ) or _convention_avatar_url(agent_id)
    raw_emoji = item.get("avatar")
    emoji = raw_emoji.strip()[:8] if isinstance(raw_emoji, str) and raw_emoji.strip() else None
    return url, emoji


async def _fetch_brigade_agents() -> list[BrigadeAgent]:
    """Proxy Brigade's /models endpoint to get the full agent roster."""
    settings = get_settings()
    if not settings.brigade_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Brigade not configured. Set BRIGADE_API_KEY in the Stable backend.",
        )

    url = settings.brigade_base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {settings.brigade_api_key}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
        try:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            body = resp.json()
        except httpx.HTTPError as e:
            logger.error("brigade_models_fetch_failed", url=url, error=str(e))
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Could not reach Brigade: {e}",
            )

    items = body.get("data", [])
    return [
        BrigadeAgent(
            id=item["id"],
            name=item.get("name") or item["id"],
            description=item.get("description") or "",
        )
        for item in items
    ]


# Mac Studio bridge/gateway crew seats eligible for the "new chat" / invite
# picker, keyed by the agent_id their gateway credential posts as (see
# api/gateway.py, models/agent_gateway_key.py). Deliberately a small fixed
# allowlist, NOT every row in agent_gateway_keys — that table also holds
# ephemeral show-night seats (E04 one-offs), bots (reddit-scout), and
# third-party agents (a guest's own Claude Code) that are not conversational
# personas anyone should "start a new chat" with from this picker.
_BRIDGE_CREW_AGENTS: dict[str, tuple[str, str]] = {
    "claude-code": ("Rook", "Aaron's Mac Studio seat — Build In Public showrunner"),
    "persephone": ("Persephone", "Aaron's Mac Studio seat — main assistant"),
}


async def _fetch_bridge_crew_agents(db: AsyncSession) -> list[BrigadeAgent]:
    """The _BRIDGE_CREW_AGENTS entries that currently hold a live key.

    Only ids with a non-revoked ``agent_gateway_keys`` row are returned, so a
    revoked/rotated seat quietly drops out of the picker instead of dangling
    there as an invite that will 403/404 downstream.
    """
    if not _BRIDGE_CREW_AGENTS:
        return []
    rows = (
        (
            await db.execute(
                select(AgentGatewayKey.agent_id)
                .where(
                    AgentGatewayKey.agent_id.in_(list(_BRIDGE_CREW_AGENTS.keys())),
                    AgentGatewayKey.revoked_at.is_(None),
                )
                .distinct()
            )
        )
        .scalars()
        .all()
    )
    return [
        BrigadeAgent(id=agent_id, name=name, description=desc)
        for agent_id in rows
        for name, desc in [_BRIDGE_CREW_AGENTS[agent_id]]
    ]


async def _fetch_invitable_agents(db: AsyncSession) -> list[BrigadeAgent]:
    """Brigade's roster plus the bridge crew allowlist, merged.

    The two sources degrade independently — a Brigade outage must not hide
    Rook/Persephone (they have nothing to do with Brigade being up), and an
    empty bridge allowlist must not change today's behavior at all. Brigade's
    own fetch failure is only swallowed when the bridge crew has something to
    fall back to; with an empty bridge list this re-raises exactly as
    ``_fetch_brigade_agents`` always has, so a genuine BRIGADE_API_KEY
    misconfiguration still surfaces to whoever is looking at the error.
    """
    bridge = await _fetch_bridge_crew_agents(db)
    try:
        brigade = await _fetch_brigade_agents()
    except HTTPException:
        if not bridge:
            raise
        logger.warning(
            "brigade_fetch_failed_falling_back_to_bridge_crew",
            bridge_agent_ids=[a.id for a in bridge],
        )
        brigade = []
    return brigade + bridge


async def _entitlement_set(
    db: AsyncSession, user: dict[str, Any], agent_ids: list[str]
) -> set[str] | None:
    """The agent ids this caller may reach, or None meaning "all of them".

    None (skip annotation) for non-human principals: the worker's service
    account is never entitlement-gated, so its roster must not be filtered
    either. Fail-open on lookup errors — the roster is a read surface and the
    invite path re-checks authoritatively.
    """
    if user.get("participant_type") == "agent":
        return None
    try:
        return await entitled_agent_ids(
            db, participant_id=user["participant_id"], agent_ids=agent_ids
        )
    except Exception:
        logger.warning("agent_entitlement_annotation_failed", exc_info=True)
        return None


@router.get("/brigade/agents", response_model=list[BrigadeAgent])
async def list_brigade_agents(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[BrigadeAgent]:
    """List all Brigade agents (models) available to invite into rooms.

    Returns the upstream roster from Brigade (all agents configured in its
    database), not Stable's own agent_config table. This is deliberate —
    Brigade is the source of truth for agents. Each entry carries `entitled`
    for THIS caller (see BrigadeAgent.entitled).
    """
    agents = await _fetch_invitable_agents(db)
    allowed = await _entitlement_set(db, user, [a.id for a in agents])
    if allowed is not None:
        for a in agents:
            a.entitled = a.id in allowed
    return agents


def _brigade_native_base() -> str:
    """Brigade's native /api/v1 base (strip the OpenAI-compat ``/openai/v1`` tail)."""
    base = get_settings().brigade_base_url.rstrip("/")
    return base[: -len("/openai/v1")] if base.endswith("/openai/v1") else base


async def _fetch_brigade_roster(redis: Redis) -> list[BrigadeRosterAgent]:
    """Fetch the RICH agent roster from Brigade's native ``/agents`` endpoint.

    Unlike ``/models`` (OpenAI-shaped: id/name/description only), the native
    ``/agents`` endpoint returns rank, title, model, avatar, domain, tools and
    capabilities — everything the org-chart view needs. Fail-safe: any upstream
    error raises 502 so the caller can degrade gracefully.
    """
    settings = get_settings()
    if not settings.brigade_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Brigade not configured. Set BRIGADE_API_KEY in the Stable backend.",
        )
    url = _brigade_native_base() + "/agents"
    headers = {"Authorization": f"Bearer {settings.brigade_api_key}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
        try:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            body = resp.json()
        except httpx.HTTPError as e:
            logger.error("brigade_roster_fetch_failed", url=url, error=str(e))
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Could not reach Brigade: {e}",
            )

    items = body.get("agents", []) if isinstance(body, dict) else (body or [])

    # Availability is computed from THIS fetch (the roster we just proved we
    # could read) plus the gateway-freshness markers, rather than by calling
    # agent_availability.get_agent_availability, which would re-fetch the same
    # roster. Both paths funnel through the one `classify` truth table so the
    # sidebar and the room roster cannot disagree.
    ids = [str(it.get("id")) for it in items if isinstance(it, dict) and it.get("id")]
    fresh = await get_gateway_fresh(redis, ids)

    roster: list[BrigadeRosterAgent] = []
    for it in items:
        raw_status = (it.get("status") or "active").lower()
        ui_status = "offline" if raw_status in ("offline", "inactive", "disabled") else "active"
        name = it.get("displayName") or it.get("name") or it["id"]
        caps = it.get("capabilities") or []
        tools = it.get("tools") or []
        tool_details = it.get("toolDetails") or []
        # Affiliation now comes from Brigade's shared tool/affiliation catalog.
        # Fall back to a model-derived guess if an older Brigade hasn't populated
        # it yet (frontier API model -> frontier; otherwise we run it -> employee).
        affiliation = (it.get("affiliation") or "").strip().lower()
        if affiliation not in ("employee", "contractor", "third_party", "frontier"):
            m = (it.get("model") or "").lower()
            affiliation = (
                "frontier"
                if m.startswith(("anthropic/", "openai/", "google/"))
                or m.startswith(("claude", "gpt", "gemini"))
                else "employee"
            )
        avatar_url, emoji = _resolve_agent_avatar(it)
        availability, availability_reason = classify(
            gateway_fresh=str(it["id"]) in fresh,
            # We are inside a successful roster read, so Brigade is known-good
            # and this agent is in it by construction.
            roster_known=True,
            brigade_status=raw_status,
        )
        roster.append(
            BrigadeRosterAgent(
                id=it["id"],
                availability=availability,
                availability_reason=availability_reason,
                name=name,
                display_name=it.get("displayName") or it.get("name") or it["id"],
                description=it.get("bio") or it.get("title") or "",
                avatar_url=avatar_url,
                emoji=emoji,
                status=ui_status,
                capabilities=[str(c) for c in caps] if isinstance(caps, list) else [],
                model=it.get("model") or "",
                rank=it.get("rank"),
                title=it.get("title"),
                domain=it.get("domain"),
                # Additive + backward compatible: a Brigade too old to carry
                # reports_to simply omits the key, this stays None, and the
                # client falls back to the rank/domain derivation.
                reports_to=it.get("reportsTo"),
                affiliation=affiliation,
                tools=[str(t) for t in tools] if isinstance(tools, list) else [],
                tool_details=tool_details if isinstance(tool_details, list) else [],
                tool_cost_summary=it.get("toolCostSummary"),
            )
        )
    return roster


@router.get("/brigade/roster", response_model=list[BrigadeRosterAgent])
async def list_brigade_roster(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    redis: Annotated[Redis, Depends(get_redis)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[BrigadeRosterAgent]:
    """The rich agent roster for the org-chart view (rank/title/model/tools).

    Carries `availability` so the sidebar can render an agent's dot honestly
    without needing that room's member roster — the sidebar shows agent threads
    for rooms that are not open, and `/members` is only polled for the ACTIVE
    room, so a per-room-only signal would leave every collapsed thread dark.
    Also carries `entitled` for THIS caller (see BrigadeRosterAgent.entitled).
    """
    roster = await _fetch_brigade_roster(redis)
    allowed = await _entitlement_set(db, user, [a.id for a in roster])
    if allowed is not None:
        for a in roster:
            a.entitled = a.id in allowed
    return roster


class ChatModel(BaseModel):
    id: str
    label: str
    family: str = ""
    # Curated-menu metadata (all optional so old clients keep working):
    badge: str = ""  # "Local" | "Cloud"
    desc: str = ""   # one-line human description
    cost: str = ""   # "included" | "$" — coarse cost signal for the picker


# Curated tiers the model switcher offers — the governed menu (Glean/Researcher
# pattern): a short allowlist of verified lanes, local-first, labeled by what
# they are FOR rather than raw catalog ids. Every id is a verified-working
# Brigade `model` override on the uchub gateway (checked 2026-07-04); qwen
# lanes are no-think per fleet policy. "Auto" (no override) is rendered by the
# client as the default row. Add ids only after verifying they route 200.
_SWITCHER_MODELS: list[dict[str, str]] = [
    {
        "id": "uc/chat-default-nothink",
        "label": "Qwen 3.6 35B - house brain",
        "family": "Local fleet - private",
        "badge": "Local",
        "desc": "The 3090 lane Majik runs on. Fast, 131k context, never leaves the rack.",
        "cost": "included",
    },
    {
        "id": "uc/chat-local-p40",
        "label": "Qwen 3.6 35B - long-haul P40",
        "family": "Local fleet - private",
        "badge": "Local",
        "desc": "Same brain on the P40 pool - use when the 3090 lane is busy.",
        "cost": "included",
    },
    {
        "id": "openrouter/anthropic/claude-sonnet-4.6",
        "label": "Claude Sonnet 4.6",
        "family": "Frontier - cloud",
        "badge": "Cloud",
        "desc": "Frontier reasoning for the genuinely hard stuff.",
        "cost": "$",
    },
    {
        "id": "openrouter/anthropic/claude-haiku-4.5",
        "label": "Claude Haiku 4.5",
        "family": "Frontier - cloud",
        "badge": "Cloud",
        "desc": "Snappy frontier-lite - cheap cloud speed.",
        "cost": "$",
    },
    {
        "id": "openrouter/moonshotai/kimi-k2.5",
        "label": "Kimi K2.5",
        "family": "Frontier - cloud",
        "badge": "Cloud",
        "desc": "Open-weights agentic heavyweight - strong tool use.",
        "cost": "$",
    },
    {
        "id": "deepseek-v4-flash",
        "label": "DeepSeek V4 Flash",
        "family": "Frontier - cloud",
        "badge": "Cloud",
        "desc": "Cheap, fast cloud overflow lane.",
        "cost": "$",
    },
]


@router.get("/models", response_model=list[ChatModel])
async def list_models(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
) -> list[ChatModel]:
    """List underlying LLMs for the mid-conversation model switcher.

    Curated, not the raw Brigade persona roster nor the full litellm catalog —
    each id is a verified-working Brigade ``model`` override. Local qwen models
    are no-think. The first entry is Majik's default.
    """
    _ = user
    return [ChatModel(**m) for m in _SWITCHER_MODELS]


async def _fetch_brigade_agent_record(agent_id: str) -> dict[str, Any] | None:
    """Fetch ONE agent's raw record from Brigade's native ``/agents``.

    Separate from _fetch_brigade_roster because that one needs Redis (for
    gateway-freshness) and returns the response model; this is used on the
    invite path, where all we want is identity. Never raises — a None result
    just means "no avatar for now".
    """
    settings = get_settings()
    if not settings.brigade_api_key or not agent_id:
        return None
    url = _brigade_native_base() + "/agents"
    headers = {"Authorization": f"Bearer {settings.brigade_api_key}"}
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0)
        ) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            body = resp.json()
    except (httpx.HTTPError, ValueError):
        logger.warning("brigade_agent_record_fetch_failed", agent_id=agent_id)
        return None
    items = body.get("agents", []) if isinstance(body, dict) else (body or [])
    for it in items:
        if isinstance(it, dict) and str(it.get("id")) == agent_id:
            return it
    return None


async def _ensure_agent_member(
    db: AsyncSession,
    room_id_or_lk: str,
    brigade_agent_id: str,
) -> str | None:
    """Ensure an agent-typed Participant exists and is a member of the room.

    Accepts either the Stable Postgres room UUID or the LiveKit room name.
    Returns the agent participant id (str) on success, None if room not found.
    """
    from sqlalchemy import select as _select

    from app.models.participant import (
        Participant as _P,
        ParticipantStatus as _PS,
        ParticipantType as _PT,
    )
    from app.models.room import MemberRole as _MR, Room as _Room, RoomMember as _RM

    # Resolve room
    room = (
        await db.execute(
            _select(_Room).where(_Room.livekit_room_name == room_id_or_lk)
        )
    ).scalar_one_or_none()
    if room is None:
        try:
            import uuid as _u

            uid = _u.UUID(room_id_or_lk)
            room = (
                await db.execute(_select(_Room).where(_Room.id == uid))
            ).scalar_one_or_none()
        except ValueError:
            room = None
    if room is None:
        return None

    # Find/create the agent Participant
    pseudo_sub = f"brigade:{brigade_agent_id}"
    pseudo_username = f"agent-{brigade_agent_id}"
    agent_p = (
        await db.execute(_select(_P).where(_P.keycloak_sub == pseudo_sub))
    ).scalar_one_or_none()

    # Pull the agent's identity from Brigade (the canonical registry) so the
    # Participant row carries an avatar. Without this, agent MESSAGES render
    # blank: message_service serialises `sender.avatar_url` off this row, and
    # every agent row in the live database has it null. Best-effort — Brigade
    # being down must not block binding an agent to a room.
    record = await _fetch_brigade_agent_record(brigade_agent_id)
    avatar_url, emoji = _resolve_agent_avatar(record) if record else (None, None)

    if agent_p is None:
        display = brigade_agent_id.replace("-", " ").title()
        if record:
            display = (
                record.get("displayName") or record.get("name") or display
            )
        agent_p = _P(
            keycloak_sub=pseudo_sub,
            username=pseudo_username,
            display_name=display,
            participant_type=_PT.AGENT,
            status=_PS.ONLINE,
        )
        agent_p.avatar_url = avatar_url
        agent_p.set_avatar_emoji(emoji)
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)
    elif record and avatar_url is not None and (
        # Never replace a working picture with nothing: Brigade's roster
        # bindings dangle/heal over time, and a None resolution here used to
        # NULL a backfilled avatar on the next invite (and a dangling one
        # replaced it with a 404).
        avatar_url != agent_p.keycloak_avatar_url or emoji != agent_p.avatar_emoji
    ):
        # Backfill/refresh rows created before agents had avatars. Assigning
        # through `avatar_url` writes the mirror tier, never an override, so an
        # agent picture set locally (if we ever add that) would still win.
        agent_p.avatar_url = avatar_url
        agent_p.set_avatar_emoji(emoji)
        await db.commit()
        await db.refresh(agent_p)

    # Add as room member if not already
    existing_member = (
        await db.execute(
            _select(_RM).where(
                _RM.room_id == room.id,
                _RM.participant_id == agent_p.id,
            )
        )
    ).scalar_one_or_none()
    if existing_member is None:
        db.add(
            _RM(
                room_id=room.id,
                participant_id=agent_p.id,
                role=_MR.MEMBER,
            )
        )
        await db.commit()

    return str(agent_p.id)


@router.post(
    "/rooms/{room_name}/invite-brigade-agent",
    response_model=InviteAgentResponse,
)
async def invite_brigade_agent(
    room_name: str,
    body: InviteAgentRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    _rl: Annotated[
        None,
        Depends(rate_limit("agent_invite", "rate_limit_agent_invite_per_min")),
    ] = None,
) -> InviteAgentResponse:
    """Spawn a Brigade-backed agent into an existing LiveKit room.

    The agent worker (WorkerOptions.agent_name = "stable-brigade") picks up
    the dispatch and runs `BrigadeBackedAgent`, which reads
    `brigade_agent_id` from the room metadata to decide which Brigade agent
    to act as.
    """
    settings = get_settings()

    # Sanity-check the requested agent exists (Brigade roster or the bridge
    # crew allowlist — see _fetch_invitable_agents).
    agents = await _fetch_invitable_agents(db)
    valid_ids = {a.id for a in agents}
    if body.brigade_agent_id not in valid_ids:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown agent: {body.brigade_agent_id}",
        )

    # Resolve the room (UUID id | slug name | LiveKit name) to its LiveKit room
    # name so the dispatched agent joins the SAME LiveKit room the human's token
    # targets (the web client sends the room UUID).
    import uuid as _uuid_rr
    from sqlalchemy import or_ as _or_rr, select as _sel_rr
    from app.models.room import Room as _Room_rr
    _rr_conds = [_Room_rr.livekit_room_name == room_name, _Room_rr.name == room_name]
    try:
        _rr_conds.append(_Room_rr.id == _uuid_rr.UUID(room_name))
    except (ValueError, TypeError):
        pass
    _resolved_room = (
        await db.execute(_sel_rr(_Room_rr).where(_or_rr(*_rr_conds)))
    ).scalar_one_or_none()
    lk_name = _resolved_room.livekit_room_name if _resolved_room else room_name

    # AUTHZ: the caller must be a member of the target room (mirrors the human
    # invite route in rooms.py). Without this, any authenticated user could
    # inject/hijack an agent — and force a model_override — into ANY room by
    # id/name, including private DMs they are not in.
    if _resolved_room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )
    from app.models.room import RoomMember as _RM_auth

    _caller_member = (
        await db.execute(
            _sel_rr(_RM_auth).where(
                _RM_auth.room_id == _resolved_room.id,
                _RM_auth.participant_id == user["participant_id"],
            )
        )
    ).scalar_one_or_none()
    if _caller_member is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of this room to invite an agent",
        )

    # HUMAN 1:1 DM GUARD (server backstop; the web client routes these to the
    # start-a-group flow before ever calling this route). Binding a resident
    # agent here would silently convert the private human DM into an agent
    # conversation — see _is_human_pair_dm. Applies to every caller of this
    # route, including old clients, scripts, and the agents worker's
    # summon_agent tool.
    from app.models.room import RoomType as _RT_guard

    _meta_guard = dict(_resolved_room.metadata_ or {})
    if _resolved_room.room_type == _RT_guard.DM and not _meta_guard.get(
        "brigade_agent_id"
    ):
        from sqlalchemy import func as _func_guard
        from app.models.participant import (
            Participant as _P_guard,
            ParticipantType as _PT_guard,
        )

        _human_count = int(
            (
                await db.execute(
                    _sel_rr(_func_guard.count())
                    .select_from(_RM_auth)
                    .join(_P_guard, _P_guard.id == _RM_auth.participant_id)
                    .where(
                        _RM_auth.room_id == _resolved_room.id,
                        _P_guard.participant_type == _PT_guard.HUMAN,
                    )
                )
            ).scalar_one()
            or 0
        )
        if _is_human_pair_dm("dm", _meta_guard, _human_count):
            logger.info(
                "agent_bind_refused_human_dm",
                room_id=str(_resolved_room.id),
                brigade_agent_id=body.brigade_agent_id,
                caller=str(user.get("participant_id")),
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"{HUMAN_DM_AGENT_BIND_REFUSED}: This is a private 1:1 "
                    "chat. Use 'Start a group' to bring an agent into the "
                    "conversation — the DM itself stays human-only."
                ),
            )

    # ENTITLEMENT: the caller must be allowed to use THIS agent (per-user
    # grants + AGENT_ACCESS_DEFAULT). This is the single funnel for every
    # human path that establishes agent access — agent-DM creation ("New
    # chat" binds via dispatch=False), inviting an agent into a room, and the
    # call-time voice dispatch (dispatch=True) — so gating here closes all
    # three. The agents WORKER also calls this route (summon_agent) but
    # authenticates as an agent-typed service account, which
    # ensure_agent_access passes through untouched.
    await ensure_agent_access(
        db, user, body.brigade_agent_id, surface="agent_invite"
    )

    # Only allow a model_override the switcher actually offers, so a caller can't
    # pin an arbitrary or expensive cloud lane on the conversation.
    if body.model and body.model not in {m["id"] for m in _SWITCHER_MODELS}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported model override: {body.model}",
        )

    # Dual-path design: the SERVER text responder
    # (services/agent_chat_responder.py) answers chat regardless of this call,
    # so a False/degraded dispatch is not a hard failure -- it just means the
    # agent has no live in-room (voice/media) presence yet. dispatch_agent also
    # writes room metadata, so even an auto-accept worker gets brigade_agent_id.
    skip_reason: str | None = None
    if not body.dispatch:
        skip_reason = "dispatch_not_requested"
    else:
        # Idempotency guard, per AGENT (not per room).
        #
        # This used to skip the dispatch when ANY `agent-` participant was in
        # the room, because every brigade worker joined under the one identity
        # "agent-brigade" and LiveKit's duplicate-identity handling made two
        # live jobs kill each other -- the room ended up agentless while the
        # human sat in the call. Workers now join as `agent-<brigade_agent_id>`
        # (agent_runtime/registry.py), so a DIFFERENT agent is no longer a
        # collision and must be allowed in. Only a second copy of THIS agent
        # is refused.
        wanted = {
            f"agent-{body.brigade_agent_id}",
            f"agent-brigade-{body.brigade_agent_id}",
        }
        # A worker from before per-agent identities is in the room as the bare
        # type-shaped "agent-brigade"/"agent-triage". Count that as "this
        # agent" only when this agent is the room's canonical resident --
        # otherwise one stale generic worker would block every other agent in
        # the roster from ever joining.
        if _meta_guard.get("brigade_agent_id") == body.brigade_agent_id:
            wanted |= {"agent-brigade", "agent-triage"}
        try:
            lk_state = await livekit.get_room(lk_name)
            for p in lk_state["participants"]:
                identity = getattr(p, "identity", "") or ""
                if identity in wanted:
                    skip_reason = f"agent_already_in_room:{identity}"
                    break
        except Exception:
            logger.warning(
                "agent_presence_check_failed", room=lk_name, exc_info=True
            )

    if skip_reason:
        logger.info(
            "agent_dispatch_skipped",
            room=lk_name,
            brigade_agent_id=body.brigade_agent_id,
            reason=skip_reason,
        )
        result: dict[str, Any] = {"dispatched": False, "reason": skip_reason}
    else:
        result = await livekit.dispatch_agent(
            room_name=lk_name,
            agent_name=settings.brigade_worker_agent_name,
            metadata={
                "agent_type": "brigade",
                "brigade_agent_id": body.brigade_agent_id,
                **({"model_override": body.model} if body.model else {}),
                "invited_by": user.get("sub") or user.get("preferred_username") or "",
            },
        )

    # Make the agent visible in the participant strip immediately by creating
    # the agent Participant + room membership now (instead of waiting for the
    # agent to post its first message).
    try:
        await _ensure_agent_member(db, lk_name, body.brigade_agent_id)
    except Exception:
        logger.warning("agent_member_create_failed", exc_info=True)

    # Persist the room's resident agent(s) so the text-only reply path
    # (services/agent_chat_responder.py) and the call UI can find them without
    # joining members. `brigade_agent_ids` is the SET (invite order);
    # `brigade_agent_id` stays written as the most-recently-invited canonical
    # responder, which is what every single-agent consumer already reads.
    try:
        # Use the room ALREADY resolved above (id | slug | LiveKit name), not a
        # second lookup on the raw path param. The old re-resolution matched
        # only `livekit_room_name == room_name` or a UUID, so an invite
        # addressed by SLUG — which the room-resolution block at the top of
        # this route accepts, and which the agents worker's summon_agent tool
        # and every curl/script caller use — found no row and the residency was
        # NEVER persisted. It failed silently: the dispatch succeeded, the
        # endpoint returned 200, and the room was left with no resident agent,
        # so the next call summoned nobody.
        room_row = _resolved_room
        if room_row is not None:
            meta = add_resident_agent(room_row.metadata_, body.brigade_agent_id)
            if body.model:
                meta["model_override"] = body.model
            else:
                meta.pop("model_override", None)
            room_row.metadata_ = meta
            await db.commit()
            logger.info(
                "room_resident_agents_persisted",
                room=lk_name,
                brigade_agent_ids=meta.get("brigade_agent_ids"),
                canonical=meta.get("brigade_agent_id"),
            )
    except Exception:
        logger.warning("room_metadata_brigade_id_set_failed", exc_info=True)

    return InviteAgentResponse(
        room_name=lk_name,
        brigade_agent_id=body.brigade_agent_id,
        dispatched=bool(result.get("dispatched")),
        dispatch_id=result.get("dispatch_id"),
        reason=result.get("reason"),
    )


@router.delete(
    "/rooms/{room_name}/brigade-agents/{brigade_agent_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_brigade_agent(
    room_name: str,
    brigade_agent_id: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> None:
    """Kick a Brigade agent from a room.

    1. Remove the agent's RoomMember row so they disappear from the strip.
    2. Tell LiveKit to evict the agent participant (if connected).
    """
    from sqlalchemy import delete as _delete, select as _select

    from app.models.participant import Participant as _P, ParticipantType as _PT
    from app.models.room import Room as _Room, RoomMember as _RM

    room = (
        await db.execute(_select(_Room).where(_Room.livekit_room_name == room_name))
    ).scalar_one_or_none()
    if room is None:
        try:
            import uuid as _u

            uid = _u.UUID(room_name)
            room = (
                await db.execute(_select(_Room).where(_Room.id == uid))
            ).scalar_one_or_none()
        except ValueError:
            room = None
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    # AUTHZ: caller must be a member of the room (was previously ungated — any
    # authenticated user could evict an agent from any room by id/name).
    _caller_member = (
        await db.execute(
            _select(_RM).where(
                _RM.room_id == room.id,
                _RM.participant_id == user["participant_id"],
            )
        )
    ).scalar_one_or_none()
    if _caller_member is None:
        raise HTTPException(
            status_code=403, detail="You must be a member of this room"
        )

    pseudo_sub = f"brigade:{brigade_agent_id}"
    agent_p = (
        await db.execute(
            _select(_P).where(
                _P.keycloak_sub == pseudo_sub,
                _P.participant_type == _PT.AGENT,
            )
        )
    ).scalar_one_or_none()
    if agent_p is not None:
        await db.execute(
            _delete(_RM).where(
                _RM.room_id == room.id,
                _RM.participant_id == agent_p.id,
            )
        )
        # A kick must also revoke the RESPONDER binding: the text responder
        # answers as metadata.brigade_agent_id, so leaving it pointing at the
        # evicted agent means the "kicked" agent keeps replying in the room.
        # Drops the agent from the SET and re-points the canonical scalar at
        # whoever is left, so a kick in a multi-agent room revokes exactly one
        # residency instead of all of them (and never leaves the responder
        # answering as the agent that was just evicted).
        room.metadata_ = remove_resident_agent(room.metadata_, brigade_agent_id)
        await db.commit()

    # Best-effort eviction from LiveKit. Identity is whatever the worker
    # registered with — we don't track it precisely, so we try a few patterns.
    try:
        for identity in (
            f"agent-{brigade_agent_id}",
            f"agent-brigade-{brigade_agent_id}",
        ):
            try:
                await livekit.remove_participant(
                    room_name=room.livekit_room_name,
                    identity=identity,
                )
            except Exception:
                pass
    except Exception:
        logger.debug("livekit_evict_failed", exc_info=True)
    return None
