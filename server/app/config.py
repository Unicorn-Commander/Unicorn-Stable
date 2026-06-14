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
    # livekit_url: internal URL the backend uses for server-side API calls
    # (room create/delete, webhooks, agent dispatch). Usually a Docker hostname.
    # livekit_public_url: URL handed to browser clients inside token responses.
    # Must be reachable from the user's browser (WSS). Falls back to livekit_url
    # if not set so dev/local deployments keep working.
    livekit_url: str = "ws://localhost:7880"
    livekit_public_url: str = ""
    livekit_api_url: str = "http://localhost:7880"
    livekit_api_key: str = "APIStable2026"
    livekit_api_secret: str = "stable_secret_change_in_production_2026"

    # Keycloak
    keycloak_url: str = "http://localhost:8080"
    keycloak_realm: str = "stable"
    keycloak_client_id: str = "stable-backend"
    keycloak_client_secret: str = ""

    # Unicorn Brigade — upstream agent backend. Agents in Stable rooms route
    # their LLM calls through Brigade so persona + memory + delegation live
    # in one place.
    brigade_base_url: str = "https://brigade.magicunicorn.dev/api/v1/openai/v1"
    brigade_api_key: str = ""
    brigade_worker_agent_name: str = "stable-brigade"  # must match WorkerOptions.agent_name

    # Dedicated Brigade agent chat API. Used by the text-only reply path
    # (services/agent_chat_responder.py). Distinct from brigade_base_url
    # (which historically pointed at the OpenAI-compat shim — currently
    # 404 in production). Auth header is X-API-Key, not Bearer.
    brigade_api_base_url: str = "https://brigade.magicunicorn.dev/api/v1"

    # Microsoft Graph email (invites, notifications). Optional — falls back
    # to logging only if not configured.
    ms_graph_tenant_id: str = ""
    ms_graph_client_id: str = ""
    ms_graph_client_secret: str = ""
    ms_graph_from_address: str = ""

    # Public URL shown in outgoing emails so recipients can click through.
    public_base_url: str = "https://stable.magicunicorn.dev"

    # Project Ops MCP service-account token. Stable uses this only server-side
    # when promoting messages into Project Ops tasks.
    projectops_service_jwt: str = ""
    projectops_mcp_url: str = "https://api.projectops.magicunicorn.dev/api/v1/mcp"
    projectops_dashboard_url: str = "https://projectops.magicunicorn.dev"

    # When True, the backend hooks user messages in agent-attached rooms
    # through Brigade""s chat API and posts the reply back via /internal/agent-messages,
    # bypassing the LiveKit voice pipeline. Lets agents respond in text DMs
    # even when STT/TTS plugins are unavailable. Voice path stays voice-only
    # to avoid double-replies (see agent_runtime/base.py).
    stable_text_agent_path_enabled: bool = True

    # Slack-shaped incoming webhook secret. When set, enables
    # POST /webhooks/incoming/{secret}/{room_name} so external services
    # (Brigade tripwires, GitHub, Sentry, anything that speaks the Slack
    # webhook shape) can post messages into a Stable channel by URL alone.
    # Leave empty to disable the endpoint.
    incoming_webhook_secret: str = ""

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
