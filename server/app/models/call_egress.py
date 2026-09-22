"""Call-audio recording (LiveKit egress) bookkeeping.

One row per recording attempt of one call. The partial unique index on
``room_id`` for non-terminal rows is the multi-worker lease: whichever uvicorn
worker's INSERT commits first owns starting the egress; every concurrent
webhook handler loses the INSERT race and walks away. This is deliberately a
database guard — with ``--workers 4`` an in-process dict or asyncio.Lock
guards nothing (see the Meeting-Ops double-summarizer incident).

Two independent state machines live here on purpose (a single status column
encoding both was exactly the bug class that produced the double summarizer):

* ``status``          — the egress lifecycle:
                        starting → active → stopping → complete | failed
* ``handoff_status``  — the Meeting-Ops audio delivery lifecycle:
                        none → pending → delivering → delivered
                                       ↘ failed | no_session
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

# Non-terminal egress lifecycle states covered by the room lease.
ACTIVE_EGRESS_STATUSES = ("starting", "active")


class CallEgress(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "call_egresses"
    __table_args__ = (
        Index(
            "uq_call_egresses_room_active",
            "room_id",
            unique=True,
            postgresql_where=text("status IN ('starting', 'active')"),
            sqlite_where=text("status IN ('starting', 'active')"),
        ),
        Index(
            "ix_call_egresses_handoff_scan",
            "handoff_status",
            "handoff_next_attempt_at",
        ),
    )

    room_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    livekit_room_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # LiveKit's egress id (EG_…). Null until StartEgress succeeds.
    egress_id: Mapped[str | None] = mapped_column(
        String(128), nullable=True, unique=True
    )
    # starting | active | stopping | complete | failed
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'starting'"), index=True
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Path as seen by THIS backend (shared volume mounted at the same path in
    # the egress container, so no translation is needed).
    file_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    file_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # -- Meeting-Ops audio hand-off (durable outbox semantics) --
    # none | pending | delivering | delivered | failed | no_session
    handoff_status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'none'"), index=True
    )
    handoff_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0"), default=0
    )
    handoff_next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    handoff_last_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    handoff_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Meeting-Ops public session id the audio was attached to, and the MO
    # upload job id that carried it.
    mo_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    mo_upload_id: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # -- recording policy contract (migration 023, design §8) --
    # audio | composite | track — what this egress captured.
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'audio'"), default="audio"
    )
    # Who pressed Record; NULL for a policy-driven ("always") start.
    started_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Where the finished file lives after upload (Studio Storage / Garage).
    storage_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    retention_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    legal_hold: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
