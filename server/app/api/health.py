from __future__ import annotations

from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, Request
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_db, get_livekit, get_redis
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter()


@router.get("/health")
async def health_check(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> dict[str, Any]:
    """Check connectivity to all backing services."""
    status_map: dict[str, str] = {}
    overall = "healthy"

    # Check PostgreSQL
    try:
        await db.execute(text("SELECT 1"))
        status_map["database"] = "connected"
    except Exception as exc:
        status_map["database"] = f"error: {exc}"
        overall = "degraded"
        logger.error("health_check_db_failed", error=str(exc))

    # Check Redis
    try:
        pong = await redis.ping()
        status_map["redis"] = "connected" if pong else "no response"
    except Exception as exc:
        status_map["redis"] = f"error: {exc}"
        overall = "degraded"
        logger.error("health_check_redis_failed", error=str(exc))

    # Check LiveKit
    try:
        rooms = await livekit.list_rooms()
        status_map["livekit"] = "connected"
    except Exception as exc:
        status_map["livekit"] = f"error: {exc}"
        overall = "degraded"
        logger.error("health_check_livekit_failed", error=str(exc))

    return {
        "status": overall,
        "services": status_map,
    }
