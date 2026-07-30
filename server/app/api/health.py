"""Liveness and readiness probes with truthful failure semantics.

``/live`` answers only "is this process running?" and never touches a
dependency. ``/ready`` and the backwards-compatible ``/health`` verify every
dependency required to serve authenticated collaboration traffic and return
HTTP 503 when any required check fails.

The API deliberately returns stable state labels instead of raw exception
strings: database DSNs, hostnames, and upstream response fragments do not
belong on an unauthenticated health surface.
"""

from __future__ import annotations

import asyncio
import os
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

import structlog
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_db, get_livekit, get_redis, get_settings_dep
from app.auth.keycloak import jwks_cache_ready
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter()


@lru_cache(maxsize=1)
def _expected_schema_heads() -> frozenset[str]:
    """Read the migration heads shipped in this exact server image."""
    server_root = Path(__file__).resolve().parents[2]
    config = Config(str(server_root / "alembic.ini"))
    config.set_main_option("script_location", str(server_root / "alembic"))
    return frozenset(ScriptDirectory.from_config(config).get_heads())


async def _database_state(
    db: AsyncSession, timeout: float
) -> tuple[dict[str, str], bool]:
    try:
        await asyncio.wait_for(db.execute(text("SELECT 1")), timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "readiness_dependency_failed",
            dependency="database",
            error_type=type(exc).__name__,
        )
        return {"database": "unavailable", "schema": "unknown"}, False

    try:
        result = await asyncio.wait_for(
            db.execute(text("SELECT version_num FROM alembic_version")),
            timeout=timeout,
        )
        current = frozenset(str(row[0]) for row in result.all())
        expected = _expected_schema_heads()
        if current != expected:
            logger.error(
                "readiness_schema_outdated",
                current_revisions=sorted(current),
                expected_revisions=sorted(expected),
            )
            return {"database": "ready", "schema": "outdated"}, False
        return {"database": "ready", "schema": "current"}, True
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "readiness_dependency_failed",
            dependency="schema",
            error_type=type(exc).__name__,
        )
        return {"database": "ready", "schema": "unavailable"}, False


async def _redis_state(redis: Redis, timeout: float) -> tuple[str, bool]:
    try:
        pong = await asyncio.wait_for(redis.ping(), timeout=timeout)
        return ("ready", True) if pong else ("unavailable", False)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "readiness_dependency_failed",
            dependency="redis",
            error_type=type(exc).__name__,
        )
        return "unavailable", False


async def _livekit_state(
    livekit: LiveKitService, timeout: float
) -> tuple[str, bool]:
    try:
        await asyncio.wait_for(livekit.list_rooms(), timeout=timeout)
        return "ready", True
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "readiness_dependency_failed",
            dependency="livekit",
            error_type=type(exc).__name__,
        )
        return "unavailable", False


def _build_state(settings: Settings) -> tuple[dict[str, Any], bool]:
    revision = (os.getenv("STABLE_GIT_SHA") or "unknown").strip()
    valid = revision.lower() not in {"", "unknown", "unset", "none"}
    required = settings.readiness_require_build_provenance
    return (
        {
            "revision": revision,
            "state": "stamped" if valid else "unknown",
            "required": required,
        },
        valid or not required,
    )


@router.get("/live", include_in_schema=False)
@router.get("/api/v1/live", include_in_schema=False)
async def liveness() -> dict[str, str]:
    """Process liveness only; dependency outages must not trigger restarts."""
    return {
        "status": "alive",
        "revision": (os.getenv("STABLE_GIT_SHA") or "unknown").strip(),
    }


@router.get("/health")
@router.get("/ready")
@router.get("/api/v1/health", include_in_schema=False)
@router.get("/api/v1/ready", include_in_schema=False)
async def readiness(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> JSONResponse:
    """Return 200 only when this instance can serve real application traffic."""
    timeout = max(0.1, settings.health_check_timeout_seconds)
    database_result, redis_result, livekit_result = await asyncio.gather(
        _database_state(db, timeout),
        _redis_state(redis, timeout),
        _livekit_state(livekit, timeout),
    )

    database_states, database_ready = database_result
    redis_state, redis_ready = redis_result
    livekit_state, livekit_ready = livekit_result

    identity_ready = jwks_cache_ready() or bool(
        getattr(request.app.state, "jwks_loaded", False)
    )
    observability_enabled = bool(
        getattr(request.app.state, "observability_enabled", False)
    )
    observability_required = settings.readiness_require_observability
    observability_ready = observability_enabled or not observability_required
    build, build_ready = _build_state(settings)
    audit_ready = settings.environment != "production" or bool(
        settings.internal_agent_secret
    )

    services: dict[str, Any] = {
        **database_states,
        "redis": redis_state,
        "livekit": livekit_state,
        "identity": "ready" if identity_ready else "unavailable",
        "agent_audit": "ready" if audit_ready else "missing_internal_secret",
        "observability": {
            "state": "enabled" if observability_enabled else "disabled",
            "required": observability_required,
        },
        "build": build,
    }
    ready = all(
        (
            database_ready,
            redis_ready,
            livekit_ready,
            identity_ready,
            audit_ready,
            observability_ready,
            build_ready,
        )
    )
    body = {
        "status": "ready" if ready else "not_ready",
        "services": services,
    }
    return JSONResponse(status_code=200 if ready else 503, content=body)
