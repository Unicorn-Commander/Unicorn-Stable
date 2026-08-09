from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import AliasChoices, BaseModel, Field


class MessageCreate(BaseModel):
    content: str = Field("", max_length=32000)
    content_type: str = Field(
        "text",
        # Frontend may send "image" or "file" when sending an attachment-only
        # message; allow both alongside the legacy enum values.
        pattern=r"^(text|rich|system|agent_action|image|file|action)$",
    )
    metadata: dict | None = None
    # Frontend uses thread_id; older API uses parent_id. Accept either via
    # AliasChoices so both inputs map to this single field.
    parent_id: uuid.UUID | None = Field(
        default=None,
        validation_alias=AliasChoices("parent_id", "thread_id"),
    )
    # Optional per-message LLM override (OpenWebUI-style model switcher). When
    # set, the text agent responder forwards it to Brigade as the underlying
    # model for this reply, overriding the persona's default. None = default.
    model: str | None = Field(default=None, max_length=128)
    # Client-generated idempotency id for the send-ACK protocol. The server
    # stamps it into the message's metadata (so the WS echo carries it back to
    # the sender as an acknowledgement) and dedupes a retried send on
    # (room, sender, client_msg_id) — a retry after a lost response returns
    # the already-persisted message instead of double-posting. The contract:
    # one client_msg_id == one logical message; clients must never reuse an id
    # for different content. Optional — agent/internal/legacy senders omit it.
    client_msg_id: str | None = Field(default=None, max_length=64)


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
    """Wire-format the frontend (and JS clients) consume.

    Field names mirror the TS Message interface exactly: `thread_id` not
    `parent_id`, flattened `sender_*` fields, `edited` not `is_edited`,
    `metadata` not `metadata_`. Backend internals still use the original
    column names; we serialize once on the way out.
    """

    model_config = {"from_attributes": True}

    id: uuid.UUID
    room_id: uuid.UUID
    sender_id: uuid.UUID | None = None
    sender_type: str = "human"
    sender_name: str = ""
    sender_avatar: str | None = None
    content: str
    content_type: str
    metadata: dict = Field(default_factory=dict)
    thread_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None  # legacy alias kept for any external API consumers
    edited: bool = False
    is_edited: bool = False  # legacy alias
    edited_at: datetime | None = None
    is_deleted: bool = False
    created_at: datetime
    updated_at: datetime | None = None
    sender: SenderInfo | None = None
    reply_count: int = 0


class MessageListResponse(BaseModel):
    messages: list[MessageResponse]
    cursor: str | None = None
    has_more: bool


class PendingApprovalItem(BaseModel):
    message: MessageResponse
    room_id: uuid.UUID
    room_name: str


class PendingApprovalsResponse(BaseModel):
    items: list[PendingApprovalItem]
    has_more: bool = False
