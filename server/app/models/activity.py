"""Durable, per-participant catch-up inbox events."""

from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin


class ActivityEventType(str, enum.Enum):
    MENTION = "mention"
    THREAD = "thread"
    REACTION = "reaction"


class ActivityEvent(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "activity_events"
    __table_args__ = (
        Index("ix_activity_events_participant_type_created", "participant_id", "event_type", "created_at"),
    )

    participant_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("participants.id", ondelete="CASCADE"), nullable=False)
    room_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    message_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("messages.id", ondelete="CASCADE"), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("participants.id", ondelete="SET NULL"), nullable=True)
    event_type: Mapped[ActivityEventType] = mapped_column(Enum(ActivityEventType, name="activity_event_type_enum", native_enum=True, values_callable=lambda e: [v.value for v in e]), nullable=False)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=text("now()"), index=True)


__all__ = ["ActivityEvent", "ActivityEventType"]
