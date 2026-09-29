from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
from jose import JWTError
from jose.exceptions import ExpiredSignatureError
from redis.asyncio import Redis
from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.guest_auth import (
    GuestAuthError,
    guest_session_is_live,
    guest_user_dict,
    is_guest_credential,
    touch_guest_session,
    verify_guest_session,
)
from app.auth.keycloak import extract_user_identity, validate_token
from app.config import get_settings
from app.models.participant import Participant, ParticipantType
from app.models.room import RoomMember
from app.services.guest_view import guest_view_of_envelope
from app.services.presence_service import (
    INSTANCE_PRESENCE_CHANNEL,
    PresenceService,
    TYPING_TTL,
)

logger = structlog.get_logger(__name__)

router = APIRouter()

# Server-side floor on typing_start re-broadcasts, per (participant, room).
# The client already throttles its keepalives, but the fan-out cost of this
# event is paid by EVERY socket in the room, so the server does not take a
# buggy or hostile client's word for how often that should happen. Comfortably
# under TYPING_TTL so an honest keepalive is never swallowed.
TYPING_REBROADCAST_FLOOR_S: float = 1.0
# mark_read costs a DB write + commit + room-wide publish per frame; floor it
# to one accepted frame per room per second (see the client-event task).
MARK_READ_FLOOR_S: float = 1.0

# How long an accepted-but-unauthenticated socket may sit before we require
# its auth frame. Generous enough for a slow mobile link to flush one frame,
# tight enough that anonymous sockets cannot be parked as a resource drain.
AUTH_FRAME_TIMEOUT_S: float = 6.0

# How often a live guest socket stamps GuestSession.last_seen_at. The liveness
# tick runs every 4s; writing on every one of them would turn a read into a
# write 15x a minute per guest for a column nothing reads that often. Once a
# minute is enough for an owner watching "who is on my link right now".
GUEST_LAST_SEEN_EVERY_S: float = 60.0

# ---------------------------------------------------------------------------
# Server-initiated force-close
# ---------------------------------------------------------------------------
#
# Until this existed there was NO way for the server to hang up on a live
# socket. The nearest thing — the `room_revoked` pubsub message consumed below
# — only unsubscribes a room channel and mutates the authorizing `room_ids`
# list in place; `ConnectionManager.disconnect` only pops a dict entry, and the
# real `websocket.close()` lives in the endpoint's `finally`. So a kicked user
# kept a socket that simply had nothing left to deliver.
#
# That is not good enough for "revoke the guest link → the guest is gone now":
# the guest's browser would sit on a live, silent connection looking connected.
#
# FORCE_DISCONNECT is the missing primitive. It is published on the
# per-participant `user:{participant_id}` channel; the forward loop below sends
# a final `session_ended` frame (so the client knows this was deliberate and
# must not auto-reconnect) and then BREAKS, which completes the pubsub task,
# trips the endpoint's `asyncio.wait(FIRST_COMPLETED)`, and runs the existing
# teardown — presence cleanup, typing retraction, and the real socket close.
# No new teardown path; it just reaches the one that already exists.
#
# Deliberately generic, not guest-specific: any code that needs to evict a live
# socket should publish this rather than inventing a second mechanism.
FORCE_DISCONNECT_EVENT = "force_disconnect"


async def publish_force_disconnect(
    redis: Redis, participant_id: str, *, reason: str
) -> None:
    """Ask every live socket for ``participant_id`` to hang up now.

    Best-effort by nature (it is a pubsub message to whichever worker holds the
    socket), so callers must treat the authoritative credential check as the
    real boundary and this as the fast path. Never raises.
    """
    try:
        await redis.publish(
            f"user:{participant_id}",
            json.dumps(
                {"type": FORCE_DISCONNECT_EVENT, "reason": str(reason or "")[:120]}
            ),
        )
    except Exception:
        logger.warning(
            "force_disconnect_publish_failed",
            participant_id=str(participant_id),
            exc_info=True,
        )


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
        # Frame-auth sockets are accepted up in the endpoint (the auth frame
        # cannot be received on an unaccepted socket); accepting twice raises.
        if websocket.application_state == WebSocketState.CONNECTING:
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


def _mark_read_message_uuid(value: Any) -> Any | None:
    """Coerce mark_read's message_id to a UUID, or None when it isn't one.

    The receipt's message_id is client-supplied. A non-UUID value (an
    `optimistic-…` id from a bubble the sender's client hadn't reconciled yet,
    or anything hand-rolled) previously flowed straight into a
    `Message.id == value` comparison, where the asyncpg UUID bind raises — an
    uncaught error that tears down the WHOLE websocket, not just the frame.
    The client now withholds mark_read until the send is ACKed, but the
    server must not let one malformed frame kill a connection either way.
    """
    import uuid as _uuid

    if value is None:
        return None
    try:
        return _uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


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


async def _authenticate_guest_ws(
    websocket: WebSocket,
    token: str,
) -> dict[str, Any] | None:
    """Authenticate a room GUEST's socket against its Stable session row.

    Guests hold no Keycloak token — by design; see auth/guest_auth.py for why
    routing them through OIDC would auto-create real realm accounts. The
    returned dict carries ``sub = "guest:<uuid>"``, which is exactly what the
    endpoint's ``Participant.keycloak_sub == user["sub"]`` lookup needs, so the
    rest of the socket lifecycle is unchanged.
    """
    settings = get_settings()
    if not settings.guest_access_enabled:
        logger.info("ws_guest_auth_refused", reason="feature_disabled")
        return None
    session_factory = websocket.app.state.db_session_factory
    try:
        async with session_factory() as db:
            principal = await verify_guest_session(token, db)
    except GuestAuthError:
        # Uniform: expired, revoked, unknown, or invite-cascade-revoked all
        # look the same here, exactly as they do over HTTP.
        logger.info("ws_guest_auth_failed", transport="websocket")
        return None
    return guest_user_dict(principal)


async def _authenticate_ws(
    websocket: WebSocket,
    token: str,
) -> dict[str, Any] | None:
    """Authenticate a WebSocket connection using a JWT token, or a guest session."""
    if is_guest_credential(token):
        return await _authenticate_guest_ws(websocket, token)
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
    allowed_room_ids: set[str] | None = None,
    guest_session_id: str | None = None,
) -> None:
    """Subscribe to Redis pub/sub channels for the user's rooms and forward events.

    Always includes the instance-local presence channel so directory / People
    drawer UIs receive online/offline for everyone on THIS server, not only
    peers in a shared room. That channel is Redis-local to this deployment —
    it is never bridged to federated Stable instances.

    ``allowed_room_ids`` is a HARD CEILING on what this socket may ever
    subscribe to, applied to the periodic membership re-derivation below.
    Guests pass their one room here: without it, the refresh loop would happily
    subscribe a guest to any room a membership row later appeared for, which
    would quietly undo the credential's room scope four seconds after it was
    enforced. ``None`` (members) keeps the original grow-with-membership
    behaviour.
    """
    pubsub = redis.pubsub()
    channels = [f"room:{rid}" for rid in room_ids]
    channels.append(f"user:{participant_id}")
    # Global (instance-scoped) presence — required even when the user has zero
    # rooms so the People directory still receives live online/offline deltas.
    #
    # NOT FOR GUESTS. This channel carries an online/offline delta for every
    # participant on the whole deployment, and a guest has no People directory,
    # no room list, and no business knowing who else exists on this server. A
    # guest subscribed here would be handed a live census of the instance —
    # participant ids and presence — through the one socket they are allowed to
    # open. ``guest_session_id`` is exactly "this socket authenticated as a
    # guest" (the endpoint sets it from the session row and nothing else does),
    # so it is the correct discriminator. The outbound half of the same leak is
    # closed in the endpoint below by not PUBLISHING guest presence here.
    is_guest_socket = guest_session_id is not None
    if not is_guest_socket:
        channels.append(INSTANCE_PRESENCE_CHANNEL)
    known_rooms: set[str] = set(room_ids)
    # Throttle for the guest last_seen_at stamp below. 0.0 makes the first
    # liveness tick stamp immediately, so an owner watching the session list
    # sees a guest go "seen" within seconds of them connecting.
    last_touch_at = 0.0

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
                    if guest_session_id is not None:
                        async with session_factory() as _db:
                            _live = await guest_session_is_live(
                                _db, guest_session_id
                            )
                            if _live and (
                                time.monotonic() - last_touch_at
                                >= GUEST_LAST_SEEN_EVERY_S
                            ):
                                # Same session as the liveness read, so this
                                # costs one statement, not a second connection.
                                last_touch_at = time.monotonic()
                                await touch_guest_session(_db, guest_session_id)
                        if not _live:
                            logger.info(
                                "ws_guest_session_ended",
                                participant_id=participant_id,
                                session_id=guest_session_id,
                            )
                            try:
                                await _safe_send(
                                    websocket,
                                    {
                                        "type": "session_ended",
                                        "reason": "guest_session_ended",
                                    },
                                )
                            except Exception:
                                pass
                            break
                    if allowed_room_ids is not None:
                        # Guest ceiling — see the docstring. Applied BEFORE the
                        # subscribe and before the revocation diff, so an
                        # out-of-scope room is treated as "not a room of yours"
                        # in both directions.
                        _rids = [rid for rid in _rids if rid in allowed_room_ids]
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
                    # REVOCATION, not just growth. Until 2026-08-07 this loop
                    # only ever added rooms, so a KICKED member's socket kept
                    # receiving every new message (and could keep emitting
                    # typing/mark_read) in the room they were removed from
                    # until their next reconnect — the kick looked complete
                    # (LiveKit eviction + members_changed hides the room in an
                    # honest client) but text confidentiality wasn't cut.
                    # Membership loss must revoke the stream server-side,
                    # within this loop's 4s cadence.
                    _current = set(_rids)
                    _gone = [rid for rid in known_rooms if rid not in _current]
                    if _gone:
                        _gone_channels = [f"room:{rid}" for rid in _gone]
                        await pubsub.unsubscribe(*_gone_channels)
                        subscribed.difference_update(_gone_channels)
                        known_rooms.difference_update(_gone)
                        room_ids[:] = [r for r in room_ids if r in _current]
                        logger.info(
                            "ws_room_revoked",
                            rooms=_gone,
                            participant_id=participant_id,
                        )
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
                if data.get("type") == FORCE_DISCONNECT_EVENT:
                    # Server-initiated hang-up (see FORCE_DISCONNECT_EVENT at
                    # the top of this module). Tell the client this was
                    # deliberate so it stops reconnecting, then break: that
                    # completes this task, trips the endpoint's
                    # asyncio.wait(FIRST_COMPLETED), and runs the existing
                    # teardown — which is what actually closes the socket.
                    reason = str(data.get("reason") or "session_ended")[:120]
                    logger.info(
                        "ws_force_disconnect",
                        participant_id=participant_id,
                        reason=reason,
                    )
                    try:
                        await _safe_send(
                            websocket, {"type": "session_ended", "reason": reason}
                        )
                    except Exception:
                        # Already gone; the teardown below is the point anyway.
                        pass
                    break
                if data.get("type") == "room_revoked":
                    revoked = str(data.get("room_id") or "")
                    channel = f"room:{revoked}"
                    if revoked and revoked in known_rooms:
                        await pubsub.unsubscribe(channel)
                        subscribed.discard(channel)
                        known_rooms.discard(revoked)
                        # This same mutable list authorizes client-originated
                        # typing/read frames, so revocation applies both ways.
                        room_ids[:] = [rid for rid in room_ids if rid != revoked]
                        logger.info("ws_room_revoked_immediate", room_id=revoked, participant_id=participant_id)
                    continue
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
                if is_guest_socket:
                    # The echo is published once for the whole room, so what
                    # a GUEST may not see has to come off here, at the
                    # guest's own socket (REVIEW-4 P2-2): a message's
                    # `gateway`, `on_behalf_of` and `agent_id` metadata.
                    data = guest_view_of_envelope(data)
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
    instance_presence: bool = True,
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
    # Same floor idea for mark_read: each frame costs a DB UPDATE + commit +
    # room-wide publish, and WS handlers run outside the HTTP rate_limit dep —
    # without a floor one looping client is an unbounded write amplifier.
    last_mark_read_at: dict[str, float] = {}
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
                # Non-UUID ids (unACKed optimistic bubbles, garbage) become
                # None — the receipt still advances last_read_at, it just
                # cannot name a message. Parsing HERE keeps a malformed frame
                # from raising inside the DB bind and killing the socket.
                message_id = _mark_read_message_uuid(body.get("message_id"))
                # Guard like typing_*: only act on a room the caller belongs to,
                # else a stranger could spoof read-receipts into any room by id.
                if room_id and room_id in room_ids:
                    # Floor like typing_*: each frame is a DB write + commit +
                    # room-wide publish, so absorb bursts (scroll-driven
                    # clients fire these freely) to one per room per second.
                    now = time.monotonic()
                    if now - last_mark_read_at.get(room_id, 0.0) < MARK_READ_FLOOR_S:
                        continue
                    last_mark_read_at[room_id] = now
                    # Persist last_read_at on the room_member row, then
                    # broadcast a read_receipt event to everyone in the room
                    # so their UI can show "seen by …".
                    from datetime import datetime, timezone

                    from sqlalchemy import select as _select
                    from sqlalchemy import update as _update
                    from app.models.message import Message as _Msg
                    from app.models.room import RoomMember as _RM

                    session_factory = websocket.app.state.db_session_factory
                    async with session_factory() as db:
                        # Echo message_id only if it names a real message IN
                        # this room — otherwise a member could stamp "seen by"
                        # onto an arbitrary/foreign UUID for everyone's UI.
                        if message_id:
                            _owns = await db.execute(
                                _select(_Msg.id).where(
                                    _Msg.id == message_id,
                                    _Msg.room_id == room_id,
                                )
                            )
                            if _owns.scalar_one_or_none() is None:
                                message_id = None
                        await db.execute(
                            _update(_RM)
                            .where(
                                _RM.room_id == room_id,
                                _RM.participant_id == participant_id,
                            )
                            .values(
                                last_read_at=datetime.now(timezone.utc),
                                mention_count=0,
                                has_unread_mention=False,
                            )
                        )
                        await db.commit()
                    await redis.publish(
                        f"room:{room_id}",
                        json.dumps({
                            "type": "read_receipt",
                            "room_id": room_id,
                            "participant_id": participant_id,
                            # message_id is a uuid.UUID after validation —
                            # back to a string for the wire.
                            "message_id": str(message_id) if message_id else None,
                            "at": datetime.now(timezone.utc).isoformat(),
                        }),
                    )

            elif event_type in ("heartbeat", "ping"):
                # The web client sends {type:"ping"} every 25s and treats ANY
                # inbound frame as proof-of-life (it also special-cases "pong").
                # Refresh presence TTL and answer so a quiet room never looks
                # dead. (Previously "ping" fell through to the else and got an
                # error back + never refreshed presence.)
                #
                # `instance_presence` is False for guests: heartbeat RE-PUBLISHES
                # online when the key has lapsed, so leaving it True here would
                # leak a guest onto the instance-wide channel ~2 minutes after a
                # connect-time-only fix had "closed" it.
                await presence.heartbeat(
                    participant_id, instance_wide=instance_presence
                )
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

    Authenticates via a first-frame auth message (preferred) or a token query
    param (legacy: agents / MCP clients with compact service tokens), then
    subscribes to Redis pub/sub for the user's rooms and handles bidirectional
    communication.

    The frame path exists because real uchub access tokens overflow a query
    string: uvicorn's parser answers a request line past ~8 KiB by never
    responding at all, so the handshake hangs and the client shows an eternal
    "reconnecting" state with nothing in any log. A token in the first frame
    has no such ceiling — and never lands in a URL, access log, proxy buffer,
    or browser history either.
    """
    token = websocket.query_params.get("token")
    if token:
        # Legacy path: reject before accept so the handshake itself fails (403).
        user = await _authenticate_ws(websocket, token)
        if user is None:
            await websocket.close(code=4003, reason="Authentication failed")
            return
    else:
        # Frame path: accept, then require {"type": "auth", "token": …} as the
        # very first frame, inside a hard deadline so an idle or probing
        # connection cannot hold the socket open unauthenticated.
        await websocket.accept()
        try:
            first = await asyncio.wait_for(
                websocket.receive_json(), timeout=AUTH_FRAME_TIMEOUT_S
            )
        except (
            TimeoutError,
            asyncio.TimeoutError,
            ValueError,
            # A BINARY first frame: starlette's receive_json does
            # message["text"], which KeyErrors on a bytes frame — uncaught,
            # that's a pre-auth ERROR traceback per probe connection (cheap
            # log-spam vector). Same clean 4001 close as any other bad frame.
            KeyError,
            WebSocketDisconnect,
        ):
            await websocket.close(code=4001, reason="Expected auth frame")
            return
        frame_token = (
            first.get("token")
            if isinstance(first, dict) and first.get("type") == "auth"
            else None
        )
        if not frame_token or not isinstance(frame_token, str):
            await websocket.close(code=4001, reason="Expected auth frame")
            return
        user = await _authenticate_ws(websocket, frame_token)
        if user is None:
            await websocket.close(code=4003, reason="Authentication failed")
            return
        # The explicit auth_ok ack is sent AFTER participant resolution below,
        # so it can carry participant_id — the client needs its own participant
        # identity (a different id space than the Keycloak sub it already has)
        # to recognise its own messages in room events.

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

    # GUEST SCOPE. A guest session names exactly ONE room, and that name — not
    # the membership table — is the ceiling on this socket. Membership already
    # confines them today, but membership is data another code path can write,
    # while `guest_room_id` came off the row that authorized this connection.
    # Intersecting here (and passing the ceiling into the refresh loop below)
    # means a stray membership row can never widen a guest's stream.
    #
    # PRESENCE SCOPE rides along with it. A guest's online/offline belongs to
    # the one room they were invited to, not to the instance-wide presence
    # channel that every socket on this deployment subscribes to. See
    # PresenceService.set_online and the INSTANCE_PRESENCE_CHANNEL comment in
    # _subscribe_to_rooms — this flag closes the outbound half, that one closes
    # the inbound half.
    allowed_room_ids: set[str] | None = None
    guest_session_id: str | None = None
    is_guest_socket = bool(user.get("is_guest"))
    if is_guest_socket:
        allowed_room_ids = {str(user.get("guest_room_id"))}
        guest_session_id = str(user.get("guest_session_id"))
        room_ids = [rid for rid in room_ids if rid in allowed_room_ids]
        if not room_ids:
            # The guest's membership was removed (revoked/kicked) between
            # credential check and here. Nothing to subscribe to; refuse rather
            # than hold an inert socket open.
            await websocket.close(code=4004, reason="Guest room membership not found")
            return

    # Rooms this connection is currently ASSERTING typing in. Owned by the
    # endpoint (not the event task) so the teardown below can retract them even
    # when that task is the one that died.
    typing_rooms: set[str] = set()

    if token is None:
        # Frame-auth ack: the first frame the client receives, and the signal
        # it treats as "actually connected". Carries the participant id so the
        # client can recognise its own messages in room events (sender_id is a
        # participant UUID — a different id space than the Keycloak sub the
        # client already knows). Legacy query-token clients get no ack; they
        # never waited for one.
        await _safe_send(
            websocket, {"type": "auth_ok", "participant_id": participant_id}
        )

    # Connect and set presence
    await manager.connect(participant_id, websocket)
    await presence.set_online(
        participant_id, "online", instance_wide=not is_guest_socket
    )
    for rid in room_ids:
        await presence.join_room_presence(participant_id, rid)

    # Broadcast presence change to all rooms. THIS is where a guest's presence
    # goes — `room_ids` is their single room — and it is why suppressing the
    # instance-wide publish above costs the roster they are actually in nothing.
    for rid in room_ids:
        await redis.publish(
            f"room:{rid}",
            json.dumps(_presence_payload(participant_id, online=True)),
        )

    # Run pub/sub listener and client event handler concurrently
    pubsub_task = asyncio.create_task(
        _subscribe_to_rooms(
            redis,
            room_ids,
            websocket,
            participant_id,
            allowed_room_ids,
            guest_session_id,
        ),
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
            instance_presence=not is_guest_socket,
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
        # Must mirror the connect-time scope: announcing an instance-wide
        # offline for a guest who was never announced online would be a
        # phantom event on every client on the server.
        await presence.set_offline(participant_id, instance_wide=not is_guest_socket)
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
