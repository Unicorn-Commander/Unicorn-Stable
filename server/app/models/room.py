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


class MemberRole(str, enum.Enum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    GUEST = "guest"


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

    # Relationships
    room: Mapped[Room] = relationship("Room", back_populates="members", lazy="selectin")
    participant: Mapped[Participant] = relationship(
        "Participant", back_populates="room_memberships", lazy="selectin"
    )


# Resolve forward references
from app.models.message import Message  # noqa: E402
from app.models.participant import Participant  # noqa: E402

__all__ = ["Room", "RoomMember", "RoomType", "MemberRole"]
