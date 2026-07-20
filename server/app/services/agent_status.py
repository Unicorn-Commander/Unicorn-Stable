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
from collections.abc import Iterable
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


def _room_in_allowed(allowed_rooms: Any, room: Any) -> bool:
    """Exactly the room-scoping rule the gateway enforces on every request.

    Mirrors :func:`app.api.gateway._enforce_scope`: a key is usable against a
    room when its allowlist holds ``*``, the LiveKit room name, or the room
    name. A key scoped to room A is not evidence of a bridge in room B, so this
    is what stops one room's setup from describing another room's agents.
    """
    allowed = allowed_rooms if isinstance(allowed_rooms, list) else []
    return bool(
        "*" in allowed or room.livekit_room_name in allowed or room.name in allowed
    )


async def scoped_bridge_agents(
    *, db: Any, room: Any, agent_ids: Iterable[str]
) -> set[str]:
    """Of ``agent_ids``, those whose identity is OWNED BY a gateway bridge in
    ``room`` — an un-revoked :class:`AgentGatewayKey` scoped to this room.

    This is a structural fact, and deliberately so: minting a room-scoped key
    for an agent id is what hands that identity to an external process. It has
    no Brigade persona behind it, so the in-process responder can never
    legitimately speak — or claim to be thinking — as that agent HERE,
    whether or not the process happens to be running this minute.

    Scope is enforced with the gateway's own rule (:func:`_room_in_allowed`),
    because a key minted for room A says nothing about room B and must not
    describe that agent there.

    Note what this does NOT establish: liveness. ``agent_gateway_keys`` has no
    ``expires_at``, only ``revoked_at``, so key possession is a SETUP fact
    that stays true forever. Anything asserting that something is happening
    right now — i.e. the relay marker — must additionally pass
    :func:`connected_bridge_agents`.
    """
    from sqlalchemy import select

    from app.models.agent_gateway_key import AgentGatewayKey

    candidates = sorted({a for a in agent_ids if a})
    if not candidates:
        return set()
    try:
        rows = (
            await db.execute(
                select(AgentGatewayKey.agent_id, AgentGatewayKey.allowed_rooms).where(
                    AgentGatewayKey.agent_id.in_(candidates),
                    AgentGatewayKey.revoked_at.is_(None),
                )
            )
        ).all()
    except Exception:
        logger.debug("bridge_key_lookup_failed", exc_info=True)
        return set()
    return {agent_id for agent_id, allowed in rows if _room_in_allowed(allowed, room)}


async def connected_bridge_agents(
    *, db: Any, room: Any, agent_ids: Iterable[str]
) -> set[str]:
    """Of ``agent_ids``, the bridges in ``room`` that are RUNNING RIGHT NOW.

    :func:`scoped_bridge_agents` (it is a bridge here) plus a gateway call from
    that agent within ``GATEWAY_SEEN_TTL_SECONDS`` (a process is actually up).
    Recent USE is the closest thing to liveness the gateway's polling protocol
    gives us, and we claim no more than that.

    The two conditions answer two different questions and are kept apart on
    purpose:

    * "never call it thinking" needs only the structural fact — a bridge that
      has been idle for an hour is still not a Brigade agent, and a liveness
      gate there would quietly re-open the lie for every dormant bridge.
    * "a relay is outstanding" needs the liveness fact — telling a room it is
      waiting on a process that died last week is its own false statement.
    """
    scoped = sorted(await scoped_bridge_agents(db=db, room=room, agent_ids=agent_ids))
    if not scoped:
        return set()
    try:
        seen = await _get_pub_redis().mget([_seen_key(a) for a in scoped])
    except Exception:
        logger.debug("gateway_seen_lookup_failed", exc_info=True)
        return set()
    return {a for a, v in zip(scoped, seen) if v is not None}


async def is_bridge_agent(*, db: Any, room: Any, agent_id: str) -> bool:
    """True when ``agent_id`` is owned by a gateway bridge in ``room``.

    The in-process responder calls this to refuse to act — or claim to be
    thinking — as an agent that is really an external polling process. It is
    the STRUCTURAL test on purpose (see :func:`scoped_bridge_agents`): a bridge
    that has not polled recently is still a bridge, and Brigade still has no
    persona to generate its reply.

    Errors resolve to False so a detection failure silences nobody: the worst
    case is the old behaviour for one message, never a mute resident agent.
    """
    return agent_id in await scoped_bridge_agents(
        db=db, room=room, agent_ids=[agent_id]
    )


async def mark_relay_pending_for_room(*, db: Any, room_id: uuid.UUID) -> None:
    """Mark every live bridge agent in ``room_id`` as holding an uncollected
    message, naming each one individually.

    Bridge-ness (:func:`connected_bridge_agents`) is the ONLY discriminator,
    and that is what makes the two states mutually exclusive by construction: a
    live bridge is marked here and never receives a typing signal (the
    responder refuses on the same predicate), while any other agent is left
    alone here and speaks for itself through real typing events. No agent can
    show both, and neither state consults room metadata — which the room this
    bug came from does not have.

    Every marked agent carries its own ``display_name`` and participant id, so
    a multi-agent room names the agent it is actually talking about instead of
    attributing one agent's state to another.

    Bridges that authenticate with a uchub JWT rather than a minted key have no
    key row and so are never marked. Deliberate: the failure mode is an absent
    indicator, never a false one.
    """
    from sqlalchemy import select

    from app.models.participant import Participant, ParticipantType
    from app.models.room import Room, RoomMember

    try:
        room = (
            await db.execute(select(Room).where(Room.id == room_id))
        ).scalar_one_or_none()
        if room is None:
            return

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

        by_agent_id: dict[str, Participant] = {}
        for p in agents:
            sub = p.keycloak_sub or ""
            if sub.startswith("brigade:"):
                agent_id = sub.split(":", 1)[1]
                if agent_id:
                    by_agent_id[agent_id] = p
        if not by_agent_id:
            return

        for agent_id in sorted(
            await connected_bridge_agents(db=db, room=room, agent_ids=by_agent_id)
        ):
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
    "connected_bridge_agents",
    "is_bridge_agent",
    "scoped_bridge_agents",
    "mark_relay_pending",
    "touch_gateway_agent",
    "mark_relay_pending_for_room",
    "publish_agent_typing",
]
