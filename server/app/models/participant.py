from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ParticipantType(str, enum.Enum):
    HUMAN = "human"
    AGENT = "agent"


class ParticipantStatus(str, enum.Enum):
    ONLINE = "online"
    AWAY = "away"
    BUSY = "busy"
    OFFLINE = "offline"


class Participant(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "participants"

    keycloak_sub: Mapped[str] = mapped_column(
        String(255), unique=True, index=True, nullable=False
    )
    username: Mapped[str] = mapped_column(
        String(100), unique=True, nullable=False
    )
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    participant_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participant_type_enum", native_enum=True),
        nullable=False,
        default=ParticipantType.HUMAN,
    )
    status: Mapped[ParticipantStatus] = mapped_column(
        Enum(ParticipantStatus, name="participant_status_enum", native_enum=True),
        nullable=False,
        default=ParticipantStatus.OFFLINE,
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    metadata_: Mapped[dict | None] = mapped_column(
        "metadata", JSONB, nullable=True, default=dict
    )

    # Relationships
    agent_config: Mapped[AgentConfig | None] = relationship(
        "AgentConfig", back_populates="participant", uselist=False, lazy="selectin"
    )
    room_memberships: Mapped[list[RoomMember]] = relationship(
        "RoomMember", back_populates="participant", lazy="selectin"
    )
    messages: Mapped[list[Message]] = relationship(
        "Message", back_populates="sender", lazy="noload"
    )


# Resolve forward references at module level after all models are imported
from app.models.agent import AgentConfig  # noqa: E402
from app.models.message import Message  # noqa: E402
from app.models.room import RoomMember  # noqa: E402

__all__ = ["Participant", "ParticipantType", "ParticipantStatus"]
