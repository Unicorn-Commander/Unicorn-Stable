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

    # -- Project-Ops → Stable signed webhook receiver (app/api/project_ops.py) --
    # Shared HMAC secret for POST /api/v1/webhooks/project-ops. This is the
    # per-endpoint signing secret Project-Ops shows once when the workspace
    # subscribes its webhook endpoint (whsec_…). When UNSET the receiver is
    # inert (returns 503) — flag off = no behaviour change.
    projectops_webhook_secret: str = ""
    # Bind this endpoint's secret and assignee mapping to ONE Project-Ops workspace.
    # Missing binding leaves the integration disabled; other workspaces get 403.
    projectops_workspace_id: str = ""
    # Replay window for webhook envelopes: an envelope older than this many
    # seconds is rejected (and a small future skew is tolerated).
    projectops_webhook_max_age_seconds: int = 300
    # Mapping of Project-Ops assignee user id → Stable room name. JSON object:
    #   {"<project-ops-user-id>": "astra", ...}
    # Only mapped assignees get a message; unmapped events are acknowledged and
    # dropped. Empty = receiver accepts but maps nothing (inert).
    projectops_room_mapping: dict[str, str] = {}

    # When True, the backend hooks user messages in agent-attached rooms
    # through Brigade""s chat API and posts the reply back via /internal/agent-messages,
    # bypassing the LiveKit voice pipeline. Lets agents respond in text DMs
    # even when STT/TTS plugins are unavailable. Voice path stays voice-only
    # to avoid double-replies (see agent_runtime/base.py).
    stable_text_agent_path_enabled: bool = True

    # -- Per-user agent access control (see services/agent_access.py) --
    # Instance-wide default when a (user, agent) pair has NO grant row:
    #   "open"   → every instance member may reach every agent (today's
    #              behavior; dogfood keeps working unchanged). Per-agent
    #              deny-grants carve agents away from specific users.
    #   "closed" → nothing is reachable without an explicit allow-grant
    #              (customer orgs). Per-agent allow-grants open pairs up.
    # Grants always win over the default, in both directions. Only these two
    # values are accepted — a typo must fail boot loudly, not silently pick a
    # direction for a security control.
    agent_access_default: str = "open"

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
    # Optional enterprise release gates. When enabled, /ready returns 503
    # unless error reporting is active and/or the image carries a real source
    # revision. They default off for self-hosted/dev compatibility, but the
    # readiness body still reports either condition truthfully.
    readiness_require_observability: bool = False
    readiness_require_build_provenance: bool = False
    health_check_timeout_seconds: float = 3.0

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
    # invite LINKS (room_invites) minted per user per minute (design §3)
    rate_limit_room_invite_per_min: int = 20
    # Guest invite REDEMPTION. Keyed on client IP, not on the presented secret
    # (keying on the secret would let an attacker rotate guesses for a fresh
    # bucket every time). This is the one unauthenticated guest endpoint and
    # therefore the brute-force target; see api/guests.py.
    rate_limit_guest_redeem_per_min: int = 10
    # Guest message send, aggregated PER INVITE rather than per guest.
    #
    # The per-participant limit above is the right key for one person's hand
    # speed, but it is the wrong unit of trust for a guest: every redemption
    # mints a FRESH Participant, so an invite with unlimited `max_uses` bought
    # `rate_limit_message_send_per_min` of send rate per redemption — N guests,
    # N x the rate, from what the owner minted as ONE link. (The IP-keyed
    # redeem limiter bounds how fast identities can be minted, not how many.)
    # This is the link's own aggregate budget, charged on top of the
    # per-participant one; see deps.rate_limit_principal for the layering.
    #
    # 5x the single-guest limit rather than 1x on purpose: an invite is often
    # legitimately shared (a webinar link with max_uses=50), and keying the
    # limit on the invite ALONE would let one chatty guest starve the other
    # forty-nine. 5x leaves a genuinely busy room room to breathe while still
    # bounding the blast radius of a link that leaked, no matter how many
    # identities are minted behind it.
    rate_limit_guest_invite_send_per_min: int = 300

    # -- Guest access (see app/auth/guest_auth.py + app/api/guests.py) --
    # Master switch. False = owners cannot mint invites, redemption 404s, AND
    # existing guest sessions stop authenticating on the very next request
    # (HTTP and WebSocket alike). A real kill switch, not just a hide.
    guest_access_enabled: bool = True
    # Invite link lifetime. Short by default: a guest link is a credential that
    # lets a stranger into a room with camera and microphone.
    guest_invite_default_ttl_hours: int = 24
    guest_invite_max_ttl_hours: int = 168  # 7 days
    # A single guest's session never outlives this, even on a long-lived
    # invite, so an abandoned browser tab cannot hold room access for a week.
    guest_session_max_hours: int = 12
    # Expired-session reaper (app/services/guest_reaper.py). Expiry alone only
    # stops a guest being AUTHORIZED; without this sweep an expired guest keeps
    # publishing to LiveKit (the media session outlives its join token) and
    # keeps their seat on the room roster. Off only for debugging — turning it
    # off does not make guests live longer, it makes them linger louder.
    guest_reaper_enabled: bool = True
    guest_reaper_interval_seconds: int = 60
    # Ceiling on rows swept per pass, so a large backlog is drained over
    # several passes instead of in one long transaction.
    guest_reaper_batch: int = 200
    # Thread auto-archive (app/services/room_archive.py, design §3): threads
    # idle this many days are archived by a periodic sweep; a new message
    # unarchives immediately (send-path hook) or on the next pass (safety
    # net). Same worker pattern as the reaper; the UPDATEs are idempotent so
    # every uvicorn worker may run it.
    thread_auto_archive_enabled: bool = True
    thread_auto_archive_interval_seconds: int = 600
    thread_auto_archive_idle_days: int = 14
    thread_auto_archive_batch: int = 500
    # Guest PARTICIPANT lifecycle, run by the same loop. A redemption mints an
    # ephemeral Participant row and nothing ever closed it — it sat at
    # `status = 'online'` forever, indistinguishable from a guest who is on a
    # call right now. See app/services/guest_reaper.py for why these are
    # TOMBSTONED rather than deleted (messages.sender_id is SET NULL and
    # guest_sessions.participant_id is CASCADE, so a delete would silently
    # un-attribute room history and destroy the audit trail).
    #
    # How long after a guest's LAST session died before the row is retired.
    # An hour, not zero: it is bookkeeping, and the grace keeps this pass from
    # racing the teardown fan-out in guests._terminate_sessions.
    guest_participant_retire_after_minutes: int = 60
    # How long a RETIRED guest is kept before the row is hard-deleted — and
    # only ever when they sent no messages at all, so there is provably nothing
    # to orphan. 0 disables the delete stage entirely: tombstones, kept forever.
    guest_participant_purge_after_days: int = 30
    # Retention for the two guest CREDENTIAL tables themselves. Revocation and
    # expiry are stamps on these rows, never deletes — no code path anywhere
    # issues a DELETE against either — so without these every link an owner
    # ever minted, and every redemption of it, was kept forever.
    #
    # A SESSION is the record of a person who was in a room: which link they
    # walked through, the name they typed, when they were last seen. Nothing in
    # the schema references it (it is a leaf), so deleting one orphans nothing
    # and un-attributes no message — messages point at the PARTICIPANT, which
    # is tombstoned and kept. A year is far beyond any plausible
    # incident-response window; 0 keeps them forever.
    guest_session_purge_after_days: int = 365
    # An INVITE is only ever deleted while NOT EXISTS a session referencing it,
    # because guest_sessions.invite_id is ON DELETE CASCADE and deleting a used
    # invite would take the audit trail above with it. What is left after that
    # guard is a link NOBODY WALKED THROUGH — it records nothing about any
    # person and nothing in the schema points at it — so a shorter window is
    # safe. Shorter than the session window ON PURPOSE: the guard, not the
    # clock, is what makes this delete safe. 0 keeps them forever.
    guest_invite_purge_after_days: int = 90

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
    # Read-aloud (per-message speaker button) default for senders with no
    # preset voice: humans, plain-model seats (ChatGPT, Gemini, ...), unknown
    # agents. Deliberately NOT tts_default_voice — af_heart is Persephone's.
    # The four named crew voices (af_heart/am_echo/am_puck/am_michael) are
    # refused here (app/api/tts.py::read_aloud_default_voice). Env:
    # TTS_READ_ALOUD_DEFAULT_VOICE.
    tts_read_aloud_default_voice: str = "am_adam"

    # -- Meeting-Ops transcript federation (app/api/transcripts.py) --
    # Optional forward target for finalized call transcripts ("Send to
    # Meeting-Ops"). Incomplete URL/PAT/org configuration retains exports in
    # the durable blocked queue without attempting a remote POST. No secrets
    # are shipped. See server/app/services/meeting_ops.py.
    meeting_ops_url: str = ""
    meeting_ops_ingest_path: str = "/api/v1/sessions/ingest"
    meeting_ops_api_key: str = ""
    # Explicit tenant selector sent as X-MeetingOps-Org. Production should set
    # this even when the PAT user's default org happens to be correct.
    meeting_ops_org_slug: str = ""
    # Master switch. When False, never forward even if URL is set.
    meeting_ops_enabled: bool = False
    meeting_ops_outbox_poll_seconds: float = 2.0
    meeting_ops_outbox_max_attempts: int = 8
    meeting_ops_outbox_retry_base_seconds: int = 5
    meeting_ops_outbox_retry_max_seconds: int = 900
    # Delivered payloads remain available for short recovery/audit inspection,
    # then are irreversibly redacted from Stable. Legal hold disables redaction
    # explicitly; Meeting-Ops remains the system of record after delivery.
    meeting_ops_outbox_payload_retention_hours: int = 168
    meeting_ops_outbox_legal_hold: bool = False

    # -- Agent context (app/services/context_builder.py; design §4) --
    # Token budget the Brigade responder asks the context builder for.
    context_budget_tokens: int = 6000

    # -- Rolling room summary (app/services/context_summary.py; design §4) --
    # Every N new messages per room (or on demand by an owner/admin) the
    # delta since the previous summary is folded into a new one through the
    # LiteLLM gateway (OpenAI-compatible chat completions). The default lane
    # is qwen3.6-35b-long-batch on bigboy's 3090: room content, customer
    # names included, never leaves our hardware. Base URL and key are read
    # here and never logged or returned. Master switch default OFF.
    context_summary_enabled: bool = False
    context_summary_base_url: str = ""
    context_summary_api_key: str = ""
    context_summary_model: str = "qwen3.6-35b-long-batch"
    context_summary_every_messages: int = 50
    context_summary_poll_seconds: float = 60.0
    context_summary_lookback_days: int = 30
    context_summary_timeout_seconds: float = 180.0
    context_summary_max_chars: int = 2400

    # -- Automatic call-audio recording (LiveKit egress) --
    # Master switch for recording call audio via the stack's LiveKit egress
    # service and attaching it to the call's Meeting-Ops session. Default OFF
    # so instances without an egress container (e.g. per-org deployments that
    # haven't opted in) are unaffected; dogfood turns it on in compose.
    # Recording is strictly fail-open: an absent/broken egress service must
    # never break the call itself.
    call_recording_enabled: bool = False
    # Egress writes finished files here; the volume is mounted at the SAME
    # path in the egress container and this backend, so no path translation.
    call_recording_output_dir: str = "/egress-out"
    call_recording_handoff_poll_seconds: float = 5.0
    call_recording_handoff_max_attempts: int = 10
    call_recording_handoff_retry_base_seconds: int = 15
    call_recording_handoff_retry_max_seconds: int = 900
    # How long the hand-off keeps waiting for the call's transcript export to
    # create the Meeting-Ops session before recording `no_session`.
    call_recording_session_wait_seconds: int = 1800
    # Meeting-Ops base URL for the audio attach lane. Empty = meeting_ops_url.
    # On bigboy dogfood this is the direct container URL
    # (http://meet-backend:9050) so multi-hundred-MB call audio never transits
    # the CDN edge (Cloudflare caps request bodies well below a long call).
    meeting_ops_upload_url: str = ""
    # A USER-scoped Meeting-Ops PAT (mops_pat_…). The transcript lane's
    # stable.transcript.ingest PAT is scope-locked to /sessions/ingest and is
    # deliberately rejected by MO's generic API auth, so the audio lane needs
    # its own credential.
    meeting_ops_upload_pat: str = ""

    # -- Recording policy, composite video, storage, retention (design §8) --
    # CALL_RECORDING_ENABLED above is the instance-wide master kill-switch;
    # the ROOM's recording_policy (off | on_request | always) is the decision.
    #
    # Composite (video) recordings are LiveKit room-composite egresses that
    # render OUR broadcast page (web/src/components/Broadcast) through a
    # recorder token, so the file looks exactly like the show feed. The egress
    # worker's headless Chrome loads
    #   {call_recording_composite_base_url or public_base_url}/broadcast/{room}/composite?rt=<recorder token>
    # and LiveKit appends its own url/token/layout query params to it.
    call_recording_composite_base_url: str = ""
    # LiveKit EncodingOptionsPreset name for composites (H264_720P_30,
    # H264_1080P_30, ...). 720p30 until CPU per stream is measured live.
    call_recording_composite_preset: str = "H264_720P_30"
    # Which page the egress worker's Chrome renders for a composite:
    #   livekit — the template the egress container ships (a grid of every
    #             participant's camera, names on tiles); needs nothing of ours
    #             to be reachable. What dogfood records with until the branded
    #             page exists.
    #   stable  — our broadcast page at /broadcast/{room}/composite carrying a
    #             recorder token; the page paints the branded composite and
    #             emits the START_RECORDING/END_RECORDING signals.
    call_recording_composite_template: str = "livekit"
    # Layout name for the livekit template: grid | speaker | single-speaker.
    call_recording_composite_layout: str = "grid"
    # Concurrent composite egresses allowed across the whole instance (a
    # Redis semaphore; starting one more answers 429).
    recording_max_composite: int = 2
    # Longest a single recording may run. Bounds the recorder token's TTL,
    # the composite capacity slot, and the stale-egress sweep.
    call_recording_max_hours: int = 6
    # Days a finished recording stays before the sweep deletes its storage
    # object and any local file. legal_hold on the row blocks deletion.
    call_recording_retention_days: int = 30
    # S3-compatible storage for finished recordings (Garage / Studio Storage).
    # Empty endpoint = no upload; files stay on the egress volume until the
    # retention sweep removes them. Values are secrets: never logged.
    recording_s3_endpoint: str = ""
    recording_s3_bucket: str = ""
    recording_s3_access_key: str = ""
    recording_s3_secret_key: str = ""
    recording_s3_region: str = "garage"
    # Path-style addressing (https://endpoint/bucket/key) is what Garage
    # serves by default; virtual-host style needs wildcard DNS + certs.
    recording_s3_path_style: bool = True
    # Key prefix inside the bucket, e.g. "stable/". Trailing slash optional.
    recording_s3_prefix: str = "stable-recordings/"
    # Presigned download links (GET /rooms/{id}/recordings/{id}/download).
    recording_download_link_seconds: int = 900

    # -- STT proxy (app/api/stt.py) --
    # OpenAI-compatible transcription base (must include the /v1 suffix).
    # Deployed default = Parakeet OpenAI shim on midboy1 (was Amanuensis on
    # uc-1). Agents use the same WHISPER_BASE_URL env var.
    whisper_base_url: str = "http://192.168.10.68:8011/v1"
    whisper_model: str = "whisper-1"

    @field_validator("agent_access_default")
    @classmethod
    def validate_agent_access_default(cls, v: str) -> str:
        norm = (v or "").strip().lower() or "open"
        if norm not in ("open", "closed"):
            raise ValueError(
                "AGENT_ACCESS_DEFAULT must be 'open' or 'closed', got "
                f"{v!r} — refusing to guess a direction for an access control."
            )
        return norm

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

    @field_validator("projectops_room_mapping", mode="before")
    @classmethod
    def parse_projectops_room_mapping(cls, v: str | dict[str, str]) -> dict[str, str]:
        # Accept either a Python dict (pydantic-settings already JSON-decoded a
        # complex field) or a raw JSON-object string from the environment. A
        # malformed value fails boot loudly rather than silently mapping nobody.
        if isinstance(v, dict):
            return {str(k): str(val) for k, val in v.items()}
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return {}
            import json

            try:
                parsed = json.loads(s)
            except ValueError as exc:
                raise ValueError(
                    "PROJECTOPS_ROOM_MAPPING must be a JSON object of "
                    "{project_ops_user_id: room_name}"
                ) from exc
            if not isinstance(parsed, dict):
                raise ValueError(
                    "PROJECTOPS_ROOM_MAPPING must be a JSON object of "
                    "{project_ops_user_id: room_name}"
                )
            return {str(k): str(val) for k, val in parsed.items()}
        return {}

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
