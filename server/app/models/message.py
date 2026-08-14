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
        # "What did this participant say?" had no index at all. The guest
        # participant reaper asks it as a NOT EXISTS before it is allowed to
        # delete a retired guest (services/guest_reaper.py), and without this
        # that check is a sequential scan of the whole table per candidate row.
        # Added in alembic/versions/016_guest_participant_gc.py.
        Index("ix_messages_sender_id", "sender_id"),
    )

    room_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # NULLABLE + ``ON DELETE SET NULL``, which is exactly why a guest's
    # Participant row is TOMBSTONED rather than deleted when their session
    # dies: deleting it would not delete this message, it would silently strip
    # the sender off it and leave an unattributed hole in the room's history.
    # See services/guest_reaper.py.
    sender_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[ContentType] = mapped_column(
        Enum(
            ContentType,
            name="content_type_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
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
