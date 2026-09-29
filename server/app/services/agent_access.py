"""Per-user agent access control — resolution + enforcement.

WHAT IS GATED (human actions that ESTABLISH access to an agent):
  * agent-DM creation and any agent bind into a room
    (``POST /rooms/{room}/invite-brigade-agent`` — the one funnel the web
    client uses for "New chat", the in-room agent picker, AND the call-time
    voice dispatch);
  * inviting an agent-typed Participant through the generic member-invite
    route (``POST /rooms/{room_id}/invite``).

WHAT IS DELIBERATELY NOT GATED:
  * the agents WORKER runtime. The worker authenticates to the same public
    routes as a Keycloak service account whose identity extraction yields
    ``participant_type == "agent"`` (see auth/keycloak.extract_user_identity);
    ``ensure_agent_access`` passes every non-human principal through untouched.
    The ``/api/v1/internal/*`` surface (internal bearer) and ``api/gateway.py``
    (gateway credentials) never call into this module at all.
  * sending a message into a room whose resident agent the caller is not
    entitled to. Others in the room may be entitled; the gate is on
    establishing agent access, not on talking in a room.
  * removing/kicking an agent — revoking a binding is not acquiring one.

Resolution order for a (human participant, agent) pair:
  1. a grant row (``agent_access_grants``) wins in both directions:
     effect=allow → allowed, effect=deny → denied;
  2. otherwise the instance default (``Settings.agent_access_default``,
     env AGENT_ACCESS_DEFAULT): "open" → allowed, "closed" → denied.

Every denial emits a structured ``agent_access_denied`` audit log.

Instance-admin determination (for the grants API) reuses the mechanism
``api/instance_meta.py`` established: the caller's Keycloak realm roles
(``user["roles"]``) intersected with the STABLE_ADMIN_ROLES env allowlist
(default ``stable-admin,realm-admin,admin``).
"""

from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from typing import Any, Iterable

import structlog
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.agent_access import AgentAccessEffect, AgentAccessGrant
from app.services.room_class import norm_username

logger = structlog.get_logger(__name__)

# Pseudo-sub prefix agent Participants carry (``brigade:<agent_id>``) — the
# bridge between a Participant row and the Brigade string id grants key on.
_BRIGADE_SUB_PREFIX = "brigade:"


def agent_id_for_participant(keycloak_sub: str | None) -> str:
    """The grant-table key for an agent-typed Participant.

    Brigade agents (``brigade:perry`` → ``perry``) are the normal case. Any
    other agent-typed principal (e.g. a ``webhook:*`` bot) keys on its full
    pseudo-sub, so it can still be granted/denied explicitly and is subject to
    the same closed-mode default as everything else.
    """
    sub = (keycloak_sub or "").strip()
    if sub.startswith(_BRIGADE_SUB_PREFIX):
        return sub[len(_BRIGADE_SUB_PREFIX):]
    return sub


# Per-participant wildcard grant row: matches any agent id without an exact
# row. Exact rows always win, so the "guest posture" is one ``deny *`` row
# plus per-agent ``allow`` rows to selectively re-open agents later.
WILDCARD_AGENT_ID = "*"


def _default_is_open() -> bool:
    return get_settings().agent_access_default != "closed"


async def owned_seat_owners(db: AsyncSession, agent_id: str) -> frozenset[str]:
    """The usernames that own runner seat ``agent_id`` (``metadata.owner`` on
    its ``brigade:<id>`` participant), or an empty set when the agent is not
    a runner seat, has no row, or carries no owner."""
    from app.models.participant import Participant
    from app.services.agent_routing import participant_backend
    from app.services.room_class import seat_owners

    meta = (
        await db.execute(
            select(Participant.metadata_).where(
                Participant.keycloak_sub == f"{_BRIGADE_SUB_PREFIX}{agent_id}"
            )
        )
    ).scalar_one_or_none()
    holder = SimpleNamespace(metadata_=meta)
    if participant_backend(holder) != "runner":
        return frozenset()
    return seat_owners(holder)


async def owned_seats_closed_to(
    db: AsyncSession, *, username: str | None, agent_ids: Iterable[str]
) -> set[str]:
    """Of ``agent_ids``, the owned runner seats ``username`` does not own —
    the roster marks them un-entitled so the picker renders them locked."""
    from app.models.participant import Participant
    from app.services.agent_routing import participant_backend
    from app.services.room_class import agent_id_of_sub, seat_owners

    ids = [a for a in agent_ids if a]
    if not ids:
        return set()
    rows = (
        await db.execute(
            select(Participant.keycloak_sub, Participant.metadata_).where(
                Participant.keycloak_sub.in_([f"{_BRIGADE_SUB_PREFIX}{a}" for a in ids])
            )
        )
    ).all()
    me = norm_username(username)
    closed: set[str] = set()
    for sub, meta in rows:
        holder = SimpleNamespace(metadata_=meta)
        if participant_backend(holder) != "runner":
            continue
        owners = seat_owners(holder)
        if owners and me not in owners:
            agent_id = agent_id_of_sub(sub)
            if agent_id:
                closed.add(agent_id)
    return closed


async def resolve_agent_access(
    db: AsyncSession,
    *,
    participant_id: uuid.UUID | str,
    agent_id: str,
) -> tuple[bool, str]:
    """Return ``(allowed, reason)`` for one (participant, agent) pair.

    ``reason`` ∈ {"grant_allow", "grant_deny", "wildcard_allow",
    "wildcard_deny", "default_open", "default_closed"} — carried into the
    audit log so a denial names the rule that produced it. An exact
    (participant, agent) row always beats the participant's ``*`` row.
    """
    grant = (
        await db.execute(
            select(AgentAccessGrant).where(
                AgentAccessGrant.participant_id == participant_id,
                AgentAccessGrant.agent_id == agent_id,
            )
        )
    ).scalar_one_or_none()
    if grant is not None:
        if grant.effect == AgentAccessEffect.ALLOW:
            return True, "grant_allow"
        return False, "grant_deny"
    # No exact row → an explicit per-participant wildcard decides before the
    # instance default (the guest posture: one ``deny *`` row keeps every
    # FUTURE agent closed for that participant too, which enumerated exact
    # rows cannot).
    wildcard = (
        await db.execute(
            select(AgentAccessGrant).where(
                AgentAccessGrant.participant_id == participant_id,
                AgentAccessGrant.agent_id == WILDCARD_AGENT_ID,
            )
        )
    ).scalar_one_or_none()
    if wildcard is not None:
        if wildcard.effect == AgentAccessEffect.ALLOW:
            return True, "wildcard_allow"
        return False, "wildcard_deny"
    if _default_is_open():
        return True, "default_open"
    return False, "default_closed"


async def ensure_agent_access(
    db: AsyncSession,
    user: dict[str, Any],
    agent_id: str,
    *,
    surface: str,
) -> None:
    """Raise 403 unless the HUMAN caller is entitled to ``agent_id``.

    Non-human principals (the agents worker's Keycloak service account —
    ``participant_type == "agent"``) pass unconditionally: entitlements gate
    human actions, never the worker's own operations. ``surface`` names the
    enforcement point for the audit log ("agent_invite", "room_member_invite").
    """
    if user.get("participant_type") == "agent":
        return
    # Nav v3 R5: only a seat's OWNER may add that seat anywhere. An owned
    # runner seat (participants.metadata.owner) is closed to everyone else
    # whatever the grants or the instance default say — a membership someone
    # else minted for Aaron's seat would otherwise become a watched line into
    # his runner. Brigade agents and unowned seats are untouched.
    owners = await owned_seat_owners(db, agent_id)
    if owners and norm_username(user.get("username")) not in owners:
        logger.warning(
            "agent_access_denied",
            participant_id=str(user.get("participant_id")),
            username=user.get("username"),
            agent_id=agent_id,
            surface=surface,
            reason="seat_owner_only",
            mode=get_settings().agent_access_default,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"'{agent_id}' is someone's own seat — ask the seat's owner "
                "to add it."
            ),
        )
    allowed, reason = await resolve_agent_access(
        db, participant_id=user["participant_id"], agent_id=agent_id
    )
    if allowed:
        return
    logger.warning(
        "agent_access_denied",
        participant_id=str(user.get("participant_id")),
        username=user.get("username"),
        agent_id=agent_id,
        surface=surface,
        reason=reason,
        mode=get_settings().agent_access_default,
    )
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            f"You don't have access to the agent '{agent_id}'. "
            "Ask an admin to grant it."
        ),
    )


async def entitled_agent_ids(
    db: AsyncSession,
    *,
    participant_id: uuid.UUID | str,
    agent_ids: Iterable[str],
    username: str | None = None,
) -> set[str]:
    """The subset of ``agent_ids`` this participant may reach (one query,
    plus one for owned seats when ``username`` is given — R5).

    Used by the roster endpoints to annotate each agent ``entitled`` without a
    per-agent round trip.
    """
    ids = [a for a in agent_ids if a]
    if not ids:
        return set()
    closed = await owned_seats_closed_to(db, username=username, agent_ids=ids) if username else set()
    ids = [a for a in ids if a not in closed]
    if not ids:
        return set()
    grants = (
        (
            await db.execute(
                select(AgentAccessGrant).where(
                    AgentAccessGrant.participant_id == participant_id,
                    AgentAccessGrant.agent_id.in_([*ids, WILDCARD_AGENT_ID]),
                )
            )
        )
        .scalars()
        .all()
    )
    by_agent = {g.agent_id: g.effect for g in grants}
    wildcard_effect = by_agent.pop(WILDCARD_AGENT_ID, None)
    open_default = _default_is_open()
    entitled: set[str] = set()
    for aid in ids:
        effect = by_agent.get(aid)
        if effect is None:
            effect = wildcard_effect
        if effect is None:
            if open_default:
                entitled.add(aid)
        elif effect == AgentAccessEffect.ALLOW:
            entitled.add(aid)
    return entitled


# ---------------------------------------------------------------------------
# Instance-admin gate (grants API)
# ---------------------------------------------------------------------------


def _admin_roles() -> set[str]:
    # Same env contract as api/instance_meta.py — one knob, one admin concept.
    raw = os.environ.get("STABLE_ADMIN_ROLES", "stable-admin,realm-admin,admin")
    return {r.strip() for r in raw.split(",") if r.strip()}


def is_instance_admin(user: dict[str, Any]) -> bool:
    roles = {str(r) for r in (user.get("roles") or [])}
    return bool(roles & _admin_roles())


def require_instance_admin(user: dict[str, Any]) -> None:
    if not is_instance_admin(user):
        # 403, not 404: the caller is authenticated, they simply aren't an admin.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an instance admin can manage agent access grants.",
        )
