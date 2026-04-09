from __future__ import annotations

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Database
    database_url: str = "postgresql+asyncpg://stable:stable@localhost:5432/stable"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # LiveKit
    livekit_url: str = "ws://localhost:7880"
    livekit_api_url: str = "http://localhost:7880"
    livekit_api_key: str = "APIStable2026"
    livekit_api_secret: str = "stable_secret_change_in_production_2026"

    # Keycloak
    keycloak_url: str = "http://localhost:8080"
    keycloak_realm: str = "stable"
    keycloak_client_id: str = "stable-backend"
    keycloak_client_secret: str = ""

    # CORS
    cors_origins: list[str] = ["http://localhost:3000"]

    # Application
    log_level: str = "info"
    environment: str = "development"
    port: int = 8400

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v: str | list[str]) -> list[str]:
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
