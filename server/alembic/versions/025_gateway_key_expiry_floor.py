"""Gateway keys gain an expiry and a history floor.

Revision ID: 025_gateway_key_expiry_floor
Revises: 024_crew_seat_flags

``expires_at`` NULL means the key does not expire. ``history_from`` NULL
means the key reads a room's full history. Both stay NULL on every row
that already exists, which is exactly today's behaviour. A later mint or
PATCH is what sets them.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# NOTE: alembic_version.version_num is varchar(32) — keep ids short.
# "025_gateway_key_expiry_floor" is 28 characters.
revision: str = "025_gateway_key_expiry_floor"
down_revision: Union[str, None] = "024_crew_seat_flags"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_gateway_keys",
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_gateway_keys",
        sa.Column("history_from", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_gateway_keys", "history_from")
    op.drop_column("agent_gateway_keys", "expires_at")
