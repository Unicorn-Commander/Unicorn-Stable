"""Context routes owned by lane L4 (design §4).

``POST /rooms/{room_id}/context/summarize`` — write the room's rolling
summary NOW instead of waiting for the next 50-message threshold. Owner or
admin of the room only (a real user: ``get_current_user``, so no guest,
broadcast or gateway credential reaches it). Runs the same
``context_summary.summarize_room`` the background worker runs, inline, and
returns what was stored. 503 names the missing setting when the feature is
off or unconfigured (names only, never values); 409 when another worker is
already summarizing this room; 502 when the model gateway failed.

The read side (``GET /rooms/{id}/context``) lives in api/conversation.py
and its gateway mirror in api/gateway.py.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_settings_dep
from app.models.room import MemberRole, RoomMember
from app.services.context_summary import (
    SummaryError,
    config_error,
    summarize_room,
    summary_config,
)

logger = structlog.get_logger(__name__)

router = APIRouter()

SUMMARY_PUBLIC_KEYS = ("text", "watermark", "watermark_ts", "updated_at", "message_count")


def public_summary(summary: dict[str, Any] | None) -> dict[str, Any] | None:
    """The stored summary minus anything a client has no business seeing
    (today that is only the model name, which is not secret but is ops)."""
    if not summary:
        return None
    return {k: summary.get(k) for k in SUMMARY_PUBLIC_KEYS}


@router.post("/rooms/{room_id}/context/summarize", status_code=status.HTTP_200_OK)
async def summarize_room_context(
    room_id: uuid.UUID,
    request: Request,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> dict[str, Any]:
    membership = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.participant_id == user["participant_id"],
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this room")
    if membership.role not in (MemberRole.OWNER, MemberRole.ADMIN):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Owner or admin only")

    err = config_error(summary_config(settings))
    if err:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=err)

    session_factory = request.app.state.db_session_factory
    redis = getattr(request.app.state, "redis", None)
    try:
        result = await summarize_room(session_factory, settings, room_id, redis=redis, force=True)
    except SummaryError as exc:
        logger.warning("context_summary_on_demand_failed", room_id=str(room_id), error=str(exc))
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Summary failed: {exc}")
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A summary for this room is already being written",
        )
    return {
        "room_id": str(room_id),
        "unchanged": bool(result.get("unchanged")),
        "summary": public_summary(result),
    }
