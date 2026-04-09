from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class MessageCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=32000)
    content_type: str = Field("text", pattern=r"^(text|rich|system|agent_action)$")
    metadata: dict | None = None
    parent_id: uuid.UUID | None = None


class MessageUpdate(BaseModel):
    content: str = Field(..., min_length=1, max_length=32000)


class SenderInfo(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    username: str
    display_name: str
    avatar_url: str | None = None
    participant_type: str


class MessageResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    room_id: uuid.UUID
    sender_id: uuid.UUID | None = None
    content: str
    content_type: str
    metadata_: dict | None = Field(None, alias="metadata_")
    parent_id: uuid.UUID | None = None
    is_edited: bool
    edited_at: datetime | None = None
    is_deleted: bool
    created_at: datetime
    sender: SenderInfo | None = None
    reply_count: int = 0


class MessageListResponse(BaseModel):
    messages: list[MessageResponse]
    cursor: str | None = None
    has_more: bool
