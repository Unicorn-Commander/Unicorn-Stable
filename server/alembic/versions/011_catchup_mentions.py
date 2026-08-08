"""Persist mention attention and the participant activity inbox.

Revision ID: 011_catchup_mentions
Revises: 010_dm_pair_unique
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "011_catchup_mentions"
down_revision = "010_dm_pair_unique"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("room_members", sa.Column("mention_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("room_members", sa.Column("has_unread_mention", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    event_type = postgresql.ENUM("mention", "thread", "reaction", name="activity_event_type_enum", create_type=False)
    event_type.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "activity_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("participant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("participants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("participants.id", ondelete="SET NULL"), nullable=True),
        sa.Column("event_type", event_type, nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_activity_events_participant_type_created", "activity_events", ["participant_id", "event_type", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_activity_events_participant_type_created", table_name="activity_events")
    op.drop_table("activity_events")
    postgresql.ENUM(name="activity_event_type_enum").drop(op.get_bind(), checkfirst=True)
    op.drop_column("room_members", "has_unread_mention")
    op.drop_column("room_members", "mention_count")
