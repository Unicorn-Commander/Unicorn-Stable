from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ParticipantResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    keycloak_sub: str
    username: str
    display_name: str
    avatar_url: str | None = None
    participant_type: str
    status: str
    last_seen_at: datetime | None = None
    metadata_: dict | None = Field(None, alias="metadata_")
    created_at: datetime
    updated_at: datetime


class ParticipantUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=255)
    avatar_url: str | None = None
    status: str | None = None
    metadata_: dict | None = Field(None, alias="metadata_")
