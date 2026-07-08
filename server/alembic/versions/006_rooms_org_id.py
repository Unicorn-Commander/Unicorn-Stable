"""Rooms org_id — tenancy column for channel browse/self-join scoping (B6).

Adds a nullable, indexed ``org_id`` to ``rooms`` (mirrors the existing
``knowledge_collections.org_id`` from 004). NULL = community/public room
(visible on any instance); a non-NULL org_id scopes discovery + self-join to
that org on a per-org (offering C) deployment. Nullable + no backfill: existing
rooms stay org-less (community semantics) until re-stamped, so the migration is
safe to apply to a live single-org instance with zero behavior change.

Revision ID: 006
Revises: 005
Create Date: 2026-07-08
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index("ix_rooms_org_id", "rooms", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_rooms_org_id", table_name="rooms")
    op.drop_column("rooms", "org_id")
