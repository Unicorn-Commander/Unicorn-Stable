"""Durable Meeting-Ops transcript export outbox.

Revision ID: 007
Revises: 006
Create Date: 2026-07-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "transcript_exports",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("uuid_generate_v4()"),
            nullable=False,
        ),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("requested_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("line_count", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default=sa.text("'pending'"),
            nullable=False,
        ),
        sa.Column(
            "attempt_count",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("remote_session_id", sa.String(length=128), nullable=True),
        sa.Column("remote_session_url", sa.Text(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("last_http_status", sa.Integer(), nullable=True),
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
            ["requested_by"],
            ["participants.id"],
            name=op.f("fk_transcript_exports_requested_by_participants"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name=op.f("fk_transcript_exports_room_id_rooms"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_transcript_exports")),
        sa.UniqueConstraint(
            "idempotency_key",
            name="uq_transcript_exports_idempotency_key",
        ),
    )
    op.create_index(
        op.f("ix_transcript_exports_room_id"),
        "transcript_exports",
        ["room_id"],
    )
    op.create_index(
        op.f("ix_transcript_exports_status"),
        "transcript_exports",
        ["status"],
    )
    op.create_index(
        op.f("ix_transcript_exports_next_attempt_at"),
        "transcript_exports",
        ["next_attempt_at"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_transcript_exports_next_attempt_at"),
        table_name="transcript_exports",
    )
    op.drop_index(op.f("ix_transcript_exports_status"), table_name="transcript_exports")
    op.drop_index(op.f("ix_transcript_exports_room_id"), table_name="transcript_exports")
    op.drop_table("transcript_exports")
