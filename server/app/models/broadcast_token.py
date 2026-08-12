from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin


class BroadcastToken(Base, UUIDPrimaryKeyMixin):
    """A scoped, expiring credential that renders ONE participant's live video
    at a URL, for OBS browser sources.

    Deliberately mirrors ``AgentGatewayKey``: only the SHA-256 hash is stored,
    the raw token is shown once at mint, and ``revoked_at`` gives instant
    revocation. It is a CREDENTIAL, not a link — it exposes a human being's
    camera with no login, so TTL is short by default.

    Scope note (documented in the threat model, not enforceable client-side):
    a LiveKit grant authorizes subscribe at ROOM granularity. The page renders
    only ``participant_identity``, but a determined holder could subscribe to
    other publishers in that room. Treat a broadcast token as a room-scoped
    VIEW credential, and never describe it as "only shows that one person".
    """

    __tablename__ = "broadcast_tokens"

    token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )
    token_prefix: Mapped[str] = mapped_column(String(16), nullable=False)

    room_id: Mapped[str] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The LiveKit identity of the participant whose video this feed renders.
    participant_identity: Mapped[str] = mapped_column(String(255), nullable=False)
    # Display label for the room's "● Broadcasting" indicator + audit surfaces.
    participant_label: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Whether the feed may also subscribe that participant's AUDIO. Default
    # False: video-only is the common OBS case and audio is the more sensitive
    # subscription, so it is opt-in at mint time, not at page-load time.
    allow_audio: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


__all__ = ["BroadcastToken"]
