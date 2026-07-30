"""Authenticated ingestion and admin query surface for agent audit events."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._internal_auth import verify_internal_bearer
from app.api.agents import _require_admin
from app.config import get_settings
from app.deps import get_current_user, get_db
from app.models.agent import AgentEvent

logger = structlog.get_logger(__name__)
router = APIRouter()

_SENSITIVE_KEY = re.compile(
    r"(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)",
    re.IGNORECASE,
)
_MAX_STRING = 4096
_MAX_DATA_BYTES = 64 * 1024
_MAX_DEPTH = 8


def sanitize_event_data(value: Any, *, depth: int = 0) -> Any:
    """Return bounded JSON-safe event data with credential-like fields redacted."""
    if depth >= _MAX_DEPTH:
        return "[depth-limit]"
    if isinstance(value, dict):
        clean: dict[str, Any] = {}
        for raw_key, item in list(value.items())[:200]:
            key = str(raw_key)[:128]
            clean[key] = (
                "[redacted]"
                if _SENSITIVE_KEY.search(key)
                else sanitize_event_data(item, depth=depth + 1)
            )
        return clean
    if isinstance(value, (list, tuple)):
        return [sanitize_event_data(item, depth=depth + 1) for item in value[:200]]
    if isinstance(value, str):
        return value[:_MAX_STRING]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:_MAX_STRING]


class AgentEventCreate(BaseModel):
    agent_identity: str = Field(..., min_length=1, max_length=255)
    agent_type: str = Field(..., min_length=1, max_length=100)
    event: str = Field(
        ..., min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_.:-]+$"
    )
    data: dict[str, Any] = Field(default_factory=dict)
    room_id: str | None = Field(None, max_length=255)
    correlation_id: str | None = Field(None, max_length=128)
    occurred_at: datetime | None = None


class AgentEventResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    org_id: uuid.UUID | None
    agent_identity: str
    agent_type: str
    event_type: str
    room_ref: str | None
    correlation_id: str | None
    event_data: dict[str, Any]
    occurred_at: datetime
    received_at: datetime


@router.post(
    "/internal/agent-events",
    response_model=AgentEventResponse,
    status_code=status.HTTP_201_CREATED,
)
async def ingest_agent_event(
    body: AgentEventCreate,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AgentEventResponse:
    """Append one worker event. Only the internal agent bearer is accepted."""
    settings = get_settings()
    if settings.environment == "production" and not settings.internal_agent_secret:
        logger.error(
            "agent_event_ingest_unavailable",
            reason="INTERNAL_AGENT_SECRET is required in production",
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent audit ingestion is not configured",
        )
    verify_internal_bearer(request)
    clean_data = sanitize_event_data(body.data)
    encoded = json.dumps(clean_data, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > _MAX_DATA_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Agent event data exceeds 64 KiB after sanitization",
        )

    org_id = (
        uuid.UUID(settings.instance_org_id) if settings.instance_org_id else None
    )
    occurred_at = body.occurred_at or datetime.now(timezone.utc)
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone.utc)

    event = AgentEvent(
        org_id=org_id,
        agent_identity=body.agent_identity,
        agent_type=body.agent_type,
        event_type=body.event,
        room_ref=body.room_id,
        correlation_id=body.correlation_id,
        event_data=clean_data,
        occurred_at=occurred_at,
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    logger.info(
        "agent_event_ingested",
        audit_event_id=str(event.id),
        agent_identity=event.agent_identity,
        event_type=event.event_type,
        room_ref=event.room_ref,
    )
    return AgentEventResponse.model_validate(event)


@router.get("/agent-events", response_model=list[AgentEventResponse])
async def list_agent_events(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    agent_identity: str | None = Query(None, max_length=255),
    event_type: str | None = Query(None, max_length=100),
    room_ref: str | None = Query(None, max_length=255),
    before: datetime | None = None,
    limit: int = Query(100, ge=1, le=500),
) -> list[AgentEventResponse]:
    """Query the immutable audit stream. Admin-only, newest first."""
    _require_admin(user)
    statement = select(AgentEvent)
    instance_org = get_settings().instance_org_id
    if instance_org:
        statement = statement.where(AgentEvent.org_id == uuid.UUID(instance_org))
    if agent_identity:
        statement = statement.where(AgentEvent.agent_identity == agent_identity)
    if event_type:
        statement = statement.where(AgentEvent.event_type == event_type)
    if room_ref:
        statement = statement.where(AgentEvent.room_ref == room_ref)
    if before:
        statement = statement.where(AgentEvent.received_at < before)
    statement = statement.order_by(AgentEvent.received_at.desc()).limit(limit)
    events = (await db.execute(statement)).scalars().all()
    return [AgentEventResponse.model_validate(item) for item in events]
