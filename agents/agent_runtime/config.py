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

    # Stable backend (FastAPI service)
    stable_backend_url: str = "http://localhost:8400"

    # Redis (uses DB 1 to avoid collision with the backend on DB 0)
    redis_url: str = "redis://localhost:6379/1"

    # AI provider keys
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    openrouter_api_key: str = ""

    # Voice pipeline keys
    deepgram_api_key: str = ""
    elevenlabs_api_key: str = ""
    cartesia_api_key: str = ""

    # Logging
    log_level: str = "INFO"

    # Agent worker
    worker_num_idle: int = 3
    worker_max_retry: int = 5
    worker_retry_delay_seconds: float = 2.0

    # Rate limiting defaults
    rate_limit_messages_per_minute: int = 60
    rate_limit_tool_calls_per_minute: int = 30

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, v: str) -> str:
        return v.upper()


@lru_cache(maxsize=1)
def get_agent_settings() -> AgentSettings:
    return AgentSettings()
