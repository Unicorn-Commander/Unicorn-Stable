"""STT plugin configuration — Deepgram Nova-2 with fallback."""

from __future__ import annotations

from typing import Any

import structlog
from livekit.plugins import deepgram

from agent_runtime.config import AgentSettings, get_agent_settings

logger = structlog.get_logger(__name__)


def get_stt_plugin(
    provider: str = "deepgram",
    *,
    settings: AgentSettings | None = None,
    language: str = "en-US",
    smart_format: bool = True,
    punctuate: bool = True,
    diarize: bool = False,
    model: str = "nova-2",
    interim_results: bool = True,
) -> Any:
    """Return a configured STT plugin instance.

    Args:
        provider: STT provider to use. Currently only ``"deepgram"`` is supported.
        settings: Agent settings (auto-loaded if not provided).
        language: BCP-47 language code.
        smart_format: Enable Deepgram smart formatting.
        punctuate: Enable automatic punctuation.
        diarize: Enable speaker diarization.
        model: Deepgram model name.
        interim_results: Stream partial transcription results.

    Returns:
        A configured LiveKit STT plugin ready for VoicePipelineAgent.
    """
    cfg = settings or get_agent_settings()

    if provider == "deepgram":
        if not cfg.deepgram_api_key:
            raise ValueError("DEEPGRAM_API_KEY is required for Deepgram STT")

        stt = deepgram.STT(
            api_key=cfg.deepgram_api_key,
            model=model,
            language=language,
            smart_format=smart_format,
            punctuate=punctuate,
            diarize=diarize,
            interim_results=interim_results,
        )
        logger.info(
            "stt_configured",
            provider=provider,
            model=model,
            language=language,
        )
        return stt

    raise ValueError(f"Unsupported STT provider: {provider}")
