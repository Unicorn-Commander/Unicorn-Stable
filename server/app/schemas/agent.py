from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class AgentConfigCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    display_name: str = Field(..., min_length=1, max_length=255)
    agent_type: str = Field("custom", pattern=r"^(triage|analyst|coder|researcher|custom)$")
    model_provider: str = Field("anthropic", max_length=100)
    model_name: str = Field("claude-sonnet-4-20250514", max_length=100)
    system_prompt: str | None = None
    voice_id: str | None = None
    voice_provider: str | None = None
    capabilities: list[str] = Field(default_factory=list)
    auto_join_rooms: list[uuid.UUID] = Field(default_factory=list)
    is_persistent: bool = False
    max_concurrent_rooms: int = Field(10, ge=1, le=100)
    rate_limit_rpm: int = Field(60, ge=1, le=600)


class AgentConfigUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=255)
    agent_type: str | None = Field(None, pattern=r"^(triage|analyst|coder|researcher|custom)$")
    model_provider: str | None = Field(None, max_length=100)
    model_name: str | None = Field(None, max_length=100)
    system_prompt: str | None = None
    voice_id: str | None = None
    voice_provider: str | None = None
    capabilities: list[str] | None = None
    auto_join_rooms: list[uuid.UUID] | None = None
    is_persistent: bool | None = None
    max_concurrent_rooms: int | None = Field(None, ge=1, le=100)
    rate_limit_rpm: int | None = Field(None, ge=1, le=600)


class AgentConfigResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    participant_id: uuid.UUID
    username: str | None = None
    display_name: str | None = None
    agent_type: str
    model_provider: str
    model_name: str
    system_prompt: str | None = None
    voice_id: str | None = None
    voice_provider: str | None = None
    capabilities: list | None = None
    auto_join_rooms: list | None = None
    is_persistent: bool
    max_concurrent_rooms: int
    rate_limit_rpm: int
    created_at: datetime
    updated_at: datetime


class AgentRunResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    agent_config_id: uuid.UUID
    room_id: uuid.UUID
    action_type: str
    action_detail: dict | None = None
    status: str
    approved_by: uuid.UUID | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error_message: str | None = None


class AgentActionRequest(BaseModel):
    action_type: str = Field(..., min_length=1, max_length=100)
    action_detail: dict | None = None
    room_id: uuid.UUID
