from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


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

    # -- Instance tenancy binding (offering C = one stack per org) --
    # The UUID of the org this instance belongs to. When set, every resource
    # created here (Knowledge Bases, rooms/channels) is stamped with this org
    # and reads are scoped to it — so even if two orgs' rows ever share one
    # Postgres, one org can never see another's. When EMPTY (offering B =
    # shared community / individuals), isolation falls back to ownership +
    # room-membership (a resource is private to its creator unless shared into
    # a room). Leave empty for a community box; set STABLE_ORG_ID for a per-org
    # deployment. Empty string normalizes to None via ``instance_org_id``.
    org_id: str = ""

    # Internal agent-surface bearer. Authenticates the /api/v1/internal/*
    # routes (agent message-inject, artifact write, KB search). MUST be a
    # distinct random secret from livekit_api_secret in production — sharing
    # one value across the LiveKit-token, internal-bearer, and upload-signing
    # trust boundaries meant a leak of any one compromised all three. Falls
    # back to livekit_api_secret only when unset (migration safety); set it
    # explicitly everywhere.
    internal_agent_secret: str = ""

    # Credential for MINTING/LISTING/REVOKING gateway keys
    # (POST|GET|DELETE /api/v1/gateway/keys). Deliberately split from
    # internal_agent_secret: those endpoints ride the PUBLIC `stable-api`
    # router (PathPrefix `/api`), so unlike the /api/v1/internal surface they
    # are reachable from the internet BY DESIGN and are guarded by a bearer
    # alone. Sharing one platform-wide, long-lived secret meant that any leak
    # of it — from any of the many services that hold it to talk to the
    # internal surface — also granted the power to mint durable scoped agent
    # identities. Separating them keeps a leaked internal bearer from
    # escalating into persistent access.
    # Falls back to internal_agent_secret when unset (migration safety), so
    # deploying this change breaks nothing; set it explicitly to get the split.
    gateway_key_admin_secret: str = ""

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

    # Web Push (VAPID). Public key is handed to the browser as its
    # applicationServerKey; the private key signs pushes. Empty = web-push
    # disabled (subscribe + dispatch become no-ops).
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:aaron@magicunicorn.tech"

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
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:3000"]

    # Application
    log_level: str = "info"
    # Default to production so a self-hoster who doesn't set ENVIRONMENT gets
    # the safe posture (JSON logs, no SQL echo, the startup secret guard on).
    # Set ENVIRONMENT=development locally for console logs + SQL echo.
    environment: str = "production"
    port: int = 8400

    # -- Observability (Sentry / GlitchTip; both speak the Sentry API) --
    # Empty => disabled. GLITCHTIP_DSN env is honoured as a fallback.
    sentry_dsn: str = ""
    sentry_traces_sample_rate: float = 0.0

    # -- Backend hardening (appended; see feat/backend-hardening) --

    # Local filesystem directory where uploaded attachments are written.
    # Overridable via UPLOAD_DIR so the path isn't hardcoded to one box.
    upload_dir: str = "/home/stable/server/uploads"

    # Secret used to HMAC-sign upload download URLs. Falls back to the
    # LiveKit secret when unset so a fresh deploy still has a non-empty key,
    # but set this explicitly in production. Signed URLs let the browser
    # render private attachments via <img src> (which cannot send an
    # Authorization header) while still gating who can mint a URL.
    upload_url_secret: str = ""
    # How long a signed upload URL stays valid, in seconds (default 1 hour).
    upload_url_ttl_seconds: int = 2592000  # 30d internal; public needs read-time re-signing

    # -- Document RAG ("chat with your documents") --
    # When True, document attachments posted to a room are indexed (extract →
    # chunk → embed → qdrant, scoped to the room) and the most relevant chunks
    # are injected as context when the room's agent replies. All RAG work is
    # fail-safe and fire-and-forget: any error is swallowed and never blocks
    # message send or the chat reply. Flip to False to disable entirely.
    rag_enabled: bool = True
    # Qdrant vector store (no auth). Reachable from the backend container.
    qdrant_url: str = "http://172.17.0.1:6333"
    # Infinity proxy: OpenAI-shaped /embeddings + /rerank.
    infinity_url: str = "http://172.17.0.1:8086"
    # Collection name (pre-created: size 1024, distance Cosine).
    rag_collection: str = "stable_documents"
    # Embedding + rerank model names passed to Infinity.
    embedding_model: str = "BAAI/bge-m3"
    rerank_model: str = "BAAI/bge-reranker-v2-m3"
    # Contextual chunking: at index time a tiny local (billing-exempt) model
    # writes a 1-sentence "what this document is about" summary that is prepended
    # to every chunk before embedding. Grounds each chunk in its document
    # (Anthropic "contextual retrieval"), cutting cross-doc retrieval misses.
    # Fully fail-safe: one short call per document; on any error/timeout the
    # chunk falls back to a filename-only prefix. Flip off to embed raw chunks.
    context_enabled: bool = True
    context_llm_url: str = "http://172.17.0.1:8085/v1/chat/completions"
    context_model: str = "Llama-3.2-3B-Instruct-Q4_K_M"

    # -- Rate limiting (Redis token-bucket; see app.deps.rate_limit) --
    # Master switch. When False, rate limiting is a no-op (useful for tests).
    rate_limit_enabled: bool = True
    # Per-user limits, expressed as "max requests per window seconds".
    # message send
    rate_limit_message_send_per_min: int = 60
    # file upload
    rate_limit_upload_per_min: int = 20
    # LiveKit token mint
    rate_limit_token_mint_per_min: int = 30
    # inbound webhook (keyed per room, not per user)
    rate_limit_webhook_per_min: int = 120
    # agent-chat trigger fallback (used when an agent has no rate_limit_rpm)
    rate_limit_agent_chat_per_min: int = 30
    # read-aloud TTS synthesis (GPU-bound upstream — keep this tight)
    rate_limit_tts_per_min: int = 20
    # speech-to-text transcription (GPU-bound upstream — keep this tight)
    rate_limit_stt_per_min: int = 20
    # Knowledge-Base abuse controls (GPU-embedding + disk are the scarce
    # resources; keep create/upload tight and cap total footprint per user).
    rate_limit_kb_create_per_min: int = 10
    rate_limit_kb_upload_per_min: int = 20
    # Room/channel creation (cheap but fan-out-able).
    rate_limit_room_create_per_min: int = 20
    # Brigade agent invites (each spawns a GPU-backed worker + agent turns).
    rate_limit_agent_invite_per_min: int = 20

    # -- Per-user quota caps (hard ceilings, independent of the rate window) --
    # Total KB documents a single user may own across all their collections,
    # and the total bytes on disk those uploads may consume. 0 disables the
    # check. Guards the shared upload volume + embedding GPU from a single
    # account filling the box.
    max_kb_documents_per_user: int = 500
    max_kb_bytes_per_user: int = 2 * 1024 * 1024 * 1024  # 2 GiB

    # LiveKit join-token lifetime. The token only needs to live long enough to
    # establish the WebRTC session (the media session outlives it), so a short
    # TTL bounds the blast radius of a leaked token. Was an implicit 24h.
    livekit_token_ttl_seconds: int = 3600

    # -- Read-aloud TTS proxy (app/api/tts.py) --
    # kokoro-fastapi front (kokoro-ha nginx on this host -> uc-1 GTX1070
    # primary). Same value the agents container uses as KOKORO_BASE_URL.
    kokoro_base_url: str = "http://192.168.10.10:8883"
    # Suite default voice = Majik (af_heart).
    tts_default_voice: str = "af_heart"

    # -- Meeting-Ops transcript federation (app/api/transcripts.py) --
    # Optional forward target for finalized call transcripts ("Send to
    # Meeting-Ops"). Leave MEETING_OPS_URL empty to accept exports locally only
    # (logged, 200) without attempting a remote POST. No secrets are shipped —
    # set MEETING_OPS_API_KEY in the deploy environment when the remote requires
    # a bearer. See server/app/services/meeting_ops.py.
    meeting_ops_url: str = ""
    meeting_ops_ingest_path: str = "/api/v1/sessions/ingest"
    meeting_ops_api_key: str = ""
    # Master switch. When False, never forward even if URL is set.
    meeting_ops_enabled: bool = True

    # -- STT proxy (app/api/stt.py) --
    # OpenAI-compatible transcription base (must include the /v1 suffix).
    # Deployed default = Parakeet OpenAI shim on midboy1 (was Amanuensis on
    # uc-1). Agents use the same WHISPER_BASE_URL env var.
    whisper_base_url: str = "http://192.168.10.68:8011/v1"
    whisper_model: str = "whisper-1"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v: str | list[str]) -> list[str]:
        # cors_origins is annotated NoDecode, so pydantic-settings hands us the
        # RAW env string instead of JSON-decoding list fields itself (that
        # implicit decode crashes boot on a comma-separated value under
        # pydantic-settings >=2.7). Accept BOTH a JSON array (["a","b"]) and a
        # bare comma list (a,b) so either .env style boots cleanly.
        if isinstance(v, str):
            s = v.strip()
            if s.startswith("["):
                import json

                try:
                    return json.loads(s)
                except ValueError:
                    pass
            return [origin.strip() for origin in s.split(",") if origin.strip()]
        return v

    @property
    def instance_org_id(self) -> str | None:
        """The configured instance org UUID, or None for a community box.

        Centralizes the empty-string→None normalization so authz code can do a
        simple truthiness check (``if settings.instance_org_id``) to branch
        between org-scoped (per-org deploy) and ownership-scoped (community)
        isolation.
        """
        v = (self.org_id or "").strip()
        return v or None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
