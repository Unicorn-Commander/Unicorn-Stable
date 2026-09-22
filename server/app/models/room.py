from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class RoomType(str, enum.Enum):
    CHANNEL = "channel"
    GROUP_DM = "group_dm"
    DM = "dm"
    # The one canonical room per (human, agent) pair; its threads (child
    # rooms with parent_room_id) are the conversations. Design §3.
    AGENT_HUB = "agent_hub"


class MemberRole(str, enum.Enum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    GUEST = "guest"


#: Channel discoverability. Meaningful for CHANNEL rooms only; DM / group /
#: hub rooms are private by membership regardless of this value.
ROOM_VISIBILITIES = ("public", "private")

#: How an AGENT member behaves in one room (text AND voice share it):
#:   answers_all — replies to every message (co-host in a call)
#:   when_named  — replies only when @-mentioned / addressed by name
#:   listening   — reads (context, memory), never replies unless named — never
#:   muted       — ignores the room
#: NULL keeps the pre-contract rule (dm = always, channel = when mentioned).
AGENT_MODES = ("answers_all", "when_named", "listening", "muted")

#: rooms.recording_policy — off | on_request | always. Design §8.
RECORDING_POLICIES = ("off", "on_request", "always")
#: rooms.recording_kind / call_egresses.kind — audio | composite | track.
RECORDING_KINDS = ("audio", "composite", "track")


class Room(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "rooms"

    # Forward/tenancy column (B6). Nullable: NULL rooms are "community/public"
    # (visible on any instance); a non-NULL org_id scopes browse + self-join to
    # that org on a per-org (offering C) deployment. Stamped from
    # ``settings.instance_org_id`` at create time.
    org_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(
        String(100), unique=True, index=True, nullable=False
    )
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    room_type: Mapped[RoomType] = mapped_column(
        Enum(
            RoomType,
            name="room_type_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=RoomType.CHANNEL,
    )
    livekit_room_name: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False
    )
    livekit_sid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    max_participants: Mapped[int] = mapped_column(
        Integer, nullable=False, default=50
    )
    metadata_: Mapped[dict | None] = mapped_column(
        "metadata", JSONB, nullable=True, default=dict
    )
    is_archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    created_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    # --- conversation model (migration 021) ---
    # A thread is a child room: it inherits the parent's room_type and keeps
    # every message/call/voice path. NULL = a top-level room.
    parent_room_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # public | private (channels only — see ROOM_VISIBILITIES).
    visibility: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'public'"), default="public"
    )
    # Project-Ops binding for a project channel (e.g. "P-00115").
    project_number: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    # --- recording policy (migration 023) ---
    recording_policy: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'off'"), default="off"
    )
    recording_kind: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'audio'"), default="audio"
    )

    # Relationships
    members: Mapped[list[RoomMember]] = relationship(
        "RoomMember", back_populates="room", lazy="selectin", cascade="all, delete-orphan"
    )
    messages: Mapped[list[Message]] = relationship(
        "Message", back_populates="room", lazy="noload", cascade="all, delete-orphan"
    )
    creator: Mapped[Participant | None] = relationship(
        "Participant", foreign_keys=[created_by], lazy="selectin"
    )


class RoomMember(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "room_members"
    __table_args__ = (
        UniqueConstraint("room_id", "participant_id", name="uq_room_members_room_participant"),
    )

    room_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    participant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[MemberRole] = mapped_column(
        Enum(
            MemberRole,
            name="member_role_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=MemberRole.MEMBER,
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    last_read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    is_muted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    # Durable attention state.  Unlike unread_count (derived from a timestamp),
    # this records the messages that explicitly need the member's attention.
    mention_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    has_unread_mention: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # AGENT members only (see AGENT_MODES); NULL for humans and for agents
    # that still follow the pre-contract rule.
    agent_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Per-room override of how much history the context builder hands this
    # member (messages). NULL = the builder's default token budget.
    context_depth: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Relationships
    room: Mapped[Room] = relationship("Room", back_populates="members", lazy="selectin")
    participant: Mapped[Participant] = relationship(
        "Participant", back_populates="room_memberships", lazy="selectin"
    )


class TranscriptExport(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """Durable Stable -> Meeting-Ops delivery outbox.

    The transcript payload is committed here before any network request. A
    process-wide worker claims rows with ``FOR UPDATE SKIP LOCKED`` so Stable's
    multi-worker deployment can retry safely without duplicate deliveries.
    Meeting-Ops also de-duplicates on ``export_id``.
    """

    __tablename__ = "transcript_exports"
    __table_args__ = (
        UniqueConstraint(
            "idempotency_key",
            name="uq_transcript_exports_idempotency_key",
        ),
    )

    room_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    requested_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    line_count: Mapped[int] = mapped_column(Integer, nullable=False)
    # pending | delivering | blocked | delivered | failed | local_only
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'pending'"), index=True
    )
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0"), default=0
    )
    next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    last_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    delivered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payload_redacted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    remote_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    remote_session_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)


# Resolve forward references
from app.models.message import Message  # noqa: E402
from app.models.participant import Participant  # noqa: E402

__all__ = [
    "Room",
    "RoomMember",
    "RoomType",
    "MemberRole",
    "TranscriptExport",
    "ROOM_VISIBILITIES",
    "AGENT_MODES",
    "RECORDING_POLICIES",
    "RECORDING_KINDS",
]
