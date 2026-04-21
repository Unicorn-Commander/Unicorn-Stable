"""BrigadeBackedAgent — a Stable agent whose persona/memory/tools live in Brigade.

When dispatched, it reads which Brigade agent to act as from the room metadata
(field: `brigade_agent_id`). Everything the LLM sees — persona, retrieved
memory, available tools — comes from Brigade. The LiveKit side just handles
the voice + room presence.

This is what makes the 20 Brigade agents usable inside Stable rooms without
needing 20 separate Python classes.
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from livekit.agents import JobContext
# VoicePipelineAgent removed in livekit-agents 1.5; use AgentSession for voice
try:
    from livekit.agents.pipeline import VoicePipelineAgent  # type: ignore
except ImportError:
    VoicePipelineAgent = None  # type: ignore
from livekit.plugins import silero

from agent_runtime.base import StableAgent
from agent_runtime.brigade_llm import build_brigade_llm
from agent_runtime.config import AgentSettings, get_agent_settings
from plugins.stt import get_stt_plugin
from plugins.tts import get_tts_plugin

logger = structlog.get_logger(__name__)


class BrigadeBackedAgent(StableAgent):
    """Generic agent whose personality + tools + memory come from Brigade."""

    agent_type: str = "brigade"

    def __init__(self, settings: AgentSettings | None = None) -> None:
        super().__init__(settings)
        # These get set during start() once we read room metadata
        self._brigade_agent_id: str = "the-general"
        self._tts_provider: str = "elevenlabs"
        self._stt_provider: str = "deepgram"

    async def build_pipeline(self, ctx: JobContext) -> VoicePipelineAgent:
        cfg = self._settings

        # Read which Brigade agent to act as from room metadata.
        brigade_agent_id = self._resolve_brigade_agent_id(ctx)
        self._brigade_agent_id = brigade_agent_id
        # StableAgent._human_user_id is populated by the base class in start()
        user_id = self._human_user_id or self.identity

        llm_plugin = build_brigade_llm(
            cfg,
            brigade_agent_id=brigade_agent_id,
            user_id=user_id,
        )

        vad = silero.VAD.load()
        stt = get_stt_plugin(self._stt_provider, settings=cfg)
        tts = get_tts_plugin(self._tts_provider, personality=brigade_agent_id, settings=cfg)

        pipeline = VoicePipelineAgent(
            vad=vad,
            stt=stt,
            llm=llm_plugin,
            tts=tts,
            fnc_ctx=self.tools.to_function_context(),
        )
        logger.info(
            "brigade_backed_pipeline_built",
            brigade_agent_id=brigade_agent_id,
            user_id=user_id,
            has_voice=True,
        )
        return pipeline

    def _resolve_brigade_agent_id(self, ctx: JobContext) -> str:
        """Read brigade_agent_id from room metadata, default to the-general."""
        meta_raw: str = getattr(ctx.room, "metadata", "") or ""
        if not meta_raw:
            return "the-general"
        try:
            meta = json.loads(meta_raw)
        except (ValueError, TypeError):
            return "the-general"
        return str(meta.get("brigade_agent_id") or "the-general")
