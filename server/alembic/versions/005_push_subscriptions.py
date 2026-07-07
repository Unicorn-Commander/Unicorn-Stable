"""Web-Push subscriptions — per-participant browser push endpoints.

Creates ``push_subscriptions`` (participant_id FK -> participants ON DELETE
CASCADE; endpoint UNIQUE; p256dh/auth client keys; user_agent for display).
Backs the VAPID web-push path (closed/backgrounded-app notifications).

Revision ID: 005
Revises: 004
Create Date: 2026-07-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "push_subscriptions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("uuid_generate_v4()"),
            nullable=False,
        ),
        sa.Column("participant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        sa.Column("auth", sa.Text(), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
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
            ["participant_id"],
            ["participants.id"],
            ondelete="CASCADE",
            name="fk_push_subscriptions_participant_id_participants",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_push_subscriptions"),
        sa.UniqueConstraint("endpoint", name="uq_push_subscriptions_endpoint"),
    )
    op.create_index(
        "ix_push_subscriptions_participant_id",
        "push_subscriptions",
        ["participant_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_push_subscriptions_participant_id", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
