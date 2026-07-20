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


def _relay_key(room_id: uuid.UUID | str, agent_id: str) -> str:
    return f"stable:relaypending:{room_id}:{agent_id}"


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


async def clear_relay_pending(
    *, room_id: uuid.UUID | str, agent_id: str
) -> None:
    """Retract the outstanding-relay marker — the bridge read or posted.

    Publishes unconditionally (not only when the Redis key existed): a clear is
    always safe, and publishing regardless means a marker set on another worker
    whose key already expired still gets retracted on the client.
    """
    try:
        await _get_pub_redis().delete(_relay_key(room_id, agent_id))
    except Exception:
        logger.debug("relay_pending_clear_failed", exc_info=True)
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
    """Mark every BRIDGE agent in ``room_id`` as having an uncollected message.

    A bridge agent is an agent participant of the room whose derived
    ``brigade:<agent_id>`` identity has a live (un-revoked) gateway key — i.e.
    something outside Stable really does relay for it. Agents in
    ``exclude_agent_ids`` (normally the room's Brigade resident, which emits a
    REAL typing signal) are skipped so a single agent never shows two
    contradictory states at once.

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
        # Always exclude the room's Brigade resident even if the caller did not
        # name it: that agent emits a real typing signal, and showing it as
        # "waiting on a relay" at the same time would contradict the truth.
        room = (
            await db.execute(select(Room).where(Room.id == room_id))
        ).scalar_one_or_none()
        if room is not None and isinstance(room.metadata_, dict):
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

        live = (
            await db.execute(
                select(AgentGatewayKey.agent_id).where(
                    AgentGatewayKey.agent_id.in_(list(by_agent_id)),
                    AgentGatewayKey.revoked_at.is_(None),
                )
            )
        ).scalars().all()

        for agent_id in set(live):
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
    "RELAY_TTL_SECONDS",
    "clear_relay_pending",
    "mark_relay_pending",
    "mark_relay_pending_for_room",
    "publish_agent_typing",
]
