from __future__ import annotations

import uuid
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_livekit, get_settings_dep
from app.models.room import Room, RoomMember
from app.schemas.auth import TokenRequest, TokenResponse
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter()


@router.post("/tokens/livekit", response_model=TokenResponse)
async def generate_livekit_token(
    body: TokenRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> TokenResponse:
    """Generate a LiveKit access token for the authenticated user to join a room."""
    # Find the room by LiveKit room name or by room name
    result = await db.execute(
        select(Room).where(
            (Room.livekit_room_name == body.room_name)
            | (Room.name == body.room_name)
        )
    )
    room = result.scalar_one_or_none()
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Room not found",
        )

    # Verify the user is a member of this room
    membership_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room.id,
            RoomMember.participant_id == user["participant_id"],
        )
    )
    if membership_result.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of this room to get a token",
        )

    # Generate token using the participant's identity
    identity = f"{user['username']}_{user['participant_id']}"
    token = livekit.generate_token(
        room_name=room.livekit_room_name,
        identity=identity,
        name=body.participant_name or user.get("display_name", user["username"]),
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret,
    )

    logger.info(
        "livekit_token_issued",
        room=room.livekit_room_name,
        identity=identity,
    )

    return TokenResponse(
        token=token,
        ws_url=settings.livekit_url,
        room_name=room.livekit_room_name,
        participant_name=body.participant_name,
    )
