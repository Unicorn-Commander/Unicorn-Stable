from __future__ import annotations

import uuid
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_user, get_db, get_livekit, get_presence
from app.schemas.room import (
    RoomCreate,
    RoomListResponse,
    RoomMemberResponse,
    RoomResponse,
    RoomUpdate,
)
from app.services.livekit_service import LiveKitService
from app.services.presence_service import PresenceService
from app.services.room_service import RoomService

logger = structlog.get_logger(__name__)

router = APIRouter()


def _build_room_service(
    db: AsyncSession,
    livekit: LiveKitService,
    presence: PresenceService,
) -> RoomService:
    return RoomService(db=db, livekit=livekit, presence=presence)


def _room_to_response(room: Any, member_count: int = 0, online_count: int = 0) -> RoomResponse:
    return RoomResponse(
        id=room.id,
        name=room.name,
        display_name=room.display_name,
        description=room.description,
        room_type=room.room_type.value,
        livekit_room_name=room.livekit_room_name,
        livekit_sid=room.livekit_sid,
        max_participants=room.max_participants,
        metadata_=room.metadata_,
        is_archived=room.is_archived,
        created_by=room.created_by,
        created_at=room.created_at,
        updated_at=room.updated_at,
        member_count=member_count,
        online_count=online_count,
    )


@router.post("/rooms", response_model=RoomResponse, status_code=status.HTTP_201_CREATED)
async def create_room(
    body: RoomCreate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Create a new room."""
    svc = _build_room_service(db, livekit, presence)
    room = await svc.create_room(
        name=body.name,
        display_name=body.display_name,
        room_type=body.room_type,
        creator_id=user["participant_id"],
        description=body.description,
        max_participants=body.max_participants,
    )
    return _room_to_response(room, member_count=1, online_count=1)


@router.get("/rooms", response_model=RoomListResponse)
async def list_rooms(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
) -> RoomListResponse:
    """List rooms the current user is a member of."""
    svc = _build_room_service(db, livekit, presence)
    result = await svc.list_rooms_for_user(
        participant_id=user["participant_id"],
        cursor=cursor,
        limit=limit,
    )
    rooms = [
        _room_to_response(r["room"], r["member_count"], r["online_count"])
        for r in result["rooms"]
    ]
    return RoomListResponse(
        rooms=rooms,
        total=result["total"],
        cursor=result["cursor"],
    )


@router.get("/rooms/{room_id}", response_model=RoomResponse)
async def get_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Get room details."""
    svc = _build_room_service(db, livekit, presence)
    result = await svc.get_room(room_id)
    return _room_to_response(
        result["room"],
        result["member_count"],
        result["online_count"],
    )


@router.patch("/rooms/{room_id}", response_model=RoomResponse)
async def update_room(
    room_id: uuid.UUID,
    body: RoomUpdate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Update room details. Requires admin or owner role."""
    svc = _build_room_service(db, livekit, presence)
    room = await svc.update_room(
        room_id=room_id,
        participant_id=user["participant_id"],
        display_name=body.display_name,
        description=body.description,
        is_archived=body.is_archived,
    )
    result = await svc.get_room(room_id)
    return _room_to_response(
        result["room"],
        result["member_count"],
        result["online_count"],
    )


@router.delete("/rooms/{room_id}", response_model=RoomResponse)
async def archive_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomResponse:
    """Archive a room. Requires owner role."""
    svc = _build_room_service(db, livekit, presence)
    room = await svc.archive_room(
        room_id=room_id,
        participant_id=user["participant_id"],
    )
    return _room_to_response(room)


@router.post("/rooms/{room_id}/join", response_model=RoomMemberResponse)
async def join_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> RoomMemberResponse:
    """Join a room as a member."""
    svc = _build_room_service(db, livekit, presence)
    membership = await svc.join_room(
        room_id=room_id,
        participant_id=user["participant_id"],
    )
    return RoomMemberResponse(
        id=membership.id,
        participant_id=membership.participant_id,
        username=user.get("username"),
        display_name=user.get("display_name"),
        participant_type=user.get("participant_type"),
        role=membership.role.value,
        joined_at=membership.joined_at,
        last_read_at=membership.last_read_at,
        is_muted=membership.is_muted,
        status="online",
    )


@router.post("/rooms/{room_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_room(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> None:
    """Leave a room."""
    svc = _build_room_service(db, livekit, presence)
    await svc.leave_room(
        room_id=room_id,
        participant_id=user["participant_id"],
    )


@router.get("/rooms/{room_id}/members", response_model=list[RoomMemberResponse])
async def list_members(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    presence: Annotated[PresenceService, Depends(get_presence)],
) -> list[RoomMemberResponse]:
    """List members of a room."""
    svc = _build_room_service(db, livekit, presence)
    members = await svc.get_members(room_id)
    return [
        RoomMemberResponse(
            id=m["id"],
            participant_id=m["participant_id"],
            username=m["username"],
            display_name=m["display_name"],
            participant_type=m["participant_type"],
            role=m["role"],
            joined_at=m["joined_at"],
            last_read_at=m["last_read_at"],
            is_muted=m["is_muted"],
            status=m["status"],
        )
        for m in members
    ]
