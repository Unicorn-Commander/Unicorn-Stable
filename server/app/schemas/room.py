from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class RoomCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    display_name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    room_type: str = Field("channel", pattern=r"^(channel|group_dm|dm)$")
    max_participants: int = Field(50, ge=2, le=500)


class RoomUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    is_archived: bool | None = None


class RoomMemberResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    participant_id: uuid.UUID
    username: str | None = None
    display_name: str | None = None
    participant_type: str | None = None
    role: str
    joined_at: datetime
    last_read_at: datetime | None = None
    is_muted: bool
    status: str | None = None


class RoomResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    name: str
    display_name: str
    description: str | None = None
    room_type: str
    livekit_room_name: str
    livekit_sid: str | None = None
    max_participants: int
    metadata_: dict | None = Field(None, alias="metadata_")
    is_archived: bool
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    member_count: int = 0
    online_count: int = 0


class RoomListResponse(BaseModel):
    rooms: list[RoomResponse]
    total: int
    cursor: str | None = None
