"""BrigadeBackedAgent — Stable agent powered by any Brigade agent.

Reads `brigade_agent_id` from room metadata and acts as that Brigade
agent. All persona, memory, delegation, and tool intelligence comes
from Brigade; LiveKit handles voice, room presence, and (eventually)
video tracks.

Migrated to livekit-agents 1.5+ Agent + AgentSession API.
Voice path active when STT/TTS plugins are configured. Otherwise
text-only via the data-channel ChatHandler.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx
import structlog


def asyncio_now() -> float:
    """Monotonic seconds — for chunk-flush throttling."""
    return time.monotonic()


_ = asyncio  # keep import (used via httpx)
from livekit.agents import Agent, AgentSession, JobContext

from agent_runtime.base import StableAgent
from agent_runtime.brigade_llm import build_brigade_llm
from agent_runtime.config import AgentSettings, get_agent_settings

logger = structlog.get_logger(__name__)


class BrigadeBackedAgent(StableAgent):
    """Generic agent whose personality + tools + memory come from Brigade."""

    agent_type: str = "brigade"

    def __init__(self, settings: AgentSettings | None = None) -> None:
        super().__init__(settings)
        self._brigade_agent_id: str = "the-general"
        self._tts_provider: str = "kokoro"
        self._stt_provider: str = "whisper"
        self._session: AgentSession | None = None
        self._lk_agent: Agent | None = None

    async def on_message(self, message: dict[str, Any]) -> None:
        """Reply to a chat by streaming from Brigade and posting incrementally.

        Lifecycle:
            1. Emit "agent_typing: true" (UI shows "X is thinking…").
            2. POST an empty placeholder message to backend → get message_id.
            3. Stream Brigade's chat/completions, accumulating text.
            4. PATCH the placeholder ~every 200ms so the chat updates live.
            5. On completion, finalize PATCH and clear typing.
        """
        content = (message.get("content") or "").strip()
        if not content:
            return

        cfg = self._settings
        url = (cfg.brigade_base_url or "").rstrip("/") + "/chat/completions"
        if not cfg.brigade_base_url or not cfg.brigade_api_key:
            logger.warning("on_message_brigade_unconfigured")
            return

        user_id = self._human_user_id or self.identity

        # 1. Typing on
        await self._post_typing(True)

        # 2. Empty placeholder message (so we have an id to PATCH).
        msg_id = await self._post_chat_message("…")
        if not msg_id:
            await self._post_typing(False)
            return

        # 3 & 4. Stream chunks
        accumulated = ""
        last_flush = 0.0
        FLUSH_EVERY = 0.18  # seconds

        try:
            payload = {
                "model": self._brigade_agent_id,
                "messages": [{"role": "user", "content": content}],
                "user": user_id,
                "stream": True,
            }
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(120.0, connect=10.0)
            ) as http:
                async with http.stream(
                    "POST",
                    url,
                    headers={
                        "Authorization": f"Bearer {cfg.brigade_api_key}",
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream",
                    },
                    json=payload,
                ) as resp:
                    if resp.status_code >= 300:
                        text_err = (await resp.aread()).decode("utf-8", "replace")
                        logger.warning(
                            "brigade_stream_http_error",
                            status=resp.status_code,
                            body=text_err[:300],
                        )
                        accumulated = (
                            f"_(Brigade returned {resp.status_code}; "
                            "check backend logs.)_"
                        )
                    else:
                        async for line in resp.aiter_lines():
                            if not line or not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if data == "[DONE]":
                                break
                            try:
                                obj = json.loads(data)
                                delta = (
                                    obj.get("choices", [{}])[0]
                                    .get("delta", {})
                                    .get("content", "")
                                )
                            except Exception:
                                continue
                            if not delta:
                                continue
                            accumulated += delta
                            now = asyncio_now()
                            if now - last_flush >= FLUSH_EVERY:
                                await self._patch_chat_message(
                                    msg_id, accumulated, finalize=False
                                )
                                last_flush = now
        except Exception as exc:
            logger.error("brigade_stream_failed", error=str(exc), exc_info=True)
            if not accumulated:
                accumulated = (
                    f"_(I had trouble reaching Brigade: {exc.__class__.__name__})_"
                )

        # 5. Final flush + typing off
        if not accumulated.strip():
            accumulated = "_(empty reply)_"
        await self._patch_chat_message(msg_id, accumulated, finalize=True)
        await self._post_typing(False)
        logger.info(
            "brigade_reply",
            agent_id=self._brigade_agent_id,
            chars=len(accumulated),
        )

    async def _post_chat_message(self, content: str) -> str | None:
        """Persist a reply via the internal agent-messages endpoint.

        Returns the new message's id so callers can stream updates via
        _patch_chat_message.
        """
        secret = self._settings.livekit_api_secret
        if not secret:
            logger.warning("post_chat_no_secret")
            return None
        try:
            async with httpx.AsyncClient(
                base_url=self._settings.stable_backend_url,
                timeout=httpx.Timeout(30.0, connect=5.0),
            ) as http:
                resp = await http.post(
                    "/api/v1/internal/agent-messages",
                    headers={"Authorization": f"Bearer {secret}"},
                    json={
                        "livekit_room_name": self._room_name,
                        "brigade_agent_id": self._brigade_agent_id,
                        "content": content,
                    },
                )
                if resp.status_code >= 300:
                    logger.warning(
                        "post_chat_http_error",
                        status=resp.status_code,
                        body=resp.text[:300],
                    )
                    return None
                return (resp.json() or {}).get("id")
        except Exception:
            logger.error("post_chat_failed", exc_info=True)
            return None

    async def _patch_chat_message(
        self, message_id: str, content: str, finalize: bool
    ) -> None:
        """Stream-update an existing agent message in place."""
        secret = self._settings.livekit_api_secret
        if not secret:
            return
        try:
            async with httpx.AsyncClient(
                base_url=self._settings.stable_backend_url,
                timeout=httpx.Timeout(15.0, connect=5.0),
            ) as http:
                resp = await http.patch(
                    f"/api/v1/internal/agent-messages/{message_id}",
                    headers={"Authorization": f"Bearer {secret}"},
                    json={"content": content, "finalize": finalize},
                )
                if resp.status_code >= 300:
                    logger.debug(
                        "patch_chat_http_error",
                        status=resp.status_code,
                        body=resp.text[:200],
                    )
        except Exception:
            logger.debug("patch_chat_failed", exc_info=True)

    async def _post_typing(self, typing: bool) -> None:
        """Broadcast a typing/working indicator over LiveKit data."""
        secret = self._settings.livekit_api_secret
        if not secret:
            return
        try:
            async with httpx.AsyncClient(
                base_url=self._settings.stable_backend_url,
                timeout=httpx.Timeout(10.0, connect=5.0),
            ) as http:
                await http.post(
                    "/api/v1/internal/agent-typing",
                    headers={"Authorization": f"Bearer {secret}"},
                    json={
                        "livekit_room_name": self._room_name,
                        "brigade_agent_id": self._brigade_agent_id,
                        "typing": typing,
                    },
                )
        except Exception:
            logger.debug("typing_post_failed", exc_info=True)

    async def build_pipeline(self, ctx: JobContext) -> Any:
        """Build the LiveKit Agent + AgentSession.

        Voice plugins (STT/TTS) come in only when configured. Otherwise the
        Agent is built LLM-only and chat is text-only via ChatHandler.

        Returns the AgentSession (which has .start(...)) so the base class can
        treat it the same way it treated VoicePipelineAgent before — we shim
        a .start(room) interface.
        """
        cfg = self._settings

        brigade_agent_id = self._resolve_brigade_agent_id(ctx)
        self._brigade_agent_id = brigade_agent_id
        user_id = self._human_user_id or self.identity
        model_override = self._resolve_model_override(ctx)

        llm_plugin = build_brigade_llm(
            cfg,
            brigade_agent_id=brigade_agent_id,
            user_id=user_id,
            model_override=model_override,
        )

        # Optional voice plugins
        stt_plugin = None
        tts_plugin = None
        try:
            from plugins.stt import get_stt_plugin
            stt_plugin = get_stt_plugin(self._stt_provider, settings=cfg)
        except Exception as e:
            logger.info("brigade_backed_no_stt", reason=str(e))
        try:
            from plugins.tts import get_tts_plugin
            tts_plugin = get_tts_plugin(self._tts_provider, personality=brigade_agent_id, settings=cfg)
        except Exception as e:
            logger.info("brigade_backed_no_tts", reason=str(e))

        agent_kwargs: dict[str, Any] = {
            "instructions": (
                f"You are acting as {brigade_agent_id} — a Unicorn Brigade agent. "
                "All persona, retrieved memory, and any tool decisions are returned "
                "by the upstream Brigade backend; you only need to relay its responses."
            ),
            "llm": llm_plugin,
        }
        if stt_plugin is not None:
            agent_kwargs["stt"] = stt_plugin
            # Whisper-compat STT plugins don't stream; livekit-agents requires a
            # VAD to slice audio into utterances before hitting STT.
            try:
                from livekit.plugins import silero
                agent_kwargs["vad"] = silero.VAD.load()
            except Exception as e:
                logger.info("brigade_backed_no_vad", reason=str(e))
        if tts_plugin is not None:
            agent_kwargs["tts"] = tts_plugin

        self._lk_agent = Agent(**agent_kwargs)

        session = AgentSession()
        self._session = session

        # Shim: provide start(room) the way the old VoicePipelineAgent did, so
        # base.py's existing `self._pipeline.start(ctx.room)` call works.
        async def _start(room):
            await session.start(agent=self._lk_agent, room=room)

        # Bind the shim onto the session object
        session.start_room = _start  # type: ignore[attr-defined]

        logger.info(
            "brigade_backed_session_built",
            brigade_agent_id=brigade_agent_id,
            user_id=user_id,
            model_override=model_override,
            has_stt=stt_plugin is not None,
            has_tts=tts_plugin is not None,
        )
        return session

    def _resolve_brigade_agent_id(self, ctx: JobContext) -> str:
        # Prefer the DISPATCH (job) metadata — it reliably carries
        # brigade_agent_id; room metadata can be empty/stale when the room is
        # freshly created (same lesson as the registry agent_type resolution).
        candidates = [
            getattr(getattr(ctx, "job", None), "metadata", "") or "",
            getattr(ctx.room, "metadata", "") or "",
        ]
        for meta_raw in candidates:
            if not meta_raw:
                continue
            try:
                meta = json.loads(meta_raw)
            except (ValueError, TypeError):
                continue
            if isinstance(meta, dict) and meta.get("brigade_agent_id"):
                return str(meta["brigade_agent_id"])
        return "the-general"

    def _resolve_model_override(self, ctx: JobContext) -> str | None:
        # Per-conversation LLM override (model switcher), carried on the same
        # dispatch/room metadata as brigade_agent_id. None → persona default.
        candidates = [
            getattr(getattr(ctx, "job", None), "metadata", "") or "",
            getattr(ctx.room, "metadata", "") or "",
        ]
        for meta_raw in candidates:
            if not meta_raw:
                continue
            try:
                meta = json.loads(meta_raw)
            except (ValueError, TypeError):
                continue
            if isinstance(meta, dict) and meta.get("model_override"):
                return str(meta["model_override"])
        return None
