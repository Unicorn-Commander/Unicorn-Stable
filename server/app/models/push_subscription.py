from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class PushSubscription(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A browser Web-Push subscription owned by a participant.

    One participant can have many (one per browser/device). ``endpoint`` is the
    push service URL and is globally unique; ``p256dh``/``auth`` are the client
    encryption keys the server needs to encrypt payloads.
    """

    __tablename__ = "push_subscriptions"

    participant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth: Mapped[str] = mapped_column(Text, nullable=False)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
