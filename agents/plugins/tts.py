"""TTS plugin configuration.

Four providers. Kokoro is the default (self-hosted, free, local). All
OpenAI-compatible providers use LiveKit's openai.TTS plugin, varying
only by base_url/voice/model.
"""

from __future__ import annotations

import os
from typing import Any

import structlog
from livekit.plugins import openai as lk_openai

from agent_runtime.config import AgentSettings, get_agent_settings

logger = structlog.get_logger(__name__)


DEFAULT_KOKORO_BASE_URL = os.getenv("KOKORO_BASE_URL", "http://unicorn-kokoro:8880/v1")
DEFAULT_KOKORO_MODEL = os.getenv("KOKORO_MODEL", "kokoro")

# Per-agent Kokoro voice presets. Kokoro voice format: <accent><gender>_<name>.
# af = American female, am = American male, bf = British female, bm = British male.
KOKORO_VOICE_PRESETS: dict[str, str] = {
    "the-general": "am_michael",
    "gunny": "am_adam",
    "judge-advocate": "bm_lewis",
    "detective-holmes": "bm_daniel",
    "doc-medresearch": "af_nicole",
    "col-finance": "bm_lewis",
    "cpt-fullstack": "am_adam",
    "code-reviewer": "am_michael",
    "maj-devops": "am_michael",
    "sgt-cipher": "am_adam",
    "sgt-scribe": "af_bella",
    "prof-datasci": "af_bella",
    "sql-analyst": "af_bella",
    "lt-docanalyst": "af_nicole",
    "lt-taxstrat": "bm_lewis",
    "maj-leadgen": "af_bella",
    "support-agent": "af_bella",
    "evidence-correlator": "bm_daniel",
    "gap-analyzer": "bm_daniel",
    "timeline-builder": "bm_daniel",
    "triage": "am_michael",
    "default": "af_bella",
}


def _resolve_kokoro_voice(personality: str, explicit: str | None) -> str:
    if explicit:
        return explicit
    return KOKORO_VOICE_PRESETS.get(personality, KOKORO_VOICE_PRESETS["default"])


def get_tts_plugin(
    provider: str = "kokoro",
    *,
    settings: AgentSettings | None = None,
    personality: str = "default",
    voice_id: str | None = None,
    model: str | None = None,
) -> Any:
    cfg = settings or get_agent_settings()
    provider = provider.lower()

    if provider == "kokoro":
        voice = _resolve_kokoro_voice(personality, voice_id)
        tts = lk_openai.TTS(
            base_url=DEFAULT_KOKORO_BASE_URL,
            api_key="not-needed",
            model=model or DEFAULT_KOKORO_MODEL,
            voice=voice,
        )
        logger.info("tts_configured", provider="kokoro", voice=voice, personality=personality)
        return tts

    if provider == "elevenlabs":
        from livekit.plugins import elevenlabs
        if not cfg.elevenlabs_api_key:
            raise ValueError("ELEVENLABS_API_KEY is required for ElevenLabs TTS")
        tts = elevenlabs.TTS(
            api_key=cfg.elevenlabs_api_key,
            voice_id=voice_id or "pNInz6obpgDQGcFmaJgB",
        )
        logger.info("tts_configured", provider="elevenlabs", voice_id=voice_id)
        return tts

    if provider == "cartesia":
        from livekit.plugins import cartesia
        if not cfg.cartesia_api_key:
            raise ValueError("CARTESIA_API_KEY is required for Cartesia TTS")
        tts = cartesia.TTS(
            api_key=cfg.cartesia_api_key,
            voice=voice_id or "a0e99841-438c-4a64-b679-ae501e7d6091",
        )
        logger.info("tts_configured", provider="cartesia", voice=voice_id)
        return tts

    if provider == "openai":
        if not cfg.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required for openai TTS")
        tts = lk_openai.TTS(
            api_key=cfg.openai_api_key,
            model=model or "gpt-4o-mini-tts",
            voice=voice_id or "ash",
        )
        logger.info("tts_configured", provider="openai", voice=voice_id)
        return tts

    raise ValueError(f"Unsupported TTS provider: {provider}")
