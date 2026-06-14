"""StableAgent — base class for all Stable platform AI agents."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
import structlog
from livekit import rtc
from livekit.agents import AgentSession, JobContext, llm, utils

from agent_runtime.chat import ChatHandler, MessageType
from agent_runtime.config import AgentSettings, get_agent_settings
from agent_runtime.stage import StageTrack
from agent_runtime.tools import ToolRegistry

logger = structlog.get_logger(__name__)


class _RateLimiter:
    """Simple token-bucket rate limiter."""

    def __init__(self, max_per_minute: int) -> None:
        self._max: int = max_per_minute
        self._tokens: float = float(max_per_minute)
        self._last_refill: float = time.monotonic()
        self._lock: asyncio.Lock = asyncio.Lock()

    async def acquire(self) -> bool:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill
            self._tokens = min(
                float(self._max),
                self._tokens + elapsed * (self._max / 60.0),
            )
            self._last_refill = now

            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False


class StableAgent:
    """Base class that all Stable agents extend.

    Wraps a LiveKit AgentSession, manages agent identity, connection lifecycle,
    tools, stage video track, data-channel chat, and audit logging.

    Subclasses MUST override:
        - ``agent_type`` (class variable)
        - ``build_pipeline(ctx)`` to return a configured AgentSession
    """

    agent_type: str = "base"
    system_prompt: str = "You are a helpful AI agent on the Stable platform."
    # Optional: the Brigade agent this Stable agent routes through. Subclasses
    # set this when they act as a Brigade-backed agent (persona + memory come
    # from Brigade instead of being inline on the Stable side).
    brigade_agent_id: str | None = None

    def __init__(self, settings: AgentSettings | None = None) -> None:
        self._settings: AgentSettings = settings or get_agent_settings()
        self._identity: str = ""
        self._agent_token: str = ""
        self._room_id: str = ""
        self._room_name: str = ""
        # Captured from the first human participant in the room — used as the
        # user_id on Brigade requests so memory is isolated to the real human.
        self._human_user_id: str | None = None

        self.tools: ToolRegistry = ToolRegistry(
            backend_url=self._settings.stable_backend_url,
        )
        self.stage: StageTrack = StageTrack()
        self.chat: ChatHandler | None = None

        self._pipeline: AgentSession | None = None
        self._job_ctx: JobContext | None = None
        self._http: httpx.AsyncClient | None = None
        self._msg_limiter = _RateLimiter(self._settings.rate_limit_messages_per_minute)
        self._tool_limiter = _RateLimiter(self._settings.rate_limit_tool_calls_per_minute)
        self._running: bool = False

    # ---------- identity ----------

    @property
    def identity(self) -> str:
        return self._identity

    @property
    def room_id(self) -> str:
        return self._room_id

    # ---------- lifecycle ----------

    async def start(self, ctx: JobContext) -> None:
        """Called by the registry when a job is dispatched. Orchestrates the full lifecycle."""
        self._job_ctx = ctx
        self._room_name = ctx.room.name
        self._running = True

        logger.info(
            "agent_starting",
            agent_type=self.agent_type,
            room=self._room_name,
        )

        # 1. Obtain agent identity and token from the backend
        await self._acquire_identity()

        # 1b. Capture the human user_id from the room so Brigade memory is
        #     scoped to the real human, not the agent. Humans' participant
        #     identity is their Keycloak `sub` (per the backend's LiveKit
        #     token minting). Agents' identities start with "agent-".
        try:
            for p in ctx.room.remote_participants.values():
                pid = getattr(p, "identity", "") or ""
                if pid and not pid.startswith("agent-"):
                    self._human_user_id = pid
                    break
        except Exception:
            logger.debug("human_user_id_capture_failed", exc_info=True)

        # 2. Initialize subsystems
        self.tools = ToolRegistry(
            agent_token=self._agent_token,
            backend_url=self._settings.stable_backend_url,
        )
        await self.tools.start()

        self.chat = ChatHandler(
            agent_identity=self._identity,
            backend_url=self._settings.stable_backend_url,
            agent_token=self._agent_token,
            room_id=self._room_id,
        )
        await self.chat.start(ctx.room)

        # Register default chat handler
        self.chat.on(MessageType.CHAT, self._handle_chat_message)
        self.chat.on(MessageType.COMMAND, self._handle_command_message)
        self.chat.on(MessageType.ACTION_REQUEST, self._handle_action_request)

        # 3. Start stage track
        try:
            await self.stage.start(ctx.room)
        except Exception:
            logger.warning("stage_track_init_failed", exc_info=True)

        # 4. Build and connect the voice pipeline
        self._pipeline = await self.build_pipeline(ctx)

        if self._pipeline is not None:
            # livekit-agents 1.5: build_pipeline returns an AgentSession exposing
            # a start_room(room) shim that calls AgentSession.start(agent=, room=).
            # The session drives STT -> LLM -> TTS and in-room media itself.
            if hasattr(self._pipeline, "start_room"):
                await self._pipeline.start_room(ctx.room)
            else:
                logger.warning(
                    "pipeline_missing_start_room",
                    pipeline_type=type(self._pipeline).__name__,
                )

        # 5. Log the run to the backend
        await self._log_agent_event("agent_started", {"room": self._room_name})

        logger.info(
            "agent_started",
            agent_type=self.agent_type,
            identity=self._identity,
            room=self._room_name,
        )

        # 6. Keep alive until the job context shuts down
        ctx.add_shutdown_callback(self._on_shutdown)

    async def _on_shutdown(self) -> None:
        """Graceful cleanup when the job ends."""
        self._running = False
        logger.info("agent_shutting_down", identity=self._identity, room=self._room_name)

        await self._log_agent_event("agent_stopped", {"room": self._room_name})

        if self.chat is not None:
            await self.chat.shutdown()
        await self.stage.stop()
        await self.tools.shutdown()

        if self._http is not None:
            await self._http.aclose()
            self._http = None

        logger.info("agent_stopped", identity=self._identity)

    # ---------- subclass hooks ----------

    async def build_pipeline(self, ctx: JobContext) -> AgentSession | None:
        """Subclasses override this to return a configured AgentSession.

        The returned session must expose a ``start_room(room)`` coroutine (see
        BrigadeBackedAgent / TriageAgent). Return None if this agent is
        text-only (no in-room voice/media).
        """
        raise NotImplementedError("Subclasses must implement build_pipeline()")

    async def on_message(self, message: dict[str, Any]) -> None:
        """Called when a chat message is received. Override in subclasses."""
        logger.debug("on_message_default", content_length=len(message.get("content", "")))

    async def on_user_speech(self, text: str) -> None:
        """Called when user speech is transcribed. Override in subclasses."""
        logger.debug("on_user_speech_default", text_length=len(text))

    async def on_function_call(self, name: str, args: dict[str, Any]) -> Any:
        """Called when the LLM requests a function/tool call. Override in subclasses."""
        return await self.tools.execute(name, args)

    # ---------- internal event wiring ----------

    async def _handle_chat_message(self, message: dict[str, Any]) -> None:
        # When the Stable backend owns text replies (default), the voice
        # agent stays silent on the data-channel chat to avoid double
        # responses. The text path lives in
        # server/app/services/agent_chat_responder.py. Set
        # STABLE_TEXT_PATH_OWNS_CHAT=false to fall back to the legacy
        # voice-agent-replies-to-text behavior.
        import os as _os_text_gate
        if _os_text_gate.environ.get(
            "STABLE_TEXT_PATH_OWNS_CHAT", "true"
        ).lower() in ("1", "true", "yes"):
            return

        if not await self._msg_limiter.acquire():
            logger.warning("rate_limited_message", identity=self._identity)
            return

        # Only respond when explicitly @mentioned OR when the room is a DM
        # (one human + one agent). This prevents agents from talking over each
        # other in multi-agent rooms and stops them from replying to every
        # human message. Mention format is @<agent_id> or @<display_name>.
        content = (message.get("content") or "").strip()
        sender_type = (message.get("sender_type") or message.get("senderType") or "").lower()
        if sender_type == "agent":
            # Don't chain-react to other agents
            return

        # In a DM, treat every human message as addressed to the agent —
        # the room IS the conversation. Channels still require an explicit
        # @mention so multiple agents don't all chime in.
        room_type = (message.get("room_type") or "channel").lower()
        is_dm = room_type in ("dm", "group_dm")
        mentioned = is_dm or self._is_mentioned(content)
        logger.info(
            "agent_mention_check",
            identity=self._identity,
            room=self._room_name,
            room_type=room_type,
            content_preview=content[:80],
            mentioned=mentioned,
            brigade_agent_id=getattr(self, "_brigade_agent_id", None),
            agent_type=self.agent_type,
        )
        if not mentioned:
            return

        await self.on_message(message)

    def _is_mentioned(self, content: str) -> bool:
        """True if this agent is addressed in the message.

        Matches ``@<agent_type>`` or ``@<brigade_agent_id>`` (case-insensitive),
        or bare ``@everyone``/``@all``. Overridden by subclasses to add the
        specific persona name (e.g. ``@col-finance``).
        """
        if not content:
            return False
        lc = content.lower()
        if "@everyone" in lc or "@all" in lc:
            return True
        needles = {self.agent_type.lower()}
        brigade_id = getattr(self, "_brigade_agent_id", None)
        if brigade_id:
            needles.add(str(brigade_id).lower())
            needles.add(str(brigade_id).replace("-", " ").lower())
        return any(f"@{n}" in lc for n in needles if n)

    async def _handle_command_message(self, message: dict[str, Any]) -> None:
        content = message.get("content", "")
        logger.info("command_received", content=content, identity=self._identity)

    async def _handle_action_request(self, message: dict[str, Any]) -> None:
        meta = message.get("meta", {})
        action = message.get("content", "")
        params = meta.get("params", {})
        logger.info("action_request_received", action=action, identity=self._identity)

        if not await self._tool_limiter.acquire():
            logger.warning("rate_limited_tool", identity=self._identity, action=action)
            if self.chat is not None:
                await self.chat.send_action_response(
                    action,
                    "Rate limited -- try again shortly",
                    success=False,
                )
            return

        try:
            result = await self.on_function_call(action, params)
            if self.chat is not None:
                await self.chat.send_action_response(action, result, success=True)
        except Exception as exc:
            logger.error("action_request_failed", action=action, exc_info=True)
            if self.chat is not None:
                await self.chat.send_action_response(
                    action,
                    str(exc),
                    success=False,
                )

    def _on_user_speech_committed(self, ev: Any) -> None:
        """Bridge the synchronous LiveKit event into our async handler."""
        text: str = getattr(ev, "text", "") or ""
        if text.strip():
            asyncio.create_task(self._safe_on_user_speech(text))

    async def _safe_on_user_speech(self, text: str) -> None:
        try:
            await self.on_user_speech(text)
        except Exception:
            logger.error("on_user_speech_error", exc_info=True)

    def _on_function_calls_collected(self, ev: Any) -> None:
        """Bridge function call events into our async handler."""
        calls: list[Any] = getattr(ev, "function_calls", [])
        for call in calls:
            name: str = getattr(call, "name", "")
            raw_args: str = getattr(call, "arguments", "{}")
            import json

            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError:
                args = {"raw": raw_args}
            asyncio.create_task(self._safe_on_function_call(name, args))

    async def _safe_on_function_call(self, name: str, args: dict[str, Any]) -> None:
        if not await self._tool_limiter.acquire():
            logger.warning("rate_limited_tool_call", tool=name, identity=self._identity)
            return
        try:
            await self._log_agent_event("tool_call", {"tool": name, "args": args})
            result = await self.on_function_call(name, args)
            await self._log_agent_event("tool_result", {"tool": name, "success": True})
        except Exception:
            logger.error("function_call_error", tool=name, exc_info=True)
            await self._log_agent_event(
                "tool_result",
                {"tool": name, "success": False},
            )

    # ---------- backend communication ----------

    @property
    def _backend_http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                base_url=self._settings.stable_backend_url,
                timeout=httpx.Timeout(15.0, connect=5.0),
            )
        return self._http

    async def _acquire_identity(self) -> None:
        """Request an agent identity and JWT from the Stable backend."""
        try:
            resp = await self._backend_http.post(
                "/api/agents/register",
                json={
                    "agent_type": self.agent_type,
                    "room_name": self._room_name,
                },
            )
            resp.raise_for_status()
            body = resp.json()
            self._identity = body["identity"]
            self._agent_token = body["token"]
            self._room_id = body.get("room_id", self._room_name)
            logger.info(
                "agent_identity_acquired",
                identity=self._identity,
                room_id=self._room_id,
            )
        except Exception:
            # Fall back to a generated identity if the backend is unreachable
            self._identity = f"agent-{self.agent_type}-{id(self) & 0xFFFF:04x}"
            self._agent_token = ""
            self._room_id = self._room_name
            logger.warning(
                "agent_identity_fallback",
                identity=self._identity,
                exc_info=True,
            )

    async def _log_agent_event(self, event: str, data: dict[str, Any]) -> None:
        """Send an audit event to the Stable backend."""
        try:
            await self._backend_http.post(
                "/api/agents/events",
                json={
                    "agent_identity": self._identity,
                    "agent_type": self.agent_type,
                    "event": event,
                    "data": data,
                    "room_id": self._room_id,
                },
                headers=(
                    {"Authorization": f"Bearer {self._agent_token}"}
                    if self._agent_token
                    else {}
                ),
            )
        except Exception:
            logger.debug("audit_log_failed", event=event, exc_info=True)
