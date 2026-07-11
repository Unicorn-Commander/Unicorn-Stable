from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError
from redis.asyncio import Redis
from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.keycloak import extract_user_identity, validate_token
from app.config import get_settings
from app.models.participant import Participant
from app.models.room import RoomMember
from app.services.presence_service import PresenceService

logger = structlog.get_logger(__name__)

router = APIRouter()


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
        logger.warning("ws_auth_failed", error=str(exc))
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
                await _safe_send(websocket, data)
            except (json.JSONDecodeError, WebSocketDisconnect):
                break
            except Exception:
                logger.exception("ws_pubsub_forward_error", participant_id=participant_id)
                break
    finally:
        await pubsub.unsubscribe()
        await pubsub.aclose()


async def _handle_client_events(
    websocket: WebSocket,
    participant_id: str,
    redis: Redis,
    presence: PresenceService,
    room_ids: list[str],
) -> None:
    """Handle incoming events from the WebSocket client."""
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await _safe_send(websocket, {"error": "invalid_json"})
                continue

            event_type = data.get("type")

            if event_type == "typing_start":
                room_id = data.get("room_id")
                if room_id and room_id in room_ids:
                    await presence.set_typing(participant_id, room_id)
                    # Broadcast typing event to room
                    await redis.publish(
                        f"room:{room_id}",
                        json.dumps({
                            "type": "typing",
                            "participant_id": participant_id,
                            "room_id": room_id,
                            "is_typing": True,
                        }),
                    )

            elif event_type == "typing_stop":
                room_id = data.get("room_id")
                if room_id and room_id in room_ids:
                    await presence.clear_typing(participant_id, room_id)
                    await redis.publish(
                        f"room:{room_id}",
                        json.dumps({
                            "type": "typing",
                            "participant_id": participant_id,
                            "room_id": room_id,
                            "is_typing": False,
                        }),
                    )

            elif event_type == "mark_read":
                room_id = data.get("room_id")
                message_id = data.get("message_id")
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
        room_ids = await _get_user_room_ids(db, participant_id)

    # Connect and set presence
    await manager.connect(participant_id, websocket)
    await presence.set_online(participant_id, "online")
    for rid in room_ids:
        await presence.join_room_presence(participant_id, rid)

    # Broadcast presence change to all rooms
    for rid in room_ids:
        await redis.publish(
            f"room:{rid}",
            json.dumps({
                "type": "presence_change",
                "participant_id": participant_id,
                "status": "online",
            }),
        )

    # Run pub/sub listener and client event handler concurrently
    pubsub_task = asyncio.create_task(
        _subscribe_to_rooms(redis, room_ids, websocket, participant_id),
        name=f"ws-pubsub-{participant_id}",
    )
    client_task = asyncio.create_task(
        _handle_client_events(websocket, participant_id, redis, presence, room_ids),
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
        # Clean up
        manager.disconnect(participant_id)
        await presence.set_offline(participant_id)
        for rid in room_ids:
            await presence.leave_room_presence(participant_id, rid)
            await redis.publish(
                f"room:{rid}",
                json.dumps({
                    "type": "presence_change",
                    "participant_id": participant_id,
                    "status": "offline",
                }),
            )

        try:
            await websocket.close()
        except Exception:
            pass
