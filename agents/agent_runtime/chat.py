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
        room.on("data_received", self._on_data_received)
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

        sender: str = parsed.get("sender", "")
        if sender == self._agent_identity:
            return  # ignore own messages

        raw_type: str = parsed.get("type", "")
        try:
            msg_type = MessageType(raw_type)
        except ValueError:
            logger.warning("chat_unknown_type", raw_type=raw_type)
            return

        logger.debug(
            "chat_received",
            msg_type=msg_type,
            sender=sender,
            content_length=len(parsed.get("content", "")),
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
