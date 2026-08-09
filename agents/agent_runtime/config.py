"""Pydantic Settings for the Stable agent runtime."""

from __future__ import annotations

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AgentSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # LiveKit connection
    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "APIStable2026"
    livekit_api_secret: str = "stable_secret_change_in_production_2026"

    # Bearer for Stable's /api/v1/internal/* routes. Split out from the
    # LiveKit token secret so a leak of one doesn't compromise the other.
    # Falls back to livekit_api_secret only when unset (migration safety).
    internal_agent_secret: str = ""

    # Stable backend (FastAPI service)
    stable_backend_url: str = "http://localhost:8400"

    # Redis (uses DB 1 to avoid collision with the backend on DB 0)
    redis_url: str = "redis://localhost:6379/1"

    # AI provider keys
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    openrouter_api_key: str = ""

    # Unicorn Brigade — primary LLM/agent backend. When configured, agents
    # route LLM calls through Brigade's OpenAI-compat adapter, inheriting
    # Brigade's persona + memory + delegation pipeline.
    brigade_base_url: str = "https://brigade.magicunicorn.dev/api/v1/openai/v1"
    brigade_api_key: str = ""

    # Voice pipeline keys
    deepgram_api_key: str = ""
    elevenlabs_api_key: str = ""
    cartesia_api_key: str = ""

    # Self-hosted voice services over Tailscale (reachable from the stable-agents
    # container via the host tailnet). Override per-deploy.
    # Amanuensis STT (uc-1) is OpenAI-compatible (/v1/audio/transcriptions);
    # Kokoro TTS (midboy2 GPU, GTX 1070) is OpenAI-compatible and driven by
    # plugins/tts.py:OratorTTS.
    whisper_base_url: str = "http://100.78.236.160:9000/v1"
    whisper_model: str = "whisper-1"
    kokoro_base_url: str = "http://100.66.42.57:8880"

    # Logging
    log_level: str = "INFO"

    # Agent worker
    worker_num_idle: int = 3
    worker_max_retry: int = 5
    worker_retry_delay_seconds: float = 2.0

    # Rate limiting defaults
    rate_limit_messages_per_minute: int = 60
    rate_limit_tool_calls_per_minute: int = 30

    # Browser-STT fallback ears (agent_runtime/voice_transcripts.py). The web
    # client captions each human's local mic and publishes `transcript` data
    # messages; when the worker's own STT plugin is silent, grouped finals are
    # fed into AgentSession.generate_reply so the agent still hears calls.
    voice_transcript_replies_enabled: bool = True
    # Quiet gap that closes one grouped utterance (mid-thought pauses shorter
    # than this do NOT produce a second reply).
    voice_transcript_group_window_seconds: float = 1.5
    # Extra wait before answering when our OWN STT plugin is configured, so a
    # slow-but-alive plugin final wins the race instead of double-replying.
    # Set to 0 to answer at the group window when STT is known dead.
    voice_transcript_stt_grace_seconds: float = 2.0
    # Recency window: any user_input_transcribed activity newer than this means
    # the session's own ears work and the browser fallback stands down.
    voice_transcript_stt_alive_seconds: float = 12.0

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, v: str) -> str:
        return v.upper()


@lru_cache(maxsize=1)
def get_agent_settings() -> AgentSettings:
    return AgentSettings()
