"""Append-only agent event audit trail.

Revision ID: 008_agent_event_audit
Revises: 007_transcript_export_outbox
Create Date: 2026-07-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "008_agent_event_audit"
down_revision: Union[str, None] = "007_transcript_export_outbox"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("uuid_generate_v4()"),
            nullable=False,
        ),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("agent_identity", sa.String(length=255), nullable=False),
        sa.Column("agent_type", sa.String(length=100), nullable=False),
        sa.Column("event_type", sa.String(length=100), nullable=False),
        sa.Column("room_ref", sa.String(length=255), nullable=True),
        sa.Column("correlation_id", sa.String(length=128), nullable=True),
        sa.Column(
            "event_data",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_agent_events"),
    )
    op.create_index("ix_agent_events_org_id", "agent_events", ["org_id"])
    op.create_index(
        "ix_agent_events_agent_identity", "agent_events", ["agent_identity"]
    )
    op.create_index("ix_agent_events_event_type", "agent_events", ["event_type"])
    op.create_index("ix_agent_events_room_ref", "agent_events", ["room_ref"])
    op.create_index(
        "ix_agent_events_received_at", "agent_events", ["received_at"]
    )

    # No application endpoint can update/delete these rows, and this trigger
    # also protects against accidental ORM/admin-console mutation. Retention
    # jobs must be an explicit operator-owned database procedure.
    op.execute(
        """
        CREATE FUNCTION prevent_agent_event_mutation()
        RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'agent_events is append-only';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER agent_events_append_only
        BEFORE UPDATE OR DELETE ON agent_events
        FOR EACH ROW EXECUTE FUNCTION prevent_agent_event_mutation();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS agent_events_append_only ON agent_events")
    op.drop_table("agent_events")
    op.execute("DROP FUNCTION IF EXISTS prevent_agent_event_mutation()")
