"""ChatHandler — data channel text messaging between agent and room participants."""

from __future__ import annotations

import json
import time
from enum import StrEnum
from typing import Any, Callable, Coroutine

import httpx
import structlog

logger = structlog.get_logger(__name__)


class MessageType(StrEnum):
    CHAT = "chat"
    COMMAND = "command"
    ACTION_REQUEST = "action_request"
    ACTION_RESPONSE = "action_response"


# Map external/server-side wire types onto our internal MessageType.
_TYPE_ALIASES: dict[str, MessageType] = {
    "new_message": MessageType.CHAT,  # server emits this for chat messages
}

# Broadcasts the agent legitimately ignores (typing dots, streaming patches,
# UI-only acks). Listed so we silently drop them instead of WARN-logging.
_IGNORED_TYPES: set[str] = {
    "agent_typing",
    "message_updated",
    "action_decision",
    "read_receipt",
    "pins_changed",
    "reaction",
    "message_deleted",
}


_PROTOCOL_VERSION: int = 1


def _build_payload(
    msg_type: MessageType,
    content: str,
    *,
    sender_identity: str = "",
    metadata: dict[str, Any] | None = None,
) -> bytes:
    """Serialize a data-channel message to JSON bytes."""
    envelope: dict[str, Any] = {
        "v": _PROTOCOL_VERSION,
        "type": msg_type.value,
        "content": content,
        "sender": sender_identity,
        "ts": time.time(),
    }
    if metadata:
        envelope["meta"] = metadata
    return json.dumps(envelope, separators=(",", ":")).encode("utf-8")


def _parse_payload(raw: bytes) -> dict[str, Any] | None:
    """Deserialize a data-channel message. Returns None on malformed input."""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        logger.warning("chat_parse_failed", raw_length=len(raw))
        return None

    if not isinstance(data, dict) or "type" not in data:
        logger.warning("chat_invalid_envelope", data=data)
        return None

    return data


class ChatHandler:
    """Bridges LiveKit data channels with the Stable backend message API.

    Listens for incoming data-channel payloads, dispatches them by type,
    and provides methods to send structured messages back into the room.
    """

    def __init__(
        self,
        *,
        agent_identity: str,
        backend_url: str,
        agent_token: str,
        room_id: str,
    ) -> None:
        self._agent_identity: str = agent_identity
        self._backend_url: str = backend_url
        self._agent_token: str = agent_token
        self._room_id: str = room_id
        self._room: Any | None = None
        self._http: httpx.AsyncClient | None = None

        # Callback registries, keyed by MessageType
        self._handlers: dict[
            MessageType,
            list[Callable[[dict[str, Any]], Coroutine[Any, Any, None]]],
        ] = {mt: [] for mt in MessageType}

    # -- lifecycle --

    async def start(self, room: Any) -> None:
        """Attach to a LiveKit room and start listening on the data channel."""
        self._room = room
        self._http = httpx.AsyncClient(
            base_url=self._backend_url,
            headers={"Authorization": f"Bearer {self._agent_token}"},
            timeout=httpx.Timeout(15.0, connect=5.0),
        )
        # livekit-rtc 1.x: data_received emits a single DataPacket arg with
        # .data / .kind / .participant. Older versions used (data, participant,
        # kind). Accept both shapes for compatibility.
        def _sync_data_received(*args: Any, **kwargs: Any) -> None:
            import asyncio as _asyncio
            data_b: bytes
            participant: Any = None
            kind: Any = None
            if len(args) == 1 and hasattr(args[0], "data"):
                packet = args[0]
                data_b = packet.data
                participant = getattr(packet, "participant", None)
                kind = getattr(packet, "kind", None)
            else:
                data_b = args[0] if args else b""
                participant = args[1] if len(args) > 1 else None
                kind = args[2] if len(args) > 2 else None
            _asyncio.create_task(
                self._on_data_received(data_b, participant, kind)
            )

        room.on("data_received", _sync_data_received)
        logger.info("chat_handler_started", room_id=self._room_id)

    async def shutdown(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        self._room = None
        logger.info("chat_handler_stopped", room_id=self._room_id)

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("ChatHandler not started")
        return self._http

    # -- registration --

    def on(
        self,
        msg_type: MessageType,
        handler: Callable[[dict[str, Any]], Coroutine[Any, Any, None]],
    ) -> None:
        """Register a callback for a specific message type."""
        self._handlers[msg_type].append(handler)

    # -- sending --

    async def send_chat(self, content: str, *, metadata: dict[str, Any] | None = None) -> None:
        """Send a chat message into the room via data channel AND persist to backend."""
        await self._publish(MessageType.CHAT, content, metadata=metadata)
        await self._persist_message(content)

    async def send_command(self, content: str, *, metadata: dict[str, Any] | None = None) -> None:
        """Send a command message (not displayed as chat, used for agent coordination)."""
        await self._publish(MessageType.COMMAND, content, metadata=metadata)

    async def send_action_request(
        self,
        action: str,
        params: dict[str, Any],
    ) -> None:
        """Request another participant (agent or human) to perform an action."""
        await self._publish(
            MessageType.ACTION_REQUEST,
            action,
            metadata={"params": params},
        )

    async def send_action_response(
        self,
        action: str,
        result: Any,
        *,
        success: bool = True,
    ) -> None:
        """Respond to a previously received action request."""
        await self._publish(
            MessageType.ACTION_RESPONSE,
            action,
            metadata={"result": result, "success": success},
        )

    # -- internal --

    async def _publish(
        self,
        msg_type: MessageType,
        content: str,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Publish a message on the LiveKit data channel."""
        if self._room is None:
            logger.warning("chat_publish_no_room", msg_type=msg_type)
            return

        payload = _build_payload(
            msg_type,
            content,
            sender_identity=self._agent_identity,
            metadata=metadata,
        )

        try:
            await self._room.local_participant.publish_data(
                payload,
                reliable=True,
            )
            logger.debug(
                "chat_published",
                msg_type=msg_type,
                content_length=len(content),
            )
        except Exception:
            logger.error("chat_publish_failed", msg_type=msg_type, exc_info=True)

    async def _persist_message(self, content: str) -> None:
        """Store the message in the Stable backend for history / audit."""
        try:
            resp = await self.http.post(
                f"/api/rooms/{self._room_id}/messages",
                json={"content": content, "sender": self._agent_identity},
            )
            resp.raise_for_status()
        except Exception:
            logger.error("chat_persist_failed", room_id=self._room_id, exc_info=True)

    async def _on_data_received(self, data: bytes, participant: Any, kind: Any) -> None:
        """Handle an incoming data channel payload."""
        parsed = _parse_payload(data)
        if parsed is None:
            return

        # Server-side broadcasts wrap the message: {type: "new_message",
        # room_type: "channel"|"dm"|..., message: {sender:{...}, content, ...}}.
        # Flatten for our handlers but preserve room_type so the agent can
        # decide whether to require an @mention.
        if "message" in parsed and isinstance(parsed["message"], dict):
            inner = parsed["message"]
            sender_obj = inner.get("sender") or {}
            parsed = {
                "type": parsed.get("type"),
                "room_type": parsed.get("room_type", "channel"),
                "sender": (
                    sender_obj.get("display_name")
                    or sender_obj.get("username")
                    or ""
                ),
                "sender_id": inner.get("sender_id"),
                "sender_type": (sender_obj.get("participant_type") or "human"),
                "content": inner.get("content", ""),
                "message_id": inner.get("id"),
                "metadata": inner.get("metadata") or {},
            }

        sender: str = parsed.get("sender", "")
        sender_type = (parsed.get("sender_type") or "").lower()
        # Skip own + skip ALL agent-typed senders (no agent-talks-to-agent
        # echo loops). Sender display-name comparison was unreliable because
        # the agent identity is a random hex while sender is a friendly name.
        if sender == self._agent_identity or sender_type == "agent":
            return

        raw_type: str = parsed.get("type", "")
        try:
            msg_type = MessageType(raw_type)
        except ValueError:
            mapped = _TYPE_ALIASES.get(raw_type)
            if mapped is None:
                if raw_type not in _IGNORED_TYPES:
                    logger.warning("chat_unknown_type", raw_type=raw_type)
                return
            msg_type = mapped

        logger.info(
            "chat_received",
            msg_type=msg_type,
            sender=sender,
            content_preview=str(parsed.get("content", ""))[:80],
        )

        for handler in self._handlers[msg_type]:
            try:
                await handler(parsed)
            except Exception:
                logger.error(
                    "chat_handler_error",
                    msg_type=msg_type,
                    handler=handler.__name__,
                    exc_info=True,
                )
