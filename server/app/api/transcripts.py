"""Call transcript export + optional Meeting-Ops forward.

Endpoints:
  POST /api/v1/rooms/{room_id}/transcripts/export
    Accept a structured call transcript from the web client (or any member),
    validate membership, optionally POST it to Meeting-Ops when configured.

This is the federation seam for "Send to Meeting-Ops". The live caption path
(STT → LiveKit data channel → TranscriptPanel) is independent; this route is
what finalizes a call's buffer into a durable external system.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_settings_dep, rate_limit, require_room_member
from app.models.room import Room
from app.services.meeting_ops import (
    forward_transcript_to_meeting_ops,
    meeting_ops_configured,
)

logger = structlog.get_logger(__name__)

router = APIRouter()


class TranscriptLineIn(BaseModel):
    participant_id: str = Field(min_length=1, max_length=256)
    name: str = Field(default="", max_length=256)
    text: str = Field(min_length=1, max_length=8000)
    ts: int = Field(description="Epoch milliseconds when the line was produced")
    is_final: bool = True
    segment_id: str | None = Field(default=None, max_length=256)


class TranscriptExportRequest(BaseModel):
    """Structured call transcript ready for Meeting-Ops (or local accept)."""

    lines: list[TranscriptLineIn] = Field(default_factory=list, max_length=2000)
    # Only final lines are typically useful for export; client may still send
    # interims — we filter unless include_interim is set.
    include_interim: bool = False
    room_name: str | None = Field(default=None, max_length=256)
    call_started_at: str | None = Field(
        default=None,
        description="ISO-8601 when the call started, if known",
        max_length=64,
    )
    call_ended_at: str | None = Field(default=None, max_length=64)
    # Optional correlation with a Meeting-Ops session (e.g. 77fd49a9-…).
    meeting_ops_session_id: str | None = Field(default=None, max_length=128)
    # Free-form label for humans browsing the export.
    label: str | None = Field(default=None, max_length=256)
    # When false, only accept+store status locally; never forward even if
    # Meeting-Ops is configured. Default true so the UI toggle maps 1:1.
    send_to_meeting_ops: bool = True
    metadata: dict[str, Any] = Field(default_factory=dict)


class TranscriptExportResponse(BaseModel):
    ok: bool = True
    export_id: str
    room_id: str
    line_count: int
    meeting_ops_configured: bool
    meeting_ops: dict[str, Any]
    exported_at: str


@router.post(
    "/rooms/{room_id}/transcripts/export",
    response_model=TranscriptExportResponse,
    status_code=status.HTTP_200_OK,
)
async def export_room_transcript(
    room_id: uuid.UUID,
    body: TranscriptExportRequest,
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

    lines_out: list[dict[str, Any]] = []
    for line in body.lines:
        if not body.include_interim and not line.is_final:
            continue
        text = (line.text or "").strip()
        if not text:
            continue
        lines_out.append(
            {
                "participant_id": line.participant_id,
                "name": line.name or line.participant_id,
                "text": text,
                "ts": line.ts,
                "is_final": line.is_final,
                **({"segment_id": line.segment_id} if line.segment_id else {}),
            }
        )

    # Stable chronological order for consumers.
    lines_out.sort(key=lambda L: (L.get("ts") or 0, L.get("name") or ""))

    export_id = str(uuid.uuid4())
    exported_at = datetime.now(timezone.utc).isoformat()
    room_label = (
        body.room_name
        or getattr(room, "display_name", None)
        or getattr(room, "name", None)
        or str(room_id)
    )

    payload: dict[str, Any] = {
        "source": "unicorn-stable",
        "export_id": export_id,
        "exported_at": exported_at,
        "room_id": str(room_id),
        "room_name": room_label,
        "livekit_room_name": getattr(room, "livekit_room_name", None),
        "call_started_at": body.call_started_at,
        "call_ended_at": body.call_ended_at or exported_at,
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
        },
    }

    configured = meeting_ops_configured(settings)
    if body.send_to_meeting_ops and configured:
        delivery = await forward_transcript_to_meeting_ops(
            settings=settings, payload=payload
        )
    elif body.send_to_meeting_ops and not configured:
        delivery = {
            "forwarded": False,
            "status": "skipped",
            "detail": (
                "send_to_meeting_ops=true but MEETING_OPS_URL is not configured — "
                "payload accepted by Stable only"
            ),
        }
        logger.info(
            "transcript_export_local_only",
            export_id=export_id,
            room_id=str(room_id),
            line_count=len(lines_out),
        )
    else:
        delivery = {
            "forwarded": False,
            "status": "skipped",
            "detail": "send_to_meeting_ops=false — local accept only",
        }
        logger.info(
            "transcript_export_not_forwarded",
            export_id=export_id,
            room_id=str(room_id),
            line_count=len(lines_out),
        )

    return TranscriptExportResponse(
        ok=True,
        export_id=export_id,
        room_id=str(room_id),
        line_count=len(lines_out),
        meeting_ops_configured=configured,
        meeting_ops=delivery,
        exported_at=exported_at,
    )


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
    }
