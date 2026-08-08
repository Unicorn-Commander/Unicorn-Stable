from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.message import MessageResponse


class RoomCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    display_name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    room_type: str = Field("channel", pattern=r"^(channel|group_dm|dm)$")
    max_participants: int = Field(50, ge=2, le=500)


class EnsureHumanDmBody(BaseModel):
    """Body for ``POST /api/v1/dms/ensure`` — idempotent 1:1 human DM."""

    participant_id: uuid.UUID


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
    is_self: bool = False
    # Redis-derived live presence. The canonical boolean the web roster reads;
    # `status` carries the same fact as a string for status-shaped consumers.
    is_online: bool = False
    status: str | None = None
    # The participant's picture (mirror/override hybrid, same value messages
    # carry as sender_avatar) + emoji tier. Absent for years, which made every
    # members-driven surface — roster strip, "seen by", the DM hero — render
    # initials for humans AND agents no matter how much art existed.
    avatar_url: str | None = None
    avatar_emoji: str | None = None
    # AGENTS ONLY (null for humans) — a deliberately separate fact from
    # `is_online`. Presence means "a client is connected"; availability means
    # "this agent can be invoked right now" (Brigade has it enabled, or a
    # bridge session is actively polling the gateway). One of "available",
    # "unavailable", "unknown"; `availability_reason` is a short tag the UI
    # renders as a tooltip so an un-lit agent can explain itself.
    availability: str | None = None
    availability_reason: str | None = None


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
    # Conversation-list extras (populated by list_rooms_for_user): the latest
    # non-deleted message in the room, and the caller's unread count since their
    # last_read_at. Both let the sidebar + home feed show previews and badges
    # on cold load. Default to empty so other RoomResponse callers are unaffected.
    unread_count: int = 0
    mention_count: int = 0
    has_unread_mention: bool = False
    last_message: MessageResponse | None = None


class EnsureHumanDmResponse(RoomResponse):
    """Room payload for ensure-DM; ``created`` is True when this call inserted it."""

    created: bool = False


class RoomListResponse(BaseModel):
    rooms: list[RoomResponse]
    total: int
    cursor: str | None = None


class RoomPresenceResponse(BaseModel):
    """Snapshot of who is currently online in a room.

    ``online`` is a list of Participant IDs (Participant.id) — the same identity
    the web roster matches its online dot on and the WS presence event carries.
    """

    online: list[str]
