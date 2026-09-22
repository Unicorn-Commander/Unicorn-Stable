"""Recording routes — the CONTRACT half of design §8.

Policy lives on the room (``recording_policy`` / ``recording_kind``, set via
``PATCH /rooms/{id}`` by owner/admin); entitlement is the Keycloak realm role
``stable-recorder`` (granted in Ops-Center); ``call_egresses`` rows are what
``GET /rooms/{id}/recordings`` lists.

Start/stop are ROUTED and AUTHORIZED here but deliberately answer 409 until
the recording lane (L8s) wires them to the egress service: a room whose
policy is ``off`` answers 403 first, so the policy check is already real.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_db, require_room_member
from app.models.call_egress import CallEgress
from app.models.room import Room
from app.schemas.room import RecordingResponse

logger = structlog.get_logger(__name__)

router = APIRouter()

#: Keycloak realm role that entitles a user to start server-side recording.
RECORDER_ROLE = "stable-recorder"


class RecordingStartBody(BaseModel):
    kind: Literal["audio", "composite"] | None = None


def user_may_record(user: dict[str, Any]) -> bool:
    roles = user.get("roles") or []
    try:
        return RECORDER_ROLE in set(roles)
    except TypeError:
        return False


async def _load_room(db: AsyncSession, room_id: uuid.UUID) -> Room:
    room = (await db.execute(select(Room).where(Room.id == room_id))).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return room


def _policy_gate(room: Room, user: dict[str, Any]) -> None:
    policy = getattr(room, "recording_policy", "off")
    if policy == "off":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Recording is off for this room",
        )
    if not user_may_record(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not entitled to record; ask an admin for the recorder role",
        )


@router.post("/rooms/{room_id}/recording/start", status_code=status.HTTP_202_ACCEPTED)
async def start_recording(
    room_id: uuid.UUID,
    body: RecordingStartBody | None,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    room = await _load_room(db, room_id)
    _policy_gate(room, user)
    # L8s replaces this with call_recording.start_recording(kind, started_by).
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Recording controls are not enabled yet",
    )


@router.post("/rooms/{room_id}/recording/stop", status_code=status.HTTP_202_ACCEPTED)
async def stop_recording(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    room = await _load_room(db, room_id)
    _policy_gate(room, user)
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Recording controls are not enabled yet",
    )


@router.get("/rooms/{room_id}/recordings", response_model=list[RecordingResponse])
async def list_recordings(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(50, ge=1, le=200),
) -> list[RecordingResponse]:
    """The room's recordings (every member may see THAT a call was recorded;
    the file itself is served by the storage layer with its own ACL)."""
    rows = (
        await db.execute(
            select(CallEgress)
            .where(CallEgress.room_id == room_id)
            .order_by(CallEgress.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [RecordingResponse.model_validate(r) for r in rows]
