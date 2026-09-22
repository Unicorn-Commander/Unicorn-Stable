from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin

#: Roles a link may grant. Owner is never grantable by a link.
INVITE_ROLES = ("member", "admin")


class RoomInvite(Base, UUIDPrimaryKeyMixin):
    """A shareable MEMBER invite link for a room.

    Mirrors ``BroadcastToken`` / ``GuestInvite``: only the SHA-256 hash is
    stored, the raw token is returned once at mint, ``revoked_at`` gives
    instant revocation. Accepting one runs the ordinary membership path
    (``RoomService.join_room(self_join=False)``) for a SIGNED-IN participant —
    it is how a private channel admits people. Guests (no account) are a
    different credential and live in ``guest_invites``.
    """

    __tablename__ = "room_invites"

    token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )
    token_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    room_id: Mapped[str] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_by: Mapped[str | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    role: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'member'"), default="member"
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    use_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0"), default=0
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )


__all__ = ["RoomInvite", "INVITE_ROLES"]
