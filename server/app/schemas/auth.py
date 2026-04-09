from __future__ import annotations

from pydantic import BaseModel, Field


class TokenRequest(BaseModel):
    room_name: str = Field(..., min_length=1, max_length=255)
    participant_name: str = Field(..., min_length=1, max_length=255)


class TokenResponse(BaseModel):
    token: str
    ws_url: str
    room_name: str
    participant_name: str


class UserInfo(BaseModel):
    sub: str
    username: str
    email: str | None = None
    display_name: str | None = None
    roles: list[str] = Field(default_factory=list)
    participant_type: str = "human"
