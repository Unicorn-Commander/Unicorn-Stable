"""Create ``agent_gateway_keys`` — the ORCH-1 credential table that predates Alembic.

Revision ID: 018a_agent_gateway_keys
Revises: 018_call_egress
Create Date: 2026-09-18

``agent_gateway_keys`` has existed in production since ORCH-1 (commit f542ae7),
created idempotently out-of-band by ``server/migrations/agent_gateway_keys.sql``
(``CREATE TABLE IF NOT EXISTS``, "applied at deploy time" — deliberately NOT an
Alembic migration, to avoid the multi-head hazard). Because no Alembic migration
ever created it, a FRESH ``alembic upgrade head`` dies in 019_control_key_voice,
which runs ``op.add_column("agent_gateway_keys", ...)`` against a relation that
does not exist (asyncpg ``UndefinedTableError``). That is the exact "invisible on
an already-migrated database, fatal on a new install" failure the CI migration
step exists to catch.

This migration recreates exactly the ORCH-1 schema — the columns
``app/models/agent_gateway_key.py`` had at f542ae7, BEFORE ``can_manage_voice_settings``
was added in ca10334 — so 019's ``add_column`` and 020's ``SELECT`` line up
unchanged. It is inserted MID-chain (between 018 and 019) rather than appended at
head because 019's upgrade already assumes the table exists; appending a creator
AFTER 019 would leave the fresh-DB path broken at 019 first.

Existing databases are unaffected: they already carry the table from the
out-of-band SQL and are stamped at head (020), so ``alembic upgrade head`` is a
no-op there and this node never executes against a table that already exists.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# NOTE: alembic_version.version_num is varchar(32) — keep ids short.
revision: str = "018a_agent_gateway_keys"
down_revision: Union[str, None] = "018_call_egress"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_gateway_keys",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("uuid_generate_v4()"),
        ),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("key_prefix", sa.String(length=16), nullable=False),
        sa.Column("agent_id", sa.String(length=100), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=True),
        # ["*"] => any room; otherwise an allowlist of livekit_room_name / name.
        sa.Column(
            "allowed_rooms",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[\"*\"]'::jsonb"),
        ),
        sa.Column(
            "rate_limit_rpm",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("30"),
        ),
        sa.Column("created_by", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Index names match server/migrations/agent_gateway_keys.sql, so a fresh
    # alembic-migrated database is byte-identical to one created out-of-band.
    op.create_index(
        "uq_agent_gateway_keys_key_hash",
        "agent_gateway_keys",
        ["key_hash"],
        unique=True,
    )
    op.create_index(
        "ix_agent_gateway_keys_key_hash",
        "agent_gateway_keys",
        ["key_hash"],
    )


def downgrade() -> None:
    op.drop_index("ix_agent_gateway_keys_key_hash", table_name="agent_gateway_keys")
    op.drop_index("uq_agent_gateway_keys_key_hash", table_name="agent_gateway_keys")
    op.drop_table("agent_gateway_keys")
