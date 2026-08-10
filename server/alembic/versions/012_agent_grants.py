"""Per-user agent access grants (allow|deny overrides of AGENT_ACCESS_DEFAULT).

Revision ID: 012_agent_grants
Revises: 011_catchup_mentions
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "012_agent_grants"
down_revision = "011_catchup_mentions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    effect = postgresql.ENUM("allow", "deny", name="agent_access_effect_enum", create_type=False)
    effect.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "agent_access_grants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False, server_default=sa.text("uuid_generate_v4()")),
        sa.Column("participant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("participants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", sa.String(length=128), nullable=False),
        sa.Column("effect", effect, nullable=False),
        sa.Column("granted_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("participants.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("participant_id", "agent_id", name="uq_agent_access_grants_participant_agent"),
    )
    op.create_index("ix_agent_access_grants_participant_id", "agent_access_grants", ["participant_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_access_grants_participant_id", table_name="agent_access_grants")
    op.drop_table("agent_access_grants")
    postgresql.ENUM(name="agent_access_effect_enum").drop(op.get_bind(), checkfirst=True)
