"""Durable Stable -> Meeting-Ops transcript delivery worker."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.models.room import TranscriptExport
from app.services.meeting_ops import (
    forward_transcript_to_meeting_ops,
    meeting_ops_configured,
)

logger = structlog.get_logger(__name__)


def scoped_idempotency_key(room_id: uuid.UUID, caller_key: str) -> str:
    """Bind a caller key to one room without storing its potentially sensitive value."""
    digest = hashlib.sha256(f"{room_id}:{caller_key}".encode("utf-8")).hexdigest()
    return f"room-{digest}"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _backoff(settings: Settings, attempt: int) -> int:
    base = max(1, settings.meeting_ops_outbox_retry_base_seconds)
    maximum = max(base, settings.meeting_ops_outbox_retry_max_seconds)
    return min(maximum, base * (2 ** max(0, attempt - 1)))


async def _claim_one(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    *,
    export_id: uuid.UUID | None = None,
) -> uuid.UUID | None:
    now = _now()
    stale_cutoff = now - timedelta(minutes=2)
    eligible = or_(
        and_(
            TranscriptExport.status == "pending",
            or_(
                TranscriptExport.next_attempt_at.is_(None),
                TranscriptExport.next_attempt_at <= now,
            ),
        ),
        and_(
            TranscriptExport.status == "delivering",
            TranscriptExport.last_attempt_at < stale_cutoff,
        ),
    )
    if meeting_ops_configured(settings):
        eligible = or_(eligible, TranscriptExport.status == "blocked")

    async with session_factory() as db:
        query = (
            select(TranscriptExport)
            .where(eligible)
            .order_by(TranscriptExport.created_at.asc())
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if export_id is not None:
            query = query.where(TranscriptExport.id == export_id)
        row = (await db.execute(query)).scalar_one_or_none()
        if row is None:
            return None
        row.status = "delivering"
        row.attempt_count += 1
        row.last_attempt_at = now
        row.next_attempt_at = None
        await db.commit()
        return row.id


async def _deliver_claimed(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    export_id: uuid.UUID,
) -> None:
    async with session_factory() as db:
        row = await db.get(TranscriptExport, export_id)
        if row is None or row.status != "delivering":
            return
        payload: dict[str, Any] = dict(row.payload)
        attempt_count = row.attempt_count

    result = await forward_transcript_to_meeting_ops(
        settings=settings,
        payload=payload,
    )

    async with session_factory() as db:
        row = await db.get(TranscriptExport, export_id, with_for_update=True)
        if row is None or row.status != "delivering":
            return
        row.last_http_status = result.get("http_status")
        if result.get("forwarded"):
            row.status = "delivered"
            row.delivered_at = _now()
            row.remote_session_id = result.get("remote_session_id")
            row.remote_session_url = result.get("remote_session_url")
            row.last_error = None
            logger.info(
                "transcript_outbox_delivered",
                export_id=str(row.id),
                remote_session_id=row.remote_session_id,
                attempts=row.attempt_count,
            )
        elif not meeting_ops_configured(settings):
            row.status = "blocked"
            row.last_error = "Meeting-Ops delivery is not configured"
        elif not result.get("retryable", False):
            row.status = "failed"
            row.last_error = result.get("detail") or "Permanent Meeting-Ops rejection"
        elif attempt_count >= settings.meeting_ops_outbox_max_attempts:
            row.status = "failed"
            row.last_error = (
                result.get("detail")
                or "Meeting-Ops retry limit reached"
            )
        else:
            row.status = "pending"
            row.last_error = result.get("detail") or "Transient Meeting-Ops failure"
            row.next_attempt_at = _now() + timedelta(
                seconds=_backoff(settings, attempt_count)
            )
        await db.commit()


async def deliver_export_now(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    export_id: uuid.UUID,
) -> bool:
    """Claim and attempt one export. Returns False when it was not eligible."""
    claimed = await _claim_one(
        session_factory,
        settings,
        export_id=export_id,
    )
    if claimed is None:
        return False
    await _deliver_claimed(session_factory, settings, claimed)
    return True


async def run_transcript_outbox(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    """Continuously drain eligible rows; safe in every uvicorn worker."""
    poll = max(0.25, settings.meeting_ops_outbox_poll_seconds)
    while True:
        try:
            claimed = await _claim_one(session_factory, settings)
            if claimed is None:
                await asyncio.sleep(poll)
                continue
            await _deliver_claimed(session_factory, settings, claimed)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("transcript_outbox_worker_error")
            await asyncio.sleep(poll)
