"""Guest access — the two rows behind "an outsider is on the show".

TWO TABLES, NOT ONE, and the split is the security boundary:

* ``GuestInvite`` is the SHAREABLE thing. The owner mints it, pastes the link
  into a DM/email, and it may be redeemed by several people (``max_uses``).
  Because it is shareable it is never itself an API credential — no route
  accepts an invite token except ``POST /guest/redeem``.
* ``GuestSession`` is the PER-PERSON credential minted at redemption. It is
  what the browser holds and presents, it names exactly one Participant and
  exactly one room, and it can be revoked on its own (boot one troll) or as a
  cascade from its invite (kill the link, kill everyone who used it).

Both deliberately mirror ``AgentGatewayKey`` / ``BroadcastToken``: SHA-256 at
rest, raw value returned once at mint, ``revoked_at`` for instant revocation,
prefix-only in logs. The identity a session confers is DERIVED from the row
(``participant_id``, ``room_id``) and never read off the request, so a guest
cannot claim to be someone else or to be in some other room.

WHY ``room_id`` IS ON BOTH ROWS
-------------------------------
``GuestSession.room_id`` is denormalized from its invite. It is the value the
authorization path reads, so the scope check is a single row already in hand
rather than a join that a future refactor could drop. The redemption handler is
the ONLY writer and copies it from the invite; nothing else may change it, and
a session's room must never be re-pointed (that would silently move a live
guest into a different room).

WHAT IS NOT HERE
----------------
No email, no Keycloak subject, no realm identity of any kind. A guest exists
only inside Stable (see ``app/auth/guest_auth.py`` for why routing guests
through OIDC would auto-create real accounts for strangers).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin


class GuestInvite(Base, UUIDPrimaryKeyMixin):
    """A room owner's shareable, expiring, revocable invitation to ONE room."""

    __tablename__ = "guest_invites"

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

    # Optional second factor, typed by the guest. Stored as
    # ``pbkdf2_sha256$<iters>$<salt>$<hash>`` — NEVER plaintext, NEVER a bare
    # digest of a human-chosen word. Compared in constant time; see
    # app/auth/guest_auth.py:verify_passphrase.
    passphrase_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Whether guests redeemed from this invite may publish camera/mic. Default
    # True: a guest is a guest ON the show, so A/V is the point. False mints a
    # watch-only guest, which is the safer choice for a large public link.
    can_publish: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    # NULL = unlimited redemptions. Enforced by an atomic conditional UPDATE at
    # redemption (see api/guests.py), never by a read-then-write, so two guests
    # racing on the last seat cannot both win.
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    use_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[str | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
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


class GuestSession(Base, UUIDPrimaryKeyMixin):
    """One redeemed guest: a credential bound to one Participant + one room.

    Revocation is checked on EVERY request against both this row and its
    invite, so "the owner killed the link" takes effect on the next call even
    if the force-disconnect fan-out (ws/handler.py) was missed — the socket
    close is the fast path, the credential check is the correct one.
    """

    __tablename__ = "guest_sessions"

    token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )
    token_prefix: Mapped[str] = mapped_column(String(16), nullable=False)

    invite_id: Mapped[str] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("guest_invites.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Denormalized from the invite; see the module docstring. This is the value
    # the authorization path compares a requested room against.
    room_id: Mapped[str] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    participant_id: Mapped[str] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # The guest's self-chosen name, kept here for audit even after the
    # Participant row is renamed or reaped. UNTRUSTED TEXT: length-capped and
    # control-character-stripped at redemption, never used for authorization.
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)

    # Copied from the invite at redemption so an in-flight session keeps the
    # A/V grant it was issued under.
    can_publish: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    # Never later than the invite's own expiry (enforced at redemption).
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


__all__ = ["GuestInvite", "GuestSession"]
