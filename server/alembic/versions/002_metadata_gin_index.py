"""Add GIN index on messages.metadata for JSONB containment queries.

The /saved endpoint filters messages whose ``metadata->saved_by`` array
contains the caller's participant id, using the ``@>`` containment operator.
A GIN index on the whole ``metadata`` JSONB column makes that (and any future
metadata containment query, e.g. reactions/attachments) index-backed instead
of a full table scan.

Revision ID: 002
Revises: 001
Create Date: 2026-06-14
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Default jsonb_ops GIN index supports the @> containment operator.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_messages_metadata_gin "
        "ON messages USING gin (metadata)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_messages_metadata_gin")
