"""Honest agent-activity signalling for the chat UI.

Two DIFFERENT states, deliberately kept distinct because they are backed by
different evidence:

``agent_typing``
    A Brigade-backed resident agent is actually generating a reply. Emitted by
    :mod:`app.services.agent_chat_responder` around the real Brigade call, so it
    is true liveness, not an assumption.

``agent_relay``
    A gateway/bridge agent (``app.api.gateway``) has NO thinking signal — it is
    an external process that polls. Inventing "thinking" for it would be a lie,
    so we assert only what we can observe: a human message is sitting in the
    room UNCOLLECTED by that bridge. It clears the moment the bridge reads or
    posts, and expires on its own if the bridge never shows up.

Both are published to the Redis ``room:{id}`` channel — the SAME transport the
web-client WebSocket plane subscribes to in :mod:`app.ws.handler`. This is the
fix for the original bug: the responder emitted typing over LiveKit data only,
while the browser listened on the WebSocket, so the two ends never met and the
UI fell back to a purely optimistic local flag that lied for up to 150s.

EVERY state set here has a clearing path: an explicit "off" publish on the
normal path, an "off" publish from the responder's ``finally`` (so errors and
stops clear too), and a Redis TTL as the last-resort backstop. The client
additionally expires its own copy. A status that can get stuck on is exactly
the bug this module exists to remove.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import structlog

logger = structlog.get_logger()

_pub_redis: Any = None

# Backstop lifetime for an outstanding-relay marker. A bridge agent that never
# collects the message must not leave the room asserting "waiting" forever.
RELAY_TTL_SECONDS = 300

# How long a gateway call keeps its agent counting as a CURRENTLY-CONNECTED
# bridge. Generous relative to real bridge poll intervals (MCP wait_for_reply /
# send_and_wait poll every 1-2s), so a live bridge always stays inside the
# window, while a bridge that has been down for a quarter of an hour stops
# being described as "about to relay".
GATEWAY_SEEN_TTL_SECONDS = 900


def _relay_key(room_id: uuid.UUID | str, agent_id: str) -> str:
    return f"stable:relaypending:{room_id}:{agent_id}"


def _seen_key(agent_id: str) -> str:
    return f"stable:gwseen:{agent_id}"


def _get_pub_redis() -> Any:
    """Lazy publisher client.

    stable-backend runs ``uvicorn --workers 4``; a client's WebSocket lives on
    ONE worker while the responder / gateway request runs on another, so Redis
    pub/sub is the only delivery that reaches the browser regardless of which
    worker holds the socket.
    """
    global _pub_redis
    if _pub_redis is None:
        from redis.asyncio import Redis

        from app.config import get_settings

        _pub_redis = Redis.from_url(get_settings().redis_url, decode_responses=False)
    return _pub_redis


async def _publish(room_id: uuid.UUID | str, envelope: dict[str, Any]) -> None:
    """Best-effort fan-out. A signalling failure must never break a reply."""
    try:
        await _get_pub_redis().publish(f"room:{room_id}", json.dumps(envelope))
    except Exception:
        logger.debug("agent_status_publish_failed", exc_info=True)


async def publish_agent_typing(
    *,
    room_id: uuid.UUID | str,
    brigade_agent_id: str,
    typing: bool,
    agent_label: str | None = None,
    participant_id: uuid.UUID | str | None = None,
) -> None:
    """Republish a genuine agent typing/working transition to the ws plane.

    ``agent_label`` and ``participant_id`` are carried in the payload so the UI
    can NAME the agent that is actually working (and colour it with that
    agent's identity hue) instead of guessing from room membership. Both are
    optional: an older caller that omits them still produces a correct — if
    less specific — indicator.
    """
    await _publish(
        room_id,
        {
            "type": "agent_typing",
            "room_id": str(room_id),
            "brigade_agent_id": brigade_agent_id,
            "typing": bool(typing),
            "agent_label": agent_label,
            "participant_id": str(participant_id) if participant_id else None,
        },
    )


async def mark_relay_pending(
    *,
    room_id: uuid.UUID | str,
    agent_id: str,
    agent_label: str | None = None,
    participant_id: uuid.UUID | str | None = None,
) -> None:
    """Assert that a bridge agent has an uncollected message in this room."""
    try:
        await _get_pub_redis().set(
            _relay_key(room_id, agent_id), b"1", ex=RELAY_TTL_SECONDS
        )
    except Exception:
        logger.debug("relay_pending_set_failed", exc_info=True)
    await _publish(
        room_id,
        {
            "type": "agent_relay",
            "room_id": str(room_id),
            "agent_id": agent_id,
            "pending": True,
            "agent_label": agent_label,
            "participant_id": str(participant_id) if participant_id else None,
            "ttl_seconds": RELAY_TTL_SECONDS,
        },
    )


async def touch_gateway_agent(agent_id: str) -> None:
    """Record that a bridge for ``agent_id`` just talked to the gateway.

    This is what makes the "bridge agent" predicate mean something. Possession
    of an un-revoked :class:`AgentGatewayKey` is a SETUP fact that never
    expires — a key minted once and forgotten would otherwise mark its agent as
    a live bridge forever. A recent gateway call is evidence that a process is
    actually running right now, which is the thing the indicator claims.
    """
    try:
        await _get_pub_redis().set(
            _seen_key(agent_id), b"1", ex=GATEWAY_SEEN_TTL_SECONDS
        )
    except Exception:
        logger.debug("gateway_seen_touch_failed", exc_info=True)


async def clear_relay_pending(
    *, room_id: uuid.UUID | str, agent_id: str
) -> None:
    """Retract the outstanding-relay marker — the bridge read or posted.

    Publishes ONLY on a real state transition, i.e. when the DELETE actually
    removed a key. Gateway reads are a polling loop (there is no long-poll
    endpoint; the MCP ``wait_for_reply``/``send_and_wait`` helpers spin at
    1-2s), and this runs on every read, so an unconditional publish would emit
    a pub/sub event per poll that ``ws/handler`` then fans out to every browser
    in the room. The redundant "already clear" publishes bought nothing: the
    only case they covered was a marker whose Redis key had already expired,
    and the client expires its own copy off the same TTL anyway.
    """
    removed = 0
    try:
        removed = int(await _get_pub_redis().delete(_relay_key(room_id, agent_id)) or 0)
    except Exception:
        logger.debug("relay_pending_clear_failed", exc_info=True)
        return
    if not removed:
        return
    await _publish(
        room_id,
        {
            "type": "agent_relay",
            "room_id": str(room_id),
            "agent_id": agent_id,
            "pending": False,
        },
    )


async def mark_relay_pending_for_room(
    *,
    db: Any,
    room_id: uuid.UUID,
    exclude_agent_ids: set[str] | None = None,
) -> None:
    """Mark every CURRENTLY-CONNECTED bridge agent in ``room_id`` as having an
    uncollected message.

    Three conditions must ALL hold before we say anything about an agent, and
    each one is load-bearing:

    1. It is an agent participant of the room with a ``brigade:<id>`` identity.
    2. It holds an un-revoked :class:`AgentGatewayKey` **whose allowed_rooms
       covers THIS room** (``["*"]``, the livekit room name, or the room name),
       matching :func:`app.api.gateway._enforce_scope`. A key scoped to room A
       says nothing about room B, and must not mark the agent there.
    3. A bridge for that agent has actually called the gateway within
       ``GATEWAY_SEEN_TTL_SECONDS``. Key existence alone is a setup fact that
       never expires; a key minted once and forgotten would otherwise assert
       "waiting for relay" in every room, on every message, forever — exactly
       the permanently-on, indistinguishable-from-hung indicator this change
       exists to eliminate. Recent USE is the closest thing to liveness the
       gateway's polling protocol gives us, and we claim no more than that.

    Agents in ``exclude_agent_ids`` — the resolved Brigade responder for this
    message, which emits a REAL typing signal — are skipped so one agent never
    shows two contradictory states at once.

    Callers that authenticate to the gateway with a uchub JWT rather than a
    minted key have no key row and so are not marked. That is deliberate: the
    failure mode is an absent indicator, never a false one.
    """
    from sqlalchemy import select

    from app.models.agent_gateway_key import AgentGatewayKey
    from app.models.participant import Participant, ParticipantType
    from app.models.room import Room, RoomMember

    excluded = set(exclude_agent_ids or set())
    try:
        room = (
            await db.execute(select(Room).where(Room.id == room_id))
        ).scalar_one_or_none()
        if room is None:
            return
        # Belt-and-braces exclusion of the room's declared Brigade resident.
        # This is NOT sufficient on its own — `_resolve_agent` also routes by
        # @-mention in multi-agent rooms and by a no-metadata legacy fallback,
        # so the actual responder is passed in via `exclude_agent_ids` — but in
        # the common metadata-routed room it costs nothing and holds even if a
        # caller forgets.
        if isinstance(room.metadata_, dict):
            resident = room.metadata_.get("brigade_agent_id")
            if isinstance(resident, str) and resident:
                excluded.add(resident)

        agents = (
            await db.execute(
                select(Participant)
                .join(RoomMember, RoomMember.participant_id == Participant.id)
                .where(
                    RoomMember.room_id == room_id,
                    Participant.participant_type == ParticipantType.AGENT,
                )
            )
        ).scalars().all()
        if not agents:
            return

        by_agent_id: dict[str, Participant] = {}
        for p in agents:
            sub = p.keycloak_sub or ""
            if not sub.startswith("brigade:"):
                continue
            agent_id = sub.split(":", 1)[1]
            if agent_id and agent_id not in excluded:
                by_agent_id[agent_id] = p
        if not by_agent_id:
            return

        rows = (
            await db.execute(
                select(AgentGatewayKey.agent_id, AgentGatewayKey.allowed_rooms).where(
                    AgentGatewayKey.agent_id.in_(list(by_agent_id)),
                    AgentGatewayKey.revoked_at.is_(None),
                )
            )
        ).all()

        # Same scoping rule the gateway itself enforces on every request
        # (app/api/gateway.py::_enforce_scope): a key that cannot be used
        # against this room is not evidence of a bridge for this room.
        scoped: set[str] = set()
        for agent_id, allowed_rooms in rows:
            allowed = allowed_rooms if isinstance(allowed_rooms, list) else []
            if "*" in allowed or room.livekit_room_name in allowed or room.name in allowed:
                scoped.add(agent_id)
        if not scoped:
            return

        # Liveness gate: only agents whose bridge has actually hit the gateway
        # recently. Without this the predicate is "a key was minted once",
        # which would light the indicator in rooms whose bridge is long dead.
        ordered = sorted(scoped)
        try:
            seen = await _get_pub_redis().mget([_seen_key(a) for a in ordered])
        except Exception:
            logger.debug("gateway_seen_lookup_failed", exc_info=True)
            return
        connected = {a for a, v in zip(ordered, seen) if v is not None}

        for agent_id in connected:
            p = by_agent_id[agent_id]
            await mark_relay_pending(
                room_id=room_id,
                agent_id=agent_id,
                agent_label=p.display_name,
                participant_id=p.id,
            )
    except Exception:
        logger.debug("relay_pending_room_scan_failed", exc_info=True)


__all__ = [
    "GATEWAY_SEEN_TTL_SECONDS",
    "RELAY_TTL_SECONDS",
    "clear_relay_pending",
    "mark_relay_pending",
    "touch_gateway_agent",
    "mark_relay_pending_for_room",
    "publish_agent_typing",
]
