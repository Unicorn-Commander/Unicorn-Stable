"""Bound delivered transcript payload retention.

Revision ID: 009_transcript_export_retention
Revises: 008_agent_event_audit
Create Date: 2026-07-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "009_transcript_export_retention"
down_revision: Union[str, None] = "008_agent_event_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "transcript_exports",
        sa.Column("payload_redacted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("transcript_exports", "payload_redacted_at")
