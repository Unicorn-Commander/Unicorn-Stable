"""Durable call transcript export and Meeting-Ops delivery.

Endpoints:
  POST /api/v1/rooms/{room_id}/transcripts/export
    Accept a structured call transcript from the web client (or any member),
    validate membership, persist an outbox row, and deliver it to Meeting-Ops.

This is the federation seam for "Send to Meeting-Ops". The live caption path
(STT → LiveKit data channel → TranscriptPanel) is independent; this route is
what finalizes a call's buffer into a durable external system.
"""

from __future__ import annotations

import uuid
import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_settings_dep, rate_limit, require_room_member
from app.models.participant import Participant
from app.models.room import Room, RoomMember, TranscriptExport
from app.services.meeting_ops import meeting_ops_configured
from app.services.transcript_outbox import deliver_export_now, scoped_idempotency_key
from app.services.transcript_identity import (
    TranscriptIdentityError,
    authorize_transcript_line,
)

logger = structlog.get_logger(__name__)

router = APIRouter()


class TranscriptLineIn(BaseModel):
    participant_id: str = Field(min_length=1, max_length=256)
    name: str = Field(default="", max_length=256)
    text: str = Field(min_length=1, max_length=8000)
    ts: int = Field(
        ge=0,
        description="Epoch milliseconds when the line was produced",
    )
    is_final: bool = True
    segment_id: str | None = Field(default=None, max_length=256)
    source: Literal["local_mic", "agent_stt", "agent", "unknown"] = "unknown"


class TranscriptExportRequest(BaseModel):
    """Structured call transcript ready for Meeting-Ops (or local accept)."""

    lines: list[TranscriptLineIn] = Field(default_factory=list, max_length=2000)
    # Only final lines are typically useful for export; client may still send
    # interims — we filter unless include_interim is set.
    include_interim: bool = False
    room_name: str | None = Field(default=None, max_length=256)
    call_started_at: datetime | None = Field(
        default=None,
        description="ISO-8601 when the call started, if known",
    )
    call_ended_at: datetime | None = None
    # Optional correlation with a Meeting-Ops session (e.g. 77fd49a9-…).
    meeting_ops_session_id: str | None = Field(default=None, max_length=128)
    # Free-form label for humans browsing the export.
    label: str | None = Field(default=None, max_length=256)
    # When false, only accept+store status locally; never forward even if
    # Meeting-Ops is configured. Default true so the UI toggle maps 1:1.
    send_to_meeting_ops: bool = True
    # Optional caller-generated key. When absent Stable derives one from the
    # room, call-start clock, and canonical transcript content.
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=128)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("call_started_at", "call_ended_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("timestamp must include a timezone")
        return value.astimezone(timezone.utc) if value is not None else None


class TranscriptExportResponse(BaseModel):
    ok: bool = True
    export_id: str
    room_id: str
    line_count: int
    meeting_ops_configured: bool
    meeting_ops: dict[str, Any]
    exported_at: str
    status_url: str


def _delivery_dict(row: TranscriptExport, configured: bool) -> dict[str, Any]:
    return {
        "forwarded": row.status == "delivered",
        "status": row.status,
        "detail": row.last_error,
        "http_status": row.last_http_status,
        "remote_session_id": row.remote_session_id,
        "remote_session_url": row.remote_session_url,
        "configured": configured,
        "attempt_count": row.attempt_count,
        "next_attempt_at": (
            row.next_attempt_at.isoformat() if row.next_attempt_at else None
        ),
    }


def _response(
    row: TranscriptExport,
    *,
    configured: bool,
) -> TranscriptExportResponse:
    return TranscriptExportResponse(
        export_id=str(row.id),
        room_id=str(row.room_id),
        line_count=row.line_count,
        meeting_ops_configured=configured,
        meeting_ops=_delivery_dict(row, configured),
        exported_at=row.created_at.isoformat(),
        status_url=f"/api/v1/rooms/{row.room_id}/transcripts/exports/{row.id}",
    )


@router.post(
    "/rooms/{room_id}/transcripts/export",
    response_model=TranscriptExportResponse,
    status_code=status.HTTP_200_OK,
)
async def export_room_transcript(
    room_id: uuid.UUID,
    body: TranscriptExportRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    _rl: Annotated[
        None, Depends(rate_limit("transcript_export", "rate_limit_message_send_per_min"))
    ] = None,
) -> TranscriptExportResponse:
    """Finalize a call transcript and optionally forward it to Meeting-Ops.

    Auth: room member (same gate as chat). Rate-limited like message send.
    """
    room = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")

    room_participants = (
        (
            await db.execute(
                select(Participant)
                .join(RoomMember, RoomMember.participant_id == Participant.id)
                .where(RoomMember.room_id == room_id)
            )
        )
        .scalars()
        .all()
    )
    lines_out: list[dict[str, Any]] = []
    for line in body.lines:
        if not body.include_interim and not line.is_final:
            continue
        text = (line.text or "").strip()
        if not text:
            continue
        try:
            lines_out.append(
                authorize_transcript_line(
                    line,
                    room_participants=room_participants,
                )
            )
        except TranscriptIdentityError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            )

    # Stable chronological order for consumers.
    lines_out.sort(key=lambda L: (L.get("ts") or 0, L.get("name") or ""))
    if not lines_out:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one non-empty final transcript line is required",
        )

    exported_at = datetime.now(timezone.utc).isoformat()
    room_label = (
        body.room_name
        or getattr(room, "display_name", None)
        or getattr(room, "name", None)
        or str(room_id)
    )

    canonical = {
        "room_id": str(room_id),
        "room_name": body.room_name,
        "call_started_at": (
            body.call_started_at.isoformat() if body.call_started_at else None
        ),
        "call_ended_at": (
            body.call_ended_at.isoformat() if body.call_ended_at else None
        ),
        "meeting_ops_session_id": body.meeting_ops_session_id,
        "label": body.label,
        "send_to_meeting_ops": body.send_to_meeting_ops,
        "metadata": body.metadata,
        "lines": lines_out,
    }
    payload_sha256 = hashlib.sha256(
        json.dumps(
            canonical,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    caller_idempotency_key = body.idempotency_key or f"stable-{payload_sha256}"
    idempotency_key = scoped_idempotency_key(room_id, caller_idempotency_key)
    export_uuid = uuid.uuid5(uuid.NAMESPACE_URL, f"unicorn-stable:{idempotency_key}")

    existing = (
        await db.execute(
            select(TranscriptExport).where(
                TranscriptExport.idempotency_key == idempotency_key
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.payload_sha256 != payload_sha256:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Idempotency key was already used for different transcript content",
            )
        return _response(
            existing,
            configured=meeting_ops_configured(settings),
        )

    payload: dict[str, Any] = {
        "source": "unicorn-stable",
        "export_id": str(export_uuid),
        "exported_at": exported_at,
        "room_id": str(room_id),
        "room_name": room_label,
        "livekit_room_name": getattr(room, "livekit_room_name", None),
        "call_started_at": (
            body.call_started_at.isoformat() if body.call_started_at else None
        ),
        "call_ended_at": (
            body.call_ended_at.isoformat() if body.call_ended_at else exported_at
        ),
        "label": body.label or f"Stable call · {room_label}",
        "meeting_ops_session_id": body.meeting_ops_session_id,
        "exporter": {
            "participant_id": str(user.get("participant_id") or ""),
            "username": user.get("username"),
            "display_name": user.get("display_name"),
        },
        "line_count": len(lines_out),
        "lines": lines_out,
        "metadata": {
            **(body.metadata or {}),
            "send_to_meeting_ops": body.send_to_meeting_ops,
            "transcript_content_verification": "client_relay_unattested",
        },
    }

    configured = meeting_ops_configured(settings)
    initial_status = (
        "pending"
        if body.send_to_meeting_ops and configured
        else "blocked"
        if body.send_to_meeting_ops
        else "local_only"
    )
    outbox = TranscriptExport(
        id=export_uuid,
        room_id=room_id,
        requested_by=uuid.UUID(str(user["participant_id"])),
        idempotency_key=idempotency_key,
        payload_sha256=payload_sha256,
        payload=payload,
        line_count=len(lines_out),
        status=initial_status,
        last_error=(
            None
            if initial_status == "pending"
            else "Meeting-Ops delivery is not configured"
            if initial_status == "blocked"
            else "Stored in Stable; Meeting-Ops delivery was not requested"
        ),
    )
    db.add(outbox)
    try:
        await db.commit()
        await db.refresh(outbox)
    except IntegrityError:
        await db.rollback()
        existing = (
            await db.execute(
                select(TranscriptExport).where(
                    TranscriptExport.idempotency_key == idempotency_key
                )
            )
        ).scalar_one()
        if existing.payload_sha256 != payload_sha256:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Idempotency key was already used for different transcript content",
            )
        return _response(existing, configured=configured)

    logger.info(
        "transcript_export_persisted",
        export_id=str(outbox.id),
        room_id=str(room_id),
        line_count=outbox.line_count,
        delivery_status=outbox.status,
    )
    if outbox.status == "pending":
        # Fast first attempt after the response. The database row is already
        # committed, so process death here is harmless: the startup worker
        # claims it (or recovers a stale delivering row) later.
        background_tasks.add_task(
            deliver_export_now,
            request.app.state.db_session_factory,
            settings,
            outbox.id,
        )
    return _response(outbox, configured=configured)


@router.get(
    "/rooms/{room_id}/transcripts/exports/{export_id}",
    response_model=TranscriptExportResponse,
)
async def get_transcript_export(
    room_id: uuid.UUID,
    export_id: uuid.UUID,
    _user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> TranscriptExportResponse:
    row = (
        await db.execute(
            select(TranscriptExport).where(
                TranscriptExport.id == export_id,
                TranscriptExport.room_id == room_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Transcript export not found")
    return _response(row, configured=meeting_ops_configured(settings))


@router.post(
    "/rooms/{room_id}/transcripts/exports/{export_id}/retry",
    response_model=TranscriptExportResponse,
)
async def retry_transcript_export(
    room_id: uuid.UUID,
    export_id: uuid.UUID,
    request: Request,
    background_tasks: BackgroundTasks,
    _user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> TranscriptExportResponse:
    row = (
        await db.execute(
            select(TranscriptExport)
            .where(
                TranscriptExport.id == export_id,
                TranscriptExport.room_id == room_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Transcript export not found")
    if row.status != "delivered":
        row.status = "pending" if meeting_ops_configured(settings) else "blocked"
        row.attempt_count = 0
        row.next_attempt_at = None
        row.last_error = (
            None if row.status == "pending" else "Meeting-Ops delivery is not configured"
        )
        await db.commit()
        await db.refresh(row)
        if row.status == "pending":
            background_tasks.add_task(
                deliver_export_now,
                request.app.state.db_session_factory,
                settings,
                row.id,
            )
    return _response(row, configured=meeting_ops_configured(settings))


@router.get("/transcripts/meeting-ops/status")
async def meeting_ops_status(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> dict[str, Any]:
    """Lightweight probe so the UI can show whether Meeting-Ops is wired.

    Does not expose secrets — only whether a URL is configured + enabled.
    """
    _ = user  # auth required
    return {
        "configured": meeting_ops_configured(settings),
        "enabled": bool(settings.meeting_ops_enabled),
        "has_url": bool((settings.meeting_ops_url or "").strip()),
        "has_api_key": bool((settings.meeting_ops_api_key or "").strip()),
        "has_org_slug": bool((settings.meeting_ops_org_slug or "").strip()),
    }
