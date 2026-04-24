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

import json
from typing import Any

import structlog
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

        llm_plugin = build_brigade_llm(
            cfg,
            brigade_agent_id=brigade_agent_id,
            user_id=user_id,
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
            has_stt=stt_plugin is not None,
            has_tts=tts_plugin is not None,
        )
        return session

    def _resolve_brigade_agent_id(self, ctx: JobContext) -> str:
        meta_raw: str = getattr(ctx.room, "metadata", "") or ""
        if not meta_raw:
            return "the-general"
        try:
            meta = json.loads(meta_raw)
        except (ValueError, TypeError):
            return "the-general"
        return str(meta.get("brigade_agent_id") or "the-general")
