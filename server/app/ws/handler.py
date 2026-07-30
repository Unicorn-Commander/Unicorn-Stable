from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError
from jose.exceptions import ExpiredSignatureError
from redis.asyncio import Redis
from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.keycloak import extract_user_identity, validate_token
from app.config import get_settings
from app.models.participant import Participant, ParticipantType
from app.models.room import RoomMember
from app.services.presence_service import PresenceService, TYPING_TTL

logger = structlog.get_logger(__name__)

router = APIRouter()

# Server-side floor on typing_start re-broadcasts, per (participant, room).
# The client already throttles its keepalives, but the fan-out cost of this
# event is paid by EVERY socket in the room, so the server does not take a
# buggy or hostile client's word for how often that should happen. Comfortably
# under TYPING_TTL so an honest keepalive is never swallowed.
TYPING_REBROADCAST_FLOOR_S: float = 1.0


def _jwt_failure_reason(exc: JWTError) -> str:
    """Map auth failures to bounded operational labels.

    Never put raw JWT exceptions in logs. Some jose errors include key ids,
    claims, or token-derived values; operators need the failure class, not the
    submitted credential.
    """
    if isinstance(exc, ExpiredSignatureError):
        return "expired"
    message = str(exc).lower()
    if "audience" in message:
        return "audience"
    if "issuer" in message:
        return "issuer"
    if "signing key" in message or "signature" in message:
        return "signature"
    if "missing" in message:
        return "malformed"
    return "invalid"


async def _safe_send(ws: WebSocket, data: dict[str, Any]) -> None:
    """Serialize every send on a socket behind a per-connection lock.

    A single WS is written by THREE concurrent producers: the Redis pub/sub
    forwarder task, the client-event handler (heartbeat/errors), and the
    in-process ConnectionManager (reaction fanout from API handlers). Starlette
    WebSockets are NOT safe for concurrent sends — two overlapping send_json
    calls corrupt the ASGI send state and raise, which ends one of the endpoint
    tasks and (via FIRST_COMPLETED) tears the whole socket down. That surfaced
    as random "connection lost" drops, especially in a quiet room where the
    heartbeat send was the only traffic to collide with. The lock lives on the
    socket so all three producers share it."""
    lock = getattr(ws, "_send_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        ws._send_lock = lock  # type: ignore[attr-defined]
    async with lock:
        await ws.send_json(data)


class ConnectionManager:
    """Manages active WebSocket connections and Redis pub/sub subscriptions."""

    def __init__(self) -> None:
        self._connections: dict[str, WebSocket] = {}  # participant_id -> WebSocket

    async def connect(self, participant_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[participant_id] = websocket
        logger.info("ws_connected", participant_id=participant_id)

    def disconnect(self, participant_id: str) -> None:
        self._connections.pop(participant_id, None)
        logger.info("ws_disconnected", participant_id=participant_id)

    async def send_to_participant(self, participant_id: str, data: dict[str, Any]) -> None:
        ws = self._connections.get(participant_id)
        if ws:
            try:
                await _safe_send(ws, data)
            except Exception:
                logger.exception("ws_send_failed", participant_id=participant_id)
                self.disconnect(participant_id)

    async def broadcast_to_room(
        self,
        room_member_ids: list[str],
        data: dict[str, Any],
        exclude: str | None = None,
    ) -> None:
        for pid in room_member_ids:
            if pid != exclude:
                await self.send_to_participant(pid, data)


manager = ConnectionManager()


def _presence_payload(participant_id: str, *, online: bool) -> dict[str, Any]:
    """Canonical presence event for the room socket.

    The web roster resolves a member's online dot on the Participant UUID
    (RoomMember.participant_id) — the backend never sends the Keycloak id on a
    member row, so `user_id` on the FE is always undefined and the dot falls
    back to `participant_id`. We therefore surface the SAME participant id under
    BOTH keys: `participant_id` (canonical) and `user_id` (what the presence
    hook reads today). `is_online` is the boolean the client consumes; `status`
    mirrors the /members wire-format string for any status-shaped consumer.
    Event name is "presence" to match `ws.on("presence", …)` on the client.
    """
    return {
        "type": "presence",
        "participant_id": participant_id,
        "user_id": participant_id,
        "is_online": online,
        "status": "online" if online else "offline",
    }


def _typing_payload(
    participant_id: str,
    room_id: str,
    *,
    username: str,
    is_typing: bool,
) -> dict[str, Any]:
    """Canonical HUMAN typing event for the room socket.

    Identity follows the same convention `_presence_payload` had to adopt: the
    web client resolves room members on the Participant UUID, never the
    Keycloak id, so we surface that id under BOTH `participant_id` (canonical)
    and `user_id` (what the presence/typing hook reads). `username` is carried
    on the wire because the alternative — the client resolving a name from its
    members list — shows "Someone is typing…" for anyone whose row has not
    loaded yet, which is the common case on a cold room open.

    `participant_type` is stated explicitly rather than implied. This event is
    only ever emitted for humans (see `_handle_client_events`), and saying so
    on the wire lets the client keep human typing and agent activity
    (`agent_typing` / `agent_relay`, see services/agent_status.py) as the two
    distinct facts they are, even against an older or future server.
    """
    return {
        "type": "typing",
        "room_id": room_id,
        "participant_id": participant_id,
        "user_id": participant_id,
        "username": username,
        "participant_type": "human",
        "is_typing": is_typing,
        # The server's own key lifetime, published so the client's last-resort
        # expiry is derived from it rather than from a second constant that can
        # drift out of agreement with it (agent_relay does the same).
        "ttl_seconds": TYPING_TTL,
    }


def _event_body(data: dict[str, Any]) -> dict[str, Any]:
    """Read a client event's fields whether they are flat or under `payload`.

    `services/websocket.ts` sends `{type, payload:{…}}`; this handler has
    always read `room_id` from the TOP level. Those two never met, which is
    why the pre-existing typing surface was inert end-to-end. Accepting both
    shapes fixes it without requiring the browser and the backend to deploy in
    lockstep — during a rollout each end will see the other's framing.

    NOW ALSO APPLIED TO `mark_read`, on purpose. `mark_read` was broken in
    exactly this way since it was written: the client has always sent
    `{type:"mark_read", payload:{room_id, message_id}}` and the handler read
    `data["room_id"]`, so the `room_id in room_ids` guard was never true and
    the branch behind it never ran. It is the SOLE writer of
    RoomMember.last_read_at anywhere in the server (198/198 room_members rows
    in production have last_read_at NULL, which is the fingerprint), and
    room_service.py treats NULL as "everything in the room is unread". So
    switching it on has a real, intended one-time effect: badges that have
    been counting every message a room ever held start counting only what
    arrived since the reader last had the room open. That is the correct
    number, not a regression — but it is visible, it happens to every user at
    once, and it is why this was held back rather than fixed in passing. Two
    downstream surfaces come alive with it, both already written and both
    previously unreachable: the "New messages" divider (ChatPanel reads
    readReceipts[room][self], fed by the read_receipt frame this branch
    finally publishes) and the "Seen by" row.

    Backfilling last_read_at is deliberately NOT done here. Stamping "now" on
    198 rows would declare every unread message read for every user, silently
    and irreversibly; letting the first genuine mark_read set the true value
    loses nothing and asserts only what actually happened.
    """
    payload = data.get("payload")
    if isinstance(payload, dict):
        merged = {k: v for k, v in data.items() if k != "payload"}
        merged.update(payload)
        return merged
    return data


async def _authenticate_ws(
    websocket: WebSocket,
    token: str,
) -> dict[str, Any] | None:
    """Authenticate a WebSocket connection using a JWT token."""
    settings = get_settings()
    try:
        claims = await validate_token(
            token=token,
            keycloak_url=settings.keycloak_url,
            realm=settings.keycloak_realm,
            client_id=settings.keycloak_client_id,
        )
        return extract_user_identity(claims)
    except JWTError as exc:
        logger.warning(
            "ws_auth_failed",
            reason=_jwt_failure_reason(exc),
            transport="websocket",
        )
        return None


async def _get_user_room_ids(
    db: AsyncSession,
    participant_id: str,
) -> list[str]:
    """Get all room IDs the participant is a member of."""
    result = await db.execute(
        select(RoomMember.room_id).where(
            RoomMember.participant_id == participant_id,
        )
    )
    return [str(row[0]) for row in result.all()]


async def _subscribe_to_rooms(
    redis: Redis,
    room_ids: list[str],
    websocket: WebSocket,
    participant_id: str,
) -> None:
    """Subscribe to Redis pub/sub channels for the user's rooms and forward events."""
    if not room_ids:
        return

    pubsub = redis.pubsub()
    channels = [f"room:{rid}" for rid in room_ids]
    channels.append(f"user:{participant_id}")
    known_rooms: set[str] = set(room_ids)

    await pubsub.subscribe(*channels)
    subscribed: set[str] = set(channels)
    logger.debug("ws_subscribed_to_channels", channels=channels, participant_id=participant_id)

    # Rooms the user joins/opens AFTER connect (e.g. a brand-new DM with an
    # agent) aren't in the snapshot above, so their live messages would never
    # arrive until a page refresh. Re-derive the membership list periodically
    # and subscribe to any new room channels so realtime just works.
    session_factory = websocket.app.state.db_session_factory
    last_refresh = time.monotonic()
    REFRESH_EVERY_S = 4.0

    try:
        while True:
            if time.monotonic() - last_refresh >= REFRESH_EVERY_S:
                last_refresh = time.monotonic()
                try:
                    async with session_factory() as _db:
                        _rids = await _get_user_room_ids(_db, participant_id)
                    _fresh = [
                        f"room:{rid}" for rid in _rids
                        if f"room:{rid}" not in subscribed
                    ]
                    if _fresh:
                        await pubsub.subscribe(*_fresh)
                        subscribed.update(_fresh)
                        logger.debug("ws_dyn_subscribed", channels=_fresh, participant_id=participant_id)
                    # `room_ids` is the SAME list object the client-event task
                    # authorizes typing/mark_read against. Extending it in
                    # place means a room joined after connect (a brand-new DM)
                    # can emit typing without a page refresh — otherwise the
                    # first room you open in a session is the one place the
                    # indicator silently does nothing.
                    for _rid in _rids:
                        if _rid not in known_rooms:
                            known_rooms.add(_rid)
                            room_ids.append(_rid)
                except Exception:
                    logger.debug("ws_room_refresh_failed", exc_info=True)
            # Poll with an explicit per-read timeout rather than pubsub.listen().
            # redis-py 8.x derives a *blocking* read's timeout from the connection's
            # socket_timeout, so listen() — which is meant to block forever — instead
            # raises TimeoutError whenever the subscriber connection sits idle past
            # socket_timeout (~5s here). That escaped the loop, killed this task, and
            # tore down the WebSocket every few seconds, silently breaking realtime
            # message delivery (text chat) while LiveKit audio kept working.
            # get_message(timeout=...) + swallowing the idle timeout keeps the
            # subscription alive across quiet periods.
            try:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
            except (RedisTimeoutError, asyncio.TimeoutError):
                continue
            if not message or message.get("type") != "message":
                continue
            try:
                data_raw = message["data"]
                if isinstance(data_raw, bytes):
                    data_raw = data_raw.decode("utf-8")
                data = json.loads(data_raw)
                # Never echo your own typing back to you. Redis pub/sub has no
                # per-subscriber exclusion, and the publisher may be a
                # DIFFERENT uvicorn worker than the one holding this socket, so
                # the sender-side `exclude` used by ConnectionManager cannot
                # help here — the drop has to happen at the receiving socket.
                # Without this you watch yourself type.
                if (
                    data.get("type") == "typing"
                    and data.get("participant_id") == participant_id
                ):
                    continue
                await _safe_send(websocket, data)
            except (json.JSONDecodeError, WebSocketDisconnect):
                break
            except Exception:
                logger.exception("ws_pubsub_forward_error", participant_id=participant_id)
                break
    finally:
        await pubsub.unsubscribe()
        await pubsub.aclose()


async def _publish_typing(
    redis: Redis,
    presence: PresenceService,
    *,
    participant_id: str,
    username: str,
    room_id: str,
    is_typing: bool,
) -> None:
    """Set/clear the Redis typing key and tell the room, in that order."""
    if is_typing:
        await presence.set_typing(participant_id, room_id)
    else:
        await presence.clear_typing(participant_id, room_id)
    await redis.publish(
        f"room:{room_id}",
        json.dumps(
            _typing_payload(
                participant_id, room_id, username=username, is_typing=is_typing
            )
        ),
    )


async def _clear_all_typing(
    redis: Redis,
    presence: PresenceService,
    *,
    participant_id: str,
    username: str,
    rooms: set[str],
) -> None:
    """Retract every typing assertion this connection is still making.

    Called from the endpoint's `finally`, so it runs on a clean close, a
    dropped socket, an auth-expired teardown, and an unhandled error alike.
    The Redis TTL would eventually expire these on its own, but a five-second
    ghost is still a lie, and the OTHER browsers in the room are driven by the
    event — not by our key's TTL — so without an explicit retraction their
    "…is typing" row survives until their own local backstop fires. A typing
    state with no clearing path is the exact bug class this is written to
    avoid, so it gets one on every exit.
    """
    for room_id in sorted(rooms):
        try:
            await _publish_typing(
                redis,
                presence,
                participant_id=participant_id,
                username=username,
                room_id=room_id,
                is_typing=False,
            )
        except Exception:
            # One unreachable room must not strand the others.
            logger.debug(
                "typing_clear_failed",
                participant_id=participant_id,
                room_id=room_id,
                exc_info=True,
            )


async def _handle_client_events(
    websocket: WebSocket,
    participant_id: str,
    redis: Redis,
    presence: PresenceService,
    room_ids: list[str],
    *,
    username: str = "",
    is_human: bool = True,
    typing_rooms: set[str] | None = None,
) -> None:
    """Handle incoming events from the WebSocket client.

    `is_human` gates the typing events specifically. "A person is typing" is a
    claim about a person; an agent identity holds a keyboard for nobody. Agents
    already have their own honest signalling — real `agent_typing` around a
    live Brigade call, and `agent_relay` for gateway bridges that have no
    thinking signal at all (see services/agent_status.py) — and those states
    are deliberately different facts from this one. Letting an agent identity
    emit `typing` here would quietly merge the two and re-open the "it looked
    like something was happening" lie from the other end.

    In practice a gateway/bridge agent talks to `api/gateway.py` over HTTP and
    never opens this socket, so this is a structural guarantee rather than a
    hot path: if a bridge ever does authenticate here with a uchub JWT, it is
    refused a human's indicator by construction instead of by convention.
    """
    typing_rooms = typing_rooms if typing_rooms is not None else set()
    # Last accepted typing_start per room, for the server-side rebroadcast floor.
    last_typing_at: dict[str, float] = {}
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await _safe_send(websocket, {"error": "invalid_json"})
                continue

            # `type` is top-level in BOTH framings, so it is read before any
            # unwrapping. The typing and mark_read branches below read from an
            # unwrapped body (`_event_body` accepts flat AND `payload`-wrapped
            # frames, so a browser on either build works across a deploy);
            # every other event still reads `data` directly because no client
            # has ever wrapped those.
            event_type = data.get("type")

            if event_type in ("typing_start", "typing_stop", "typing"):
                body = _event_body(data)
                # Tolerate the flag-shaped variant (`{type:"typing",
                # is_typing:bool}`) alongside the two explicit verbs, so an
                # older client build keeps working across a deploy.
                is_typing = (
                    bool(body.get("is_typing", True))
                    if event_type == "typing"
                    else event_type == "typing_start"
                )
                room_id = body.get("room_id")
                if not (room_id and room_id in room_ids):
                    continue
                if not is_human:
                    logger.debug(
                        "typing_refused_non_human",
                        participant_id=participant_id,
                        room_id=room_id,
                    )
                    continue

                if is_typing:
                    now = time.monotonic()
                    if now - last_typing_at.get(room_id, 0.0) < TYPING_REBROADCAST_FLOOR_S:
                        # Drop it outright — no Redis write either. A client
                        # spamming faster than the floor still gets one
                        # ACCEPTED event per second, and each of those refreshes
                        # a TYPING_TTL (5s) key, so its indicator never lapses
                        # from being throttled. Doing a 3-op Redis write per
                        # keystroke here would hand the bandwidth we just saved
                        # straight back to Redis.
                        continue
                    last_typing_at[room_id] = now
                    typing_rooms.add(room_id)
                else:
                    last_typing_at.pop(room_id, None)
                    typing_rooms.discard(room_id)

                await _publish_typing(
                    redis,
                    presence,
                    participant_id=participant_id,
                    username=username,
                    room_id=room_id,
                    is_typing=is_typing,
                )

            elif event_type == "mark_read":
                # Unwrap first: the web client sends these under `payload`
                # (services/websocket.ts `send()` frames every event as
                # `{type, payload}`), and reading `data["room_id"]` here is
                # exactly why read tracking never once executed. `_event_body`
                # returns `data` untouched when there is no `payload` key, so
                # a hand-rolled or older flat-framing client still works.
                body = _event_body(data)
                room_id = body.get("room_id")
                message_id = body.get("message_id")
                # Guard like typing_*: only act on a room the caller belongs to,
                # else a stranger could spoof read-receipts into any room by id.
                if room_id and room_id in room_ids:
                    # Persist last_read_at on the room_member row, then
                    # broadcast a read_receipt event to everyone in the room
                    # so their UI can show "seen by …".
                    from datetime import datetime, timezone

                    from sqlalchemy import update as _update
                    from app.models.room import RoomMember as _RM

                    session_factory = websocket.app.state.db_session_factory
                    async with session_factory() as db:
                        await db.execute(
                            _update(_RM)
                            .where(
                                _RM.room_id == room_id,
                                _RM.participant_id == participant_id,
                            )
                            .values(last_read_at=datetime.now(timezone.utc))
                        )
                        await db.commit()
                    await redis.publish(
                        f"room:{room_id}",
                        json.dumps({
                            "type": "read_receipt",
                            "room_id": room_id,
                            "participant_id": participant_id,
                            "message_id": message_id,
                            "at": datetime.now(timezone.utc).isoformat(),
                        }),
                    )

            elif event_type in ("heartbeat", "ping"):
                # The web client sends {type:"ping"} every 25s and treats ANY
                # inbound frame as proof-of-life (it also special-cases "pong").
                # Refresh presence TTL and answer so a quiet room never looks
                # dead. (Previously "ping" fell through to the else and got an
                # error back + never refreshed presence.)
                await presence.heartbeat(participant_id)
                await _safe_send(websocket, {"type": "pong"})

            else:
                await _safe_send(websocket, {
                    "error": "unknown_event_type",
                    "event_type": event_type,
                })

    except WebSocketDisconnect:
        logger.debug("ws_client_disconnected", participant_id=participant_id)


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """
    WebSocket endpoint for real-time events.

    Authenticates via token query param, subscribes to Redis pub/sub
    for the user's rooms, and handles bidirectional communication.
    """
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    # Authenticate
    user = await _authenticate_ws(websocket, token)
    if user is None:
        await websocket.close(code=4003, reason="Authentication failed")
        return

    # Look up participant
    app = websocket.app
    session_factory = app.state.db_session_factory
    redis: Redis = app.state.redis
    presence: PresenceService = app.state.presence_service

    async with session_factory() as db:
        result = await db.execute(
            select(Participant).where(Participant.keycloak_sub == user["sub"])
        )
        participant = result.scalar_one_or_none()
        if participant is None:
            await websocket.close(code=4004, reason="Participant not found")
            return

        participant_id = str(participant.id)
        # Read the identity facts while the session is open — the ORM object is
        # detached once we leave the block, and the typing fan-out needs a name
        # on every event without paying a DB round-trip per keystroke.
        is_human = participant.participant_type != ParticipantType.AGENT
        username = participant.display_name or user.get("preferred_username") or "Someone"
        room_ids = await _get_user_room_ids(db, participant_id)

    # Rooms this connection is currently ASSERTING typing in. Owned by the
    # endpoint (not the event task) so the teardown below can retract them even
    # when that task is the one that died.
    typing_rooms: set[str] = set()

    # Connect and set presence
    await manager.connect(participant_id, websocket)
    await presence.set_online(participant_id, "online")
    for rid in room_ids:
        await presence.join_room_presence(participant_id, rid)

    # Broadcast presence change to all rooms
    for rid in room_ids:
        await redis.publish(
            f"room:{rid}",
            json.dumps(_presence_payload(participant_id, online=True)),
        )

    # Run pub/sub listener and client event handler concurrently
    pubsub_task = asyncio.create_task(
        _subscribe_to_rooms(redis, room_ids, websocket, participant_id),
        name=f"ws-pubsub-{participant_id}",
    )
    client_task = asyncio.create_task(
        _handle_client_events(
            websocket,
            participant_id,
            redis,
            presence,
            room_ids,
            username=username,
            is_human=is_human,
            typing_rooms=typing_rooms,
        ),
        name=f"ws-client-{participant_id}",
    )

    try:
        done, pending = await asyncio.wait(
            [pubsub_task, client_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    except Exception:
        logger.exception("ws_error", participant_id=participant_id)
    finally:
        # Clean up. Typing goes FIRST: it is the state that lies loudest if it
        # survives the socket, and it must be retracted whether we got here by
        # a clean close, a network drop, or the exception branch above.
        manager.disconnect(participant_id)
        await _clear_all_typing(
            redis,
            presence,
            participant_id=participant_id,
            username=username,
            rooms=typing_rooms,
        )
        await presence.set_offline(participant_id)
        for rid in room_ids:
            await presence.leave_room_presence(participant_id, rid)
            await redis.publish(
                f"room:{rid}",
                json.dumps(_presence_payload(participant_id, online=False)),
            )

        try:
            await websocket.close()
        except Exception:
            pass
