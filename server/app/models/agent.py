from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class AgentType(str, enum.Enum):
    TRIAGE = "triage"
    ANALYST = "analyst"
    CODER = "coder"
    RESEARCHER = "researcher"
    CUSTOM = "custom"


class AgentRunStatus(str, enum.Enum):
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    EXECUTED = "executed"
    REJECTED = "rejected"
    FAILED = "failed"


class AgentConfig(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "agent_configs"

    participant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )
    agent_type: Mapped[AgentType] = mapped_column(
        Enum(
            AgentType,
            name="agent_type_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=AgentType.CUSTOM,
    )
    model_provider: Mapped[str] = mapped_column(
        String(100), nullable=False, default="anthropic"
    )
    model_name: Mapped[str] = mapped_column(
        String(100), nullable=False, default="claude-sonnet-4-20250514"
    )
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    voice_provider: Mapped[str | None] = mapped_column(String(100), nullable=True)
    capabilities: Mapped[list | None] = mapped_column(
        JSONB, nullable=True, default=list
    )
    auto_join_rooms: Mapped[list | None] = mapped_column(
        JSONB, nullable=True, default=list
    )
    is_persistent: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    max_concurrent_rooms: Mapped[int] = mapped_column(
        Integer, nullable=False, default=10
    )
    rate_limit_rpm: Mapped[int] = mapped_column(
        Integer, nullable=False, default=60
    )

    # Relationships
    participant: Mapped[Participant] = relationship(
        "Participant", back_populates="agent_config", lazy="selectin"
    )
    runs: Mapped[list[AgentRun]] = relationship(
        "AgentRun", back_populates="agent_config", lazy="noload"
    )


class AgentRun(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "agent_runs"

    agent_config_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_configs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    room_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    action_type: Mapped[str] = mapped_column(String(100), nullable=False)
    action_detail: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True, default=dict
    )
    status: Mapped[AgentRunStatus] = mapped_column(
        Enum(
            AgentRunStatus,
            name="agent_run_status_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=AgentRunStatus.PENDING_APPROVAL,
    )
    approved_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Relationships
    agent_config: Mapped[AgentConfig] = relationship(
        "AgentConfig", back_populates="runs", lazy="selectin"
    )
    room: Mapped[Room] = relationship("Room", lazy="selectin")
    approver: Mapped[Participant | None] = relationship(
        "Participant", foreign_keys=[approved_by], lazy="selectin"
    )


class AgentEvent(Base, UUIDPrimaryKeyMixin):
    """Append-only audit record received from a Stable agent worker."""

    __tablename__ = "agent_events"

    org_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    agent_identity: Mapped[str] = mapped_column(
        String(255), nullable=False, index=True
    )
    agent_type: Mapped[str] = mapped_column(String(100), nullable=False)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    room_ref: Mapped[str | None] = mapped_column(
        String(255), nullable=True, index=True
    )
    correlation_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    event_data: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        index=True,
    )


# Resolve forward references
from app.models.participant import Participant  # noqa: E402
from app.models.room import Room  # noqa: E402

__all__ = [
    "AgentConfig",
    "AgentRun",
    "AgentEvent",
    "AgentType",
    "AgentRunStatus",
]
