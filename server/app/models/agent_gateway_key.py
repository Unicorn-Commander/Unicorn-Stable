from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin


class AgentGatewayKey(Base, UUIDPrimaryKeyMixin):
    """ORCH-1 — a scoped credential for the public agent-gateway.

    Each key is bound to ONE ``agent_id`` (the only identity it may post as, so a
    stolen key cannot impersonate another agent) and an explicit ``allowed_rooms``
    allowlist (``["*"]`` = any room). Stored only as a SHA-256 hash — the raw key
    is shown once at mint time and never persisted. ``revoked_at`` gives instant
    per-lane revocation.
    """

    __tablename__ = "agent_gateway_keys"

    key_hash: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )
    key_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    agent_id: Mapped[str] = mapped_column(String(100), nullable=False)
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # ["*"] => any room; otherwise an allowlist of livekit_room_name / name.
    allowed_rooms: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=lambda: ["*"]
    )
    rate_limit_rpm: Mapped[int] = mapped_column(
        Integer, nullable=False, default=30
    )
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


__all__ = ["AgentGatewayKey"]
