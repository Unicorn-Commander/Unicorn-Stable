"""Broadcast tokens — scoped, expiring credentials for OBS-ready participant feeds.

Revision ID: 013_broadcast_tokens
Revises: 012_agent_grants
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# NOTE: revision ids are stored in alembic_version.version_num, a varchar(32).
# "013_broadcast_tokens" is 20 chars. A 33-char id once rolled back an entire
# migration at the version stamp — keep these short.
revision = "013_broadcast_tokens"
down_revision = "012_agent_grants"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "broadcast_tokens",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("uuid_generate_v4()"),
        ),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("token_prefix", sa.String(length=16), nullable=False),
        sa.Column(
            "room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("participant_identity", sa.String(length=255), nullable=False),
        sa.Column("participant_label", sa.String(length=255), nullable=True),
        sa.Column(
            "allow_audio", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column("label", sa.String(length=255), nullable=True),
        sa.Column("created_by", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_broadcast_tokens_token_hash", "broadcast_tokens", ["token_hash"], unique=True
    )
    op.create_index("ix_broadcast_tokens_room_id", "broadcast_tokens", ["room_id"])


def downgrade() -> None:
    op.drop_index("ix_broadcast_tokens_room_id", table_name="broadcast_tokens")
    op.drop_index("ix_broadcast_tokens_token_hash", table_name="broadcast_tokens")
    op.drop_table("broadcast_tokens")
