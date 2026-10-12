"""STT plugin configuration.

Providers via a unified OpenAI-compatible interface:

- ``whisper`` (default) — an optional self-hosted OpenAI-compatible
  transcription endpoint from ``WHISPER_BASE_URL``. Its single loaded model
  may ignore the ``model`` field, so ``WHISPER_MODEL`` defaults to the harmless
  ``whisper-1``.
- ``deepgram`` — Nova-2 cloud (needs DEEPGRAM_API_KEY).
- ``openai`` — OpenAI hosted transcription (needs OPENAI_API_KEY).
"""

from __future__ import annotations

import os
from typing import Any

import structlog
from livekit.plugins import openai as lk_openai

from agent_runtime.config import AgentSettings, get_agent_settings

logger = structlog.get_logger(__name__)


# Empty keeps the optional local provider off until an endpoint is supplied.
DEFAULT_WHISPER_BASE_URL = os.getenv("WHISPER_BASE_URL", "").strip()
# Amanuensis runs its single loaded NPU model regardless of this value; keep the
# OpenAI-conventional default so any OpenAI-compatible client validates.
DEFAULT_WHISPER_MODEL = os.getenv("WHISPER_MODEL", "whisper-1")


def get_stt_plugin(
    provider: str = "whisper",
    *,
    settings: AgentSettings | None = None,
    language: str = "en",
    model: str | None = None,
) -> Any:
    cfg = settings or get_agent_settings()
    provider = provider.lower()

    if provider == "whisper":
        # Re-read env at call time so config changes take effect without a
        # module reload (the worker spawns a fresh subprocess per job).
        base_url = cfg_get(cfg, "whisper_base_url") or DEFAULT_WHISPER_BASE_URL
        if not base_url:
            raise ValueError("WHISPER_BASE_URL is required for whisper STT")
        stt = lk_openai.STT(
            base_url=base_url,
            api_key="not-needed",
            model=model or cfg_get(cfg, "whisper_model") or DEFAULT_WHISPER_MODEL,
            language=language,
        )
        logger.info(
            "stt_configured",
            provider="whisper",
            base_url=base_url,
            model=model or cfg_get(cfg, "whisper_model") or DEFAULT_WHISPER_MODEL,
        )
        return stt

    if provider == "deepgram":
        from livekit.plugins import deepgram
        if not cfg.deepgram_api_key:
            raise ValueError("DEEPGRAM_API_KEY is required for Deepgram STT")
        stt = deepgram.STT(
            api_key=cfg.deepgram_api_key,
            model=model or "nova-2",
            language=language,
        )
        logger.info("stt_configured", provider="deepgram", model=model or "nova-2")
        return stt

    if provider == "openai":
        if not cfg.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required for openai STT")
        stt = lk_openai.STT(
            api_key=cfg.openai_api_key,
            model=model or "gpt-4o-mini-transcribe",
            language=language,
        )
        logger.info("stt_configured", provider="openai", model=model or "gpt-4o-mini-transcribe")
        return stt

    raise ValueError(f"Unsupported STT provider: {provider}")


def cfg_get(cfg: AgentSettings, name: str) -> str | None:
    """Read an optional setting that may not exist on older config objects."""
    return getattr(cfg, name, None) or None
