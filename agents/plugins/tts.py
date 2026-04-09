"""TTS plugin configuration — ElevenLabs (primary), Cartesia (fallback)."""

from __future__ import annotations

from typing import Any

import structlog
from livekit.plugins import cartesia, elevenlabs

from agent_runtime.config import AgentSettings, get_agent_settings

logger = structlog.get_logger(__name__)


# Presets map agent personality names to provider-specific voice IDs.
VOICE_PRESETS: dict[str, dict[str, str]] = {
    "triage": {
        "elevenlabs": "pNInz6obpgDQGcFmaJgB",  # Adam
        "cartesia": "a0e99841-438c-4a64-b679-ae501e7d6091",  # Barbershop Man
    },
    "analyst": {
        "elevenlabs": "ErXwobaYiN019PkySvjV",  # Antoni
        "cartesia": "f114a467-c40a-4db8-964d-aaba89cd08fa",  # Reading Man
    },
    "commander": {
        "elevenlabs": "VR6AewLTigWG4xSOukaG",  # Arnold
        "cartesia": "87748186-23bb-4571-91d0-4eb3e052ed0f",  # Confident Man
    },
    "default": {
        "elevenlabs": "pNInz6obpgDQGcFmaJgB",
        "cartesia": "a0e99841-438c-4a64-b679-ae501e7d6091",
    },
}


def _resolve_voice_id(provider: str, voice_id: str | None, personality: str) -> str:
    """Resolve voice_id: explicit > preset > default."""
    if voice_id:
        return voice_id
    preset = VOICE_PRESETS.get(personality, VOICE_PRESETS["default"])
    return preset.get(provider, preset.get("elevenlabs", ""))


def get_tts_plugin(
    provider: str = "elevenlabs",
    *,
    voice_id: str | None = None,
    personality: str = "default",
    settings: AgentSettings | None = None,
    stability: float = 0.5,
    similarity_boost: float = 0.75,
    speed: float = 1.0,
) -> Any:
    """Return a configured TTS plugin instance.

    Args:
        provider: ``"elevenlabs"`` (primary) or ``"cartesia"`` (fallback).
        voice_id: Explicit voice ID. If None, resolved from ``personality`` presets.
        personality: Agent personality key used to look up a voice preset.
        settings: Agent settings (auto-loaded if not provided).
        stability: ElevenLabs stability parameter (0.0-1.0).
        similarity_boost: ElevenLabs similarity boost (0.0-1.0).
        speed: Playback speed multiplier.

    Returns:
        A configured LiveKit TTS plugin ready for VoicePipelineAgent.
    """
    cfg = settings or get_agent_settings()
    resolved_voice = _resolve_voice_id(provider, voice_id, personality)

    if provider == "elevenlabs":
        if not cfg.elevenlabs_api_key:
            logger.warning("elevenlabs_key_missing, falling back to cartesia")
            return get_tts_plugin(
                "cartesia",
                voice_id=voice_id,
                personality=personality,
                settings=cfg,
                speed=speed,
            )

        tts = elevenlabs.TTS(
            api_key=cfg.elevenlabs_api_key,
            voice_id=resolved_voice,
            model="eleven_turbo_v2_5",
            stability=stability,
            similarity_boost=similarity_boost,
            speed=speed,
        )
        logger.info(
            "tts_configured",
            provider=provider,
            voice_id=resolved_voice,
            model="eleven_turbo_v2_5",
        )
        return tts

    if provider == "cartesia":
        if not cfg.cartesia_api_key:
            raise ValueError(
                "No TTS provider available: both ELEVENLABS_API_KEY and CARTESIA_API_KEY are missing"
            )

        resolved_voice = _resolve_voice_id("cartesia", voice_id, personality)
        tts = cartesia.TTS(
            api_key=cfg.cartesia_api_key,
            voice_id=resolved_voice,
            model="sonic-2",
            speed=speed,
        )
        logger.info(
            "tts_configured",
            provider=provider,
            voice_id=resolved_voice,
            model="sonic-2",
        )
        return tts

    raise ValueError(f"Unsupported TTS provider: {provider}")
