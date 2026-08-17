"""Call-audio recording (LiveKit egress) bookkeeping + Meeting-Ops hand-off.

Revision ID: 018_call_egress
Revises: 017_guest_row_retention
Create Date: 2026-08-17

The partial unique index on room_id over non-terminal rows is the cross-worker
"start one egress per call" lease — see app/models/call_egress.py.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# NOTE: alembic_version.version_num is varchar(32) — keep ids short.
revision: str = "018_call_egress"
down_revision: Union[str, None] = "017_guest_row_retention"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "call_egresses",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("uuid_generate_v4()"),
            nullable=False,
        ),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("livekit_room_name", sa.String(length=255), nullable=False),
        sa.Column("egress_id", sa.String(length=128), nullable=True),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default=sa.text("'starting'"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("file_path", sa.String(length=1024), nullable=True),
        sa.Column("file_size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "handoff_status",
            sa.String(length=20),
            server_default=sa.text("'none'"),
            nullable=False,
        ),
        sa.Column(
            "handoff_attempts",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("handoff_next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("handoff_last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("handoff_error", sa.Text(), nullable=True),
        sa.Column("mo_session_id", sa.String(length=128), nullable=True),
        sa.Column("mo_upload_id", sa.String(length=128), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name="fk_call_egresses_room_id_rooms",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_call_egresses"),
        sa.UniqueConstraint("egress_id", name="uq_call_egresses_egress_id"),
    )
    op.create_index(
        op.f("ix_call_egresses_room_id"), "call_egresses", ["room_id"]
    )
    op.create_index(
        op.f("ix_call_egresses_status"), "call_egresses", ["status"]
    )
    op.create_index(
        op.f("ix_call_egresses_handoff_status"), "call_egresses", ["handoff_status"]
    )
    op.create_index(
        "ix_call_egresses_handoff_scan",
        "call_egresses",
        ["handoff_status", "handoff_next_attempt_at"],
    )
    # The one-recording-per-call lease (partial: terminal rows don't block a
    # later call in the same room).
    op.create_index(
        "uq_call_egresses_room_active",
        "call_egresses",
        ["room_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('starting', 'active')"),
    )


def downgrade() -> None:
    op.drop_index("uq_call_egresses_room_active", table_name="call_egresses")
    op.drop_index("ix_call_egresses_handoff_scan", table_name="call_egresses")
    op.drop_index(
        op.f("ix_call_egresses_handoff_status"), table_name="call_egresses"
    )
    op.drop_index(op.f("ix_call_egresses_status"), table_name="call_egresses")
    op.drop_index(op.f("ix_call_egresses_room_id"), table_name="call_egresses")
    op.drop_table("call_egresses")
