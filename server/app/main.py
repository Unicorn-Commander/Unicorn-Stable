from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from livekit.api import LiveKitAPI
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.agents import router as agents_router
from app.api.artifacts import router as artifacts_router
from app.api.internal_artifacts import router as internal_artifacts_router
from app.api.brigade import router as brigade_router
from app.api.health import router as health_router
from app.api.internal_knowledge import router as internal_knowledge_router
from app.api.knowledge import router as knowledge_router
from app.api.messages import router as messages_router
from app.api.rooms import router as rooms_router
from app.api.tokens import router as tokens_router
from app.api.tts import router as tts_router
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


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application lifecycle: startup and shutdown."""
    settings = get_settings()
    logger = structlog.get_logger("lifespan")

    # -- Startup --

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
    try:
        await fetch_jwks(settings.keycloak_url, settings.keycloak_realm)
        jwks_task = await start_jwks_refresh_task(settings.keycloak_url, settings.keycloak_realm)
        logger.info("keycloak_jwks_loaded")
    except Exception:
        logger.warning("keycloak_jwks_fetch_failed_on_startup", exc_info=True)

    app.state.jwks_task = jwks_task

    logger.info("application_startup_complete", environment=settings.environment)

    yield

    # -- Shutdown --
    logger.info("application_shutting_down")

    if jwks_task and not jwks_task.done():
        jwks_task.cancel()

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
    init_observability(settings)

    app = FastAPI(
        title="Stable",
        description="LiveKit-based chat/voice/video platform API",
        version="0.1.0",
        lifespan=lifespan,
    )

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
    async def _security_headers(request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        return response

    # Mount API routers under /api/v1
    app.include_router(health_router, tags=["Health"])
    app.include_router(rooms_router, prefix="/api/v1", tags=["Rooms"])
    app.include_router(messages_router, prefix="/api/v1", tags=["Messages"])
    app.include_router(tokens_router, prefix="/api/v1", tags=["Tokens"])
    app.include_router(tts_router, prefix="/api/v1", tags=["TTS"])
    app.include_router(agents_router, prefix="/api/v1", tags=["Agents"])
    app.include_router(brigade_router, prefix="/api/v1", tags=["Brigade"])
    app.include_router(artifacts_router, prefix="/api/v1", tags=["Artifacts"])
    # Internal agent-surface routers (/api/v1/internal/*). Agents reach these
    # directly over the Docker network (http://backend:8400); they are removed
    # from the PUBLIC edge by the Traefik rule
    # (`... && !PathPrefix(/api/v1/internal)`) so the internet cannot reach them
    # (B2). The constant-time internal bearer (B1) is defense-in-depth behind
    # that. Keep these mounts — they serve the internal Docker traffic.
    app.include_router(internal_artifacts_router, prefix="/api/v1", tags=["Artifacts"])
    app.include_router(knowledge_router, prefix="/api/v1", tags=["Knowledge"])
    app.include_router(internal_knowledge_router, prefix="/api/v1", tags=["Knowledge"])
    app.include_router(users_router, prefix="/api/v1", tags=["Users"])
    app.include_router(uploads_router, prefix="/api/v1", tags=["Uploads"])
    app.include_router(webhooks_router, prefix="/api/v1", tags=["Webhooks"])
    app.include_router(push_router, prefix="/api/v1", tags=["Push"])
    app.include_router(ws_router, tags=["WebSocket"])

    # Uploaded attachments are served ONLY by the authenticated signed-URL route
    # at /api/v1/uploads/{stored_name} (app/api/uploads.py). The old public
    # StaticFiles mount at /uploads was removed to close an open file-read hole.

    return app


app = create_app()
