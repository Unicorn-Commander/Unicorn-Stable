from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, UUIDPrimaryKeyMixin


class ContentType(str, enum.Enum):
    TEXT = "text"
    RICH = "rich"
    SYSTEM = "system"
    AGENT_ACTION = "agent_action"


class Message(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_room_id_created_at", "room_id", "created_at", postgresql_using="btree"),
    )

    room_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sender_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[ContentType] = mapped_column(
        Enum(ContentType, name="content_type_enum", native_enum=True),
        nullable=False,
        default=ContentType.TEXT,
    )
    metadata_: Mapped[dict | None] = mapped_column(
        "metadata", JSONB, nullable=True, default=dict
    )
    parent_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    is_edited: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    edited_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    is_deleted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    room: Mapped[Room] = relationship("Room", back_populates="messages", lazy="selectin")
    sender: Mapped[Participant | None] = relationship(
        "Participant", back_populates="messages", lazy="selectin"
    )
    parent: Mapped[Message | None] = relationship(
        "Message", remote_side="Message.id", lazy="selectin", uselist=False
    )
    replies: Mapped[list[Message]] = relationship(
        "Message", back_populates="parent", lazy="noload"
    )


# Resolve forward references
from app.models.participant import Participant  # noqa: E402
from app.models.room import Room  # noqa: E402

__all__ = ["Message", "ContentType"]
