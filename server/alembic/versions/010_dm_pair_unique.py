"""Unique index on human 1:1 DM pair key in rooms.metadata.

Race-safe ensureHumanDm stamps ``metadata.dm_pair`` as the sorted pair of
participant UUIDs (``uuid_a:uuid_b``). This partial unique index is the durable
DB backstop so concurrent ensures cannot insert two DM rooms for the same pair
even if advisory locks are skipped.

Revision ID: 010_dm_pair_unique
Revises: 009_transcript_export_retention
Create Date: 2026-07-30
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "010_dm_pair_unique"
down_revision: Union[str, None] = "009_transcript_export_retention"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Expression unique index: only non-archived DM rows that carry dm_pair.
    # room_type is a native enum; cast the literal so Postgres type-checks cleanly.
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_dm_pair
        ON rooms ((metadata->>'dm_pair'))
        WHERE room_type = 'dm'::room_type_enum
          AND is_archived = false
          AND metadata ? 'dm_pair'
          AND (metadata->>'dm_pair') IS NOT NULL
          AND (metadata->>'dm_pair') <> ''
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_rooms_dm_pair")
