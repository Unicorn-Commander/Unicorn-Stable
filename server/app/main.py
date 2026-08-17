from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from livekit.api import LiveKitAPI
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.agents import router as agents_router
from app.api.agent_access import router as agent_access_router
from app.api.agent_events import router as agent_events_router
from app.api.artifacts import router as artifacts_router
from app.api.internal_artifacts import router as internal_artifacts_router
from app.api.brigade import router as brigade_router
from app.api.health import router as health_router
from app.api.home import router as home_router
from app.api.instance_meta import router as instance_meta_router
from app.api.participants import router as participants_router
from app.api.help import router as help_router
from app.api.internal_knowledge import router as internal_knowledge_router
from app.api.knowledge import router as knowledge_router
from app.api.messages import router as messages_router
from app.api.gateway import router as gateway_router  # ORCH-1 public agent-gateway
from app.api.broadcast import router as broadcast_router
from app.api.calls import router as calls_router
from app.api.guests import router as guests_router
from app.api.rooms import router as rooms_router
from app.api.tokens import router as tokens_router
from app.api.tts import router as tts_router
from app.api.transcripts import router as transcripts_router
from app.api.stt import router as stt_router
from app.api.uploads import router as uploads_router
from app.api.users import router as users_router
from app.api.push import router as push_router
from app.api.webhooks import router as webhooks_router
from app.auth.keycloak import fetch_jwks, start_jwks_refresh_task
from app.config import get_settings
from app.services.livekit_service import LiveKitService
from app.services.presence_service import PresenceService
from app.ws.handler import router as ws_router


def configure_logging(log_level: str) -> None:
    """Configure structlog with JSON output for production, console for dev."""
    settings = get_settings()
    is_dev = settings.environment == "development"

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer() if is_dev else structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, log_level.upper(), logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def _validate_production_secrets(settings) -> None:
    """Refuse to boot in production on a WORLD-KNOWN default secret; warn on
    softer insecure fallbacks. No-op outside production. This protects a
    self-hoster from silently running on the shipped defaults."""
    if settings.environment != "production":
        return
    log = structlog.get_logger("startup_guard")
    if (
        not settings.livekit_api_secret
        or settings.livekit_api_secret == "stable_secret_change_in_production_2026"
    ):
        log.critical(
            "insecure_default_secret",
            detail="LIVEKIT_API_SECRET is unset or the built-in default — "
            "anyone could mint LiveKit join tokens for any room.",
        )
        raise RuntimeError(
            "Refusing to start in production: LIVEKIT_API_SECRET is unset or the "
            "built-in default. Set a strong random value (see .env.example)."
        )
    if settings.livekit_api_key == "APIStable2026":
        log.warning(
            "default_livekit_api_key",
            detail="LIVEKIT_API_KEY is the built-in default; set your own.",
        )
    if not settings.internal_agent_secret:
        log.warning(
            "internal_agent_secret_fallback",
            detail="INTERNAL_AGENT_SECRET unset; falling back to the LiveKit "
            "secret. Set a distinct random value.",
        )
    if not settings.gateway_key_admin_secret:
        log.warning(
            "gateway_key_admin_secret_fallback",
            detail="GATEWAY_KEY_ADMIN_SECRET unset; gateway key mint/revoke "
            "falls back to the internal agent secret. Set a distinct random "
            "value so a leaked internal bearer cannot mint agent keys.",
        )
    if not settings.upload_url_secret:
        log.warning(
            "upload_url_secret_fallback",
            detail="UPLOAD_URL_SECRET unset; falling back to the LiveKit secret. "
            "Set a distinct random value.",
        )
    if "stable:stable@" in settings.database_url:
        log.warning(
            "default_db_password",
            detail="DATABASE_URL uses the default 'stable' password.",
        )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application lifecycle: startup and shutdown."""
    settings = get_settings()
    logger = structlog.get_logger("lifespan")

    # -- Startup --

    # Fail-safe: refuse to boot on a world-known default secret in production.
    _validate_production_secrets(settings)
    from app.services.meeting_ops import meeting_ops_config_error

    meeting_ops_error = meeting_ops_config_error(settings)
    if settings.meeting_ops_enabled and meeting_ops_error:
        logger.critical(
            "meeting_ops_configuration_invalid",
            detail=meeting_ops_error,
        )
        raise RuntimeError(meeting_ops_error)

    # Database engine
    engine = create_async_engine(
        settings.database_url,
        echo=settings.environment == "development",
        pool_size=20,
        max_overflow=10,
        pool_pre_ping=True,
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    app.state.db_engine = engine
    app.state.db_session_factory = session_factory
    logger.info("database_engine_initialized", url=settings.database_url.split("@")[-1])

    # Redis pool
    redis = Redis.from_url(
        settings.redis_url,
        decode_responses=False,
        max_connections=50,
    )
    app.state.redis = redis
    logger.info("redis_pool_initialized")

    # Presence service
    presence_service = PresenceService(redis)
    app.state.presence_service = presence_service

    # LiveKit API client
    lk_api = LiveKitAPI(
        url=settings.livekit_api_url,
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret,
    )
    lk_service = LiveKitService(lk_api, settings.livekit_url)
    app.state.livekit_api = lk_api
    app.state.livekit_service = lk_service
    logger.info("livekit_client_initialized", url=settings.livekit_api_url)

    # Fetch JWKS and start refresh task
    jwks_task = None
    app.state.jwks_loaded = False
    try:
        await fetch_jwks(settings.keycloak_url, settings.keycloak_realm)
        app.state.jwks_loaded = True
        logger.info("keycloak_jwks_loaded")
    except Exception:
        logger.warning("keycloak_jwks_fetch_failed_on_startup", exc_info=True)
    # Start the refresher even when bootstrap failed. The previous code only
    # started it on success, making a transient Keycloak outage permanent until
    # the backend container was manually restarted.
    jwks_task = await start_jwks_refresh_task(
        settings.keycloak_url,
        settings.keycloak_realm,
        refresh_immediately=not app.state.jwks_loaded,
    )

    app.state.jwks_task = jwks_task

    # Recover Knowledge-Base documents stranded mid-index by a previous restart.
    #
    # KB indexing runs as an in-process ``asyncio`` task, so a process death
    # between "row created as indexing" and "status written" leaves the row in
    # ``indexing`` with nothing alive that will ever finish it -- the UI shows a
    # spinner forever. Nothing used to look for those rows on the way back up.
    # This is that look. It is scheduled (not awaited) so a slow re-index can
    # never delay or block startup, and the sweep only touches rows older than
    # its age threshold, so it cannot fight a task running in THIS process.
    kb_recovery_task = None
    try:
        from app.services.knowledge_service import knowledge_service

        kb_recovery_task = asyncio.create_task(
            knowledge_service.requeue_stranded_documents(
                settings=settings, session_factory=session_factory
            )
        )
        logger.info("kb_stranded_recovery_scheduled")
    except Exception:
        logger.warning("kb_stranded_recovery_schedule_failed", exc_info=True)
    app.state.kb_recovery_task = kb_recovery_task

    # Durable transcript delivery. Every uvicorn worker may run this loop:
    # row claims use FOR UPDATE SKIP LOCKED and Meeting-Ops de-duplicates on
    # export_id, so parallel workers improve recovery without duplicate records.
    transcript_outbox_task = None
    try:
        from app.services.transcript_outbox import run_transcript_outbox

        transcript_outbox_task = asyncio.create_task(
            run_transcript_outbox(session_factory, settings)
        )
        logger.info(
            "transcript_outbox_worker_started",
            meeting_ops_configured=bool(
                settings.meeting_ops_enabled
                and settings.meeting_ops_url.strip()
                and settings.meeting_ops_api_key.strip()
                and settings.meeting_ops_org_slug.strip()
            ),
        )
    except Exception:
        logger.warning("transcript_outbox_worker_start_failed", exc_info=True)
    app.state.transcript_outbox_task = transcript_outbox_task

    # Durable call-audio hand-off. Same claim discipline as the transcript
    # outbox: FOR UPDATE SKIP LOCKED rows, so all four uvicorn workers may run
    # the loop without double-delivering one recording. Recording itself is
    # feature-flagged; when disabled this worker idles over an empty table.
    call_recording_task = None
    try:
        from app.services.call_recording import (
            handoff_config_error,
            run_call_recording_handoff,
        )

        call_recording_task = asyncio.create_task(
            run_call_recording_handoff(session_factory, settings)
        )
        logger.info(
            "call_recording_handoff_worker_started",
            recording_enabled=settings.call_recording_enabled,
            handoff_config_error=handoff_config_error(settings),
        )
    except Exception:
        logger.warning("call_recording_handoff_worker_start_failed", exc_info=True)
    app.state.call_recording_task = call_recording_task

    # Guest-session reaper. Expiry used to be enforced only when something
    # asked — so an expired guest stopped being AUTHORIZED on time, but kept
    # publishing to LiveKit (the media session outlives the token that opened
    # it) and kept their seat on the room roster until they closed the tab.
    # This is the thing that goes looking. Every worker may run it; the claim
    # is exactly-once. See app/services/guest_reaper.py.
    guest_reaper_task = None
    try:
        if settings.guest_reaper_enabled:
            from app.services.guest_reaper import run_guest_reaper

            guest_reaper_task = asyncio.create_task(
                run_guest_reaper(session_factory, redis, lk_service, settings)
            )
            logger.info(
                "guest_reaper_started",
                interval_seconds=settings.guest_reaper_interval_seconds,
            )
    except Exception:
        logger.warning("guest_reaper_start_failed", exc_info=True)
    app.state.guest_reaper_task = guest_reaper_task

    logger.info("application_startup_complete", environment=settings.environment)

    yield

    # -- Shutdown --
    logger.info("application_shutting_down")

    if jwks_task and not jwks_task.done():
        jwks_task.cancel()

    if kb_recovery_task and not kb_recovery_task.done():
        kb_recovery_task.cancel()

    if transcript_outbox_task and not transcript_outbox_task.done():
        transcript_outbox_task.cancel()
        try:
            await transcript_outbox_task
        except asyncio.CancelledError:
            pass

    if call_recording_task and not call_recording_task.done():
        call_recording_task.cancel()
        try:
            await call_recording_task
        except asyncio.CancelledError:
            pass

    if guest_reaper_task and not guest_reaper_task.done():
        guest_reaper_task.cancel()
        try:
            await guest_reaper_task
        except asyncio.CancelledError:
            pass

    await lk_api.aclose()
    await redis.aclose()
    await engine.dispose()

    logger.info("application_shutdown_complete")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()
    configure_logging(settings.log_level)

    # Error/perf observability (Sentry/GlitchTip) — no-op unless a DSN is set.
    from app.observability import init_observability
    observability_enabled = init_observability(settings)

    app = FastAPI(
        title="Stable",
        description="LiveKit-based chat/voice/video platform API",
        version="0.2.0",
        lifespan=lifespan,
    )
    app.state.observability_enabled = observability_enabled

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Baseline security headers on every API response (B4 hardening). The SPA
    # is served by the separate nginx container, so a strict default here is
    # safe: this backend serves JSON + attachment downloads only. Attachment
    # responses additionally carry their own locked-down CSP (see uploads.py).
    @app.middleware("http")
    async def _request_context_and_security(
        request: Request, call_next  # type: ignore[no-untyped-def]
    ):
        """Correlate every request and emit one secret-free completion event."""
        request_id = (request.headers.get("X-Request-ID") or "").strip()
        if not request_id or len(request_id) > 128:
            request_id = str(uuid.uuid4())
        started = time.monotonic()
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)
        response = None
        try:
            response = await call_next(request)
            return response
        finally:
            duration_ms = round((time.monotonic() - started) * 1000, 2)
            # Do not log query strings, auth headers, cookies, request bodies,
            # or exception text here. Route-level logs carry safe domain data.
            structlog.get_logger("http").info(
                "http_request_completed",
                method=request.method,
                path=request.url.path,
                status_code=getattr(response, "status_code", 500),
                duration_ms=duration_ms,
            )
            if response is not None:
                response.headers.setdefault("X-Request-ID", request_id)
                response.headers.setdefault("X-Content-Type-Options", "nosniff")
                response.headers.setdefault("X-Frame-Options", "DENY")
                response.headers.setdefault(
                    "Referrer-Policy", "strict-origin-when-cross-origin"
                )
            structlog.contextvars.clear_contextvars()

    # Mount API routers under /api/v1
    app.include_router(health_router, tags=["Health"])
    app.include_router(home_router, prefix="/api/v1", tags=["Home"])
    app.include_router(rooms_router, prefix="/api/v1", tags=["Rooms"])
    app.include_router(messages_router, prefix="/api/v1", tags=["Messages"])
    app.include_router(gateway_router, prefix="/api/v1", tags=["Gateway"])  # ORCH-1
    app.include_router(tokens_router, prefix="/api/v1", tags=["Tokens"])
    # Broadcast feeds: OWNER-authenticated mint/revoke + a token-authed
    # /broadcast/join that is deliberately the ONLY route accepting a
    # broadcast token (see api/broadcast.py for the threat model).
    app.include_router(broadcast_router, prefix="/api/v1", tags=["Broadcast"])
    # Guest access: OWNER-authenticated invite mint/list/revoke, an
    # unauthenticated /guest/redeem that is the ONLY route accepting an invite
    # token, and a two-endpoint guest self-service surface. Guest SESSIONS are
    # accepted by a handful of opted-in routes elsewhere (messages, members,
    # LiveKit token, /ws) and refused everywhere else by deps.get_current_user.
    # Read app/api/guests.py + the guest section of app/deps.py before adding
    # anything a guest can reach.
    app.include_router(guests_router, prefix="/api/v1", tags=["Guests"])
    app.include_router(calls_router, prefix="/api/v1", tags=["Calls"])
    app.include_router(tts_router, prefix="/api/v1", tags=["TTS"])
    app.include_router(transcripts_router, prefix="/api/v1", tags=["Transcripts"])
    app.include_router(stt_router, prefix="/api/v1", tags=["STT"])
    app.include_router(agents_router, prefix="/api/v1", tags=["Agents"])
    app.include_router(agent_events_router, prefix="/api/v1", tags=["Agent Audit"])
    app.include_router(agent_access_router, prefix="/api/v1", tags=["Agent Access"])
    app.include_router(brigade_router, prefix="/api/v1", tags=["Brigade"])
    app.include_router(artifacts_router, prefix="/api/v1", tags=["Artifacts"])
    # Internal agent-surface routers (/api/v1/internal/*). Agents reach these
    # directly over the Docker network (http://backend:8400), never via Traefik.
    #
    # HOW THE EDGE BLOCK ACTUALLY WORKS — the path prefix is NOT the boundary.
    # There is no `!PathPrefix(...)` anywhere in the compose (an earlier version
    # of this comment claimed there was, and that claim misled readers into
    # believing anything under /api/v1/internal is automatically off-edge). The
    # real mechanism is a dedicated higher-priority Traefik router
    # (`stable-internal-deny*`, priority 1000) that captures this prefix and
    # runs it through an ipAllowList permitting only loopback -> 403.
    #
    # That distinction matters because the block is PER-ENTRYPOINT. Until
    # 2026-07-21 the deny router existed on `websecure` only, while the SPA's
    # `stable-http` router served the same Host on `web` (:80) and its nginx
    # proxied /api/ straight to this backend — so plain HTTP reached these
    # handlers from the internet (verified: https -> 403, http -> 422). Fixed by
    # adding a `web`-entrypoint deny router plus an HTTP->HTTPS redirect.
    #
    # DO NOT assume a new route is private because of where you mounted it.
    # Reachability is decided by the compose routers, so any new edge surface
    # must be re-checked there. The constant-time internal bearer (B1) is the
    # authn that actually travels with the request; treat the network block as
    # defense in depth, not the only lock.
    # Keep these mounts — they serve the internal Docker traffic.
    app.include_router(internal_artifacts_router, prefix="/api/v1", tags=["Artifacts"])
    app.include_router(knowledge_router, prefix="/api/v1", tags=["Knowledge"])
    app.include_router(internal_knowledge_router, prefix="/api/v1", tags=["Knowledge"])
    app.include_router(users_router, prefix="/api/v1", tags=["Users"])
    # Public server branding (GET) + admin-only edit (PUT/POST/DELETE).
    # See app/api/instance_meta.py for why a served endpoint beats baking
    # logo/description into the mounted instances.json.
    app.include_router(instance_meta_router, prefix="/api/v1", tags=["Instance"])
    app.include_router(participants_router, prefix="/api/v1", tags=["Avatars"])
    app.include_router(help_router, prefix="/api/v1", tags=["Help"])
    app.include_router(uploads_router, prefix="/api/v1", tags=["Uploads"])
    app.include_router(webhooks_router, prefix="/api/v1", tags=["Webhooks"])
    app.include_router(push_router, prefix="/api/v1", tags=["Push"])
    app.include_router(ws_router, tags=["WebSocket"])

    # Uploaded attachments are served ONLY by the authenticated signed-URL route
    # at /api/v1/uploads/{stored_name} (app/api/uploads.py). The old public
    # StaticFiles mount at /uploads was removed to close an open file-read hole.

    return app


app = create_app()
