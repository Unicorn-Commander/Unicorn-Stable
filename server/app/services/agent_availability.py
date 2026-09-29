"""Agent AVAILABILITY — deliberately not the same fact as human presence.

Human presence answers "is this person's client connected right now": a
WebSocket is open (``ws/handler``) or they joined a LiveKit call
(``webhooks``), so a Redis ``presence:{participant_id}`` key exists. That model
does not describe an agent at all. Almost every Brigade agent is invoked on
demand — ``agent_chat_responder`` calls Brigade when a message arrives and the
process exits again — so an agent holds no socket and would read "offline"
forever under the human model. That is exactly as false as the old
``participants.status`` column that reported every agent online forever.

What actually matters for an agent is whether it can be REACHED right now, and
there are two genuinely different ways that can be true:

1. **Brigade-resident agents** — reachable because Brigade has them registered
   and enabled. The evidence is Brigade's own roster: if Brigade answers and
   lists the agent as active, a message sent now will be routed to a live
   model. If Brigade lists it as inactive/disabled/offline, it will not.
2. **Bridge / gateway agents** — external Claude Codes posting through
   ``/api/v1/gateway``. They are reachable only while their operator's session
   is polling; there is no long-poll endpoint, so a bridge that has stopped
   calling is simply gone. The evidence is a recent authenticated gateway call
   (``stable:gwfresh:{agent_id}``, refreshed on every gateway request).

Anything we cannot observe is reported as ``unknown``, never as available.
Brigade being unreachable, or not configured at all, is an unknown — not a
licence to assume either answer. The UI collapses ``unavailable`` and
``unknown`` into one un-lit state and puts the reason in the tooltip, so the
only thing that ever lights up is something we positively observed.

NOTE FOR THE MERGE with ``fix/honest-agent-status-20260720``: that branch
maintains ``stable:gwseen:{agent_id}`` (TTL 900s) for a different question —
"is this bridge live enough that an undelivered message will still be
collected". Same kind of signal, coarser window, deliberately a separate key
here: 15 minutes is a fine backstop for an outstanding relay and far too stale
to call an agent "available right now". The two can be unified later; they must
not share a key, because they need different freshness.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
import structlog

logger = structlog.get_logger(__name__)

# Wire values for the availability field.
AVAILABLE = "available"
UNAVAILABLE = "unavailable"
UNKNOWN = "unknown"

# How long an authenticated gateway call keeps its agent counting as reachable.
# The MCP bridge helpers (``wait_for_reply`` / ``send_and_wait``) poll every
# 1-2s, so a running bridge refreshes this constantly and 3 minutes is a large
# margin; a bridge whose operator closed the session stops being described as
# available well inside the time a human would notice.
GATEWAY_FRESH_TTL_SECONDS = 180

# The Brigade roster is the same answer for every room and every caller, and
# ``/members`` is polled per open room per user, so it is cached. Short enough
# that disabling an agent in Brigade shows up promptly; long enough that a busy
# server does not hammer Brigade. Failures are cached too (briefly), so a
# Brigade outage costs one upstream attempt per ``_ROSTER_FAIL_CACHE_TTL``
# rather than one per members poll.
_ROSTER_CACHE_KEY = "stable:brigade:roster_status"
_ROSTER_CACHE_TTL = 30
_ROSTER_FAIL_CACHE_TTL = 10

_BRIGADE_TIMEOUT = httpx.Timeout(5.0, connect=3.0)

# Brigade statuses that mean "registered but not currently enabled". Mirrors the
# mapping in api/brigade.py::_fetch_brigade_roster.
_INACTIVE_BRIGADE_STATUSES = frozenset({"offline", "inactive", "disabled"})


def gateway_fresh_key(agent_id: str) -> str:
    return f"stable:gwfresh:{agent_id}"


#: How long the "last touch" timestamp outlives the freshness marker.
GATEWAY_LAST_SEEN_TTL_SECONDS = 30 * 24 * 3600


def gateway_last_seen_key(agent_id: str) -> str:
    return f"stable:gwlast:{agent_id}"


async def get_gateway_last_seen(redis: Any, agent_ids: list[str]) -> dict[str, "datetime"]:
    """``{agent_id: last authenticated gateway call}`` for the ids that have
    one on record (30-day memory). Unreadable → empty, never a guess."""
    from datetime import datetime, timezone

    if not agent_ids:
        return {}
    try:
        values = await redis.mget([gateway_last_seen_key(a) for a in agent_ids])
    except Exception:
        logger.debug("gateway_last_seen_read_failed", exc_info=True)
        return {}
    out: dict[str, datetime] = {}
    for agent_id, value in zip(agent_ids, values):
        if value is None:
            continue
        try:
            raw = value.decode("utf-8") if isinstance(value, bytes) else str(value)
            out[agent_id] = datetime.fromtimestamp(int(raw), tz=timezone.utc)
        except (TypeError, ValueError):
            continue
    return out


async def touch_gateway_agent(redis: Any, agent_id: str) -> None:
    """Record that a bridge for ``agent_id`` just made an authenticated
    gateway call — i.e. a process for it is running right now.

    Called from the gateway's auth dependency, so it covers both reads and
    posts without either endpoint having to remember. Holding an
    ``AgentGatewayKey`` proves nothing here: that row has no ``expires_at``, so
    a key minted once and forgotten would mark its agent reachable forever,
    which is the permanently-lit dot this whole change exists to remove. Recent
    USE is the strongest liveness a polling protocol can offer, and it is all
    we claim.

    Best-effort: a Redis failure must never fail a gateway request. The cost of
    a missed touch is a bridge that reads unavailable for up to
    ``GATEWAY_FRESH_TTL_SECONDS`` — an under-claim, which is the right way to
    be wrong.
    """
    try:
        now = int(time.time())
        await redis.set(
            gateway_fresh_key(agent_id),
            str(now),
            ex=GATEWAY_FRESH_TTL_SECONDS,
        )
        # The freshness marker expires with its TTL; the crew's "last seen"
        # wants the last touch long after that. Kept beside it, 30 days.
        await redis.set(gateway_last_seen_key(agent_id), str(now), ex=GATEWAY_LAST_SEEN_TTL_SECONDS)
    except Exception:
        logger.debug("gateway_fresh_touch_failed", agent_id=agent_id, exc_info=True)


async def _fetch_roster_status() -> dict[str, str] | None:
    """Ask Brigade which agents it has, and which of those are enabled.

    Returns ``{agent_id: brigade_status}``, or ``None`` when we could not get an
    answer (Brigade not configured, unreachable, or malformed). ``None`` means
    UNKNOWN and is never collapsed into "no agents are available" — those are
    different claims and only one of them is true.

    Deliberately does NOT reuse ``api.brigade._fetch_brigade_roster``: that
    raises HTTPException on upstream failure, which is correct for a roster
    endpoint the user asked for and very wrong here, where a Brigade blip would
    turn every ``GET /rooms/{id}/members`` into a 502 and take the room roster
    down with it.
    """
    from app.config import get_settings

    settings = get_settings()
    if not settings.brigade_api_key:
        return None

    base = settings.brigade_base_url.rstrip("/")
    # Brigade's native API base — strip the OpenAI-compat tail if present
    # (same derivation as api/brigade.py::_brigade_native_base).
    if base.endswith("/openai/v1"):
        base = base[: -len("/openai/v1")]

    try:
        async with httpx.AsyncClient(timeout=_BRIGADE_TIMEOUT) as client:
            resp = await client.get(
                base + "/agents",
                headers={"Authorization": f"Bearer {settings.brigade_api_key}"},
            )
            resp.raise_for_status()
            body = resp.json()
    except Exception as e:
        logger.info("brigade_roster_status_fetch_failed", error=str(e))
        return None

    items = body.get("agents", []) if isinstance(body, dict) else (body or [])
    if not isinstance(items, list):
        return None

    out: dict[str, str] = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        agent_id = it.get("id")
        if not agent_id:
            continue
        out[str(agent_id)] = str(it.get("status") or "active").lower()
    return out


async def _load_roster_status(redis: Any) -> dict[str, str] | None:
    """Cached :func:`_fetch_roster_status`. ``None`` == unknown."""
    try:
        cached = await redis.get(_ROSTER_CACHE_KEY)
    except Exception:
        cached = None
    if cached is not None:
        try:
            raw = cached.decode("utf-8") if isinstance(cached, bytes) else str(cached)
            payload = json.loads(raw)
            if payload.get("ok"):
                status = payload.get("status")
                if isinstance(status, dict):
                    return {str(k): str(v) for k, v in status.items()}
            # A cached failure. Honour it rather than retrying per poll.
            return None
        except Exception:
            logger.debug("brigade_roster_cache_unreadable", exc_info=True)

    # Belt and braces: _fetch_roster_status already swallows its own upstream
    # errors, but this is called from GET /rooms/{id}/members and NOTHING here
    # is allowed to turn a room roster into a 500. An unknown availability is a
    # dimmed dot; an exception is a broken member list.
    try:
        status = await _fetch_roster_status()
    except Exception:
        logger.warning("brigade_roster_status_unexpected_error", exc_info=True)
        status = None

    try:
        if status is None:
            await redis.set(
                _ROSTER_CACHE_KEY,
                json.dumps({"ok": False}),
                ex=_ROSTER_FAIL_CACHE_TTL,
            )
        else:
            await redis.set(
                _ROSTER_CACHE_KEY,
                json.dumps({"ok": True, "status": status}),
                ex=_ROSTER_CACHE_TTL,
            )
    except Exception:
        logger.debug("brigade_roster_cache_write_failed", exc_info=True)
    return status


async def get_gateway_fresh(redis: Any, agent_ids: list[str]) -> set[str]:
    """The subset of ``agent_ids`` whose bridge called the gateway recently."""
    if not agent_ids:
        return set()
    try:
        values = await redis.mget([gateway_fresh_key(a) for a in agent_ids])
    except Exception:
        # An unreadable marker is a check we failed to make, not evidence that
        # no bridge is live. Callers fall through to the roster, where an agent
        # we know nothing about lands on UNKNOWN rather than UNAVAILABLE.
        logger.debug("gateway_fresh_read_failed", exc_info=True)
        return set()
    return {a for a, v in zip(agent_ids, values) if v is not None}


def classify(
    *,
    gateway_fresh: bool,
    roster_known: bool,
    brigade_status: str | None,
) -> tuple[str, str]:
    """The single truth table for agent availability.

    ``roster_known`` is whether we managed to ask Brigade at all;
    ``brigade_status`` is Brigade's own status string for this agent, or None
    if Brigade does not know it. Both callers (the room roster and the
    ``/brigade/roster`` endpoint) go through here so they cannot drift.

    A fresh gateway call is checked FIRST and wins outright: a bridge agent is
    typically not a Brigade persona at all — its brain is an external Claude
    Code — so consulting the roster first would report a demonstrably-live
    bridge as unavailable.
    """
    if gateway_fresh:
        return (AVAILABLE, "bridge_session_active")
    if not roster_known:
        return (UNKNOWN, "brigade_unreachable")
    if brigade_status is None:
        # Not a Brigade persona and no live bridge. We have no route to it and
        # no evidence about it, so we say exactly that rather than guessing.
        return (UNKNOWN, "not_in_brigade_roster")
    if brigade_status in _INACTIVE_BRIGADE_STATUSES:
        return (UNAVAILABLE, "brigade_disabled")
    return (AVAILABLE, "brigade_registered")


async def get_agent_availability(
    redis: Any, brigade_agent_ids: set[str]
) -> dict[str, tuple[str, str]]:
    """Resolve availability for a set of Brigade agent ids.

    Returns ``{agent_id: (state, reason)}``. ``reason`` is a short
    machine-readable tag the client turns into a tooltip, so an un-lit agent
    can always say WHY rather than looking broken.
    """
    if not brigade_agent_ids:
        return {}

    ids = sorted(brigade_agent_ids)
    fresh = await get_gateway_fresh(redis, ids)
    roster = await _load_roster_status(redis)

    return {
        agent_id: classify(
            gateway_fresh=agent_id in fresh,
            roster_known=roster is not None,
            brigade_status=(roster or {}).get(agent_id),
        )
        for agent_id in ids
    }


__all__ = [
    "AVAILABLE",
    "UNAVAILABLE",
    "UNKNOWN",
    "GATEWAY_FRESH_TTL_SECONDS",
    "gateway_fresh_key",
    "touch_gateway_agent",
    "get_gateway_fresh",
    "classify",
    "get_agent_availability",
]
