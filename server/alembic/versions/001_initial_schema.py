"""Initial schema — all tables for Stable platform.

Revision ID: 001
Revises:
Create Date: 2026-04-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- Extensions (idempotent) ---
    op.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')
    op.execute('CREATE EXTENSION IF NOT EXISTS "pg_trgm"')

    # --- Enums ---
    participant_type_enum = postgresql.ENUM(
        "human", "agent", name="participant_type_enum", create_type=False
    )
    participant_status_enum = postgresql.ENUM(
        "online", "away", "busy", "offline", name="participant_status_enum", create_type=False
    )
    room_type_enum = postgresql.ENUM(
        "channel", "group_dm", "dm", name="room_type_enum", create_type=False
    )
    member_role_enum = postgresql.ENUM(
        "owner", "admin", "member", "guest", name="member_role_enum", create_type=False
    )
    content_type_enum = postgresql.ENUM(
        "text", "rich", "system", "agent_action", name="content_type_enum", create_type=False
    )
    agent_type_enum = postgresql.ENUM(
        "triage", "analyst", "coder", "researcher", "custom", name="agent_type_enum", create_type=False
    )
    agent_run_status_enum = postgresql.ENUM(
        "pending_approval", "approved", "executed", "rejected", "failed",
        name="agent_run_status_enum", create_type=False
    )

    participant_type_enum.create(op.get_bind(), checkfirst=True)
    participant_status_enum.create(op.get_bind(), checkfirst=True)
    room_type_enum.create(op.get_bind(), checkfirst=True)
    member_role_enum.create(op.get_bind(), checkfirst=True)
    content_type_enum.create(op.get_bind(), checkfirst=True)
    agent_type_enum.create(op.get_bind(), checkfirst=True)
    agent_run_status_enum.create(op.get_bind(), checkfirst=True)

    # --- participants ---
    op.create_table(
        "participants",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("keycloak_sub", sa.String(255), nullable=False),
        sa.Column("username", sa.String(100), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=False),
        sa.Column("avatar_url", sa.Text(), nullable=True),
        sa.Column("participant_type", participant_type_enum, nullable=False, server_default="human"),
        sa.Column("status", participant_status_enum, nullable=False, server_default="offline"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("metadata", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_participants"),
        sa.UniqueConstraint("keycloak_sub", name="uq_participants_keycloak_sub"),
        sa.UniqueConstraint("username", name="uq_participants_username"),
    )
    op.create_index("ix_participants_keycloak_sub", "participants", ["keycloak_sub"])
    op.create_index("ix_participants_username", "participants", ["username"])

    # --- rooms ---
    op.create_table(
        "rooms",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("room_type", room_type_enum, nullable=False, server_default="channel"),
        sa.Column("livekit_room_name", sa.String(255), nullable=False),
        sa.Column("livekit_sid", sa.String(255), nullable=True),
        sa.Column("max_participants", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("metadata", postgresql.JSONB(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_rooms"),
        sa.ForeignKeyConstraint(["created_by"], ["participants.id"], name="fk_rooms_created_by_participants", ondelete="SET NULL"),
        sa.UniqueConstraint("name", name="uq_rooms_name"),
        sa.UniqueConstraint("livekit_room_name", name="uq_rooms_livekit_room_name"),
    )
    op.create_index("ix_rooms_name", "rooms", ["name"])

    # --- room_members ---
    op.create_table(
        "room_members",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("participant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", member_role_enum, nullable=False, server_default="member"),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_muted", sa.Boolean(), nullable=False, server_default="false"),
        sa.PrimaryKeyConstraint("id", name="pk_room_members"),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], name="fk_room_members_room_id_rooms", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["participant_id"], ["participants.id"], name="fk_room_members_participant_id_participants", ondelete="CASCADE"),
        sa.UniqueConstraint("room_id", "participant_id", name="uq_room_members_room_participant"),
    )
    op.create_index("ix_room_members_room_id", "room_members", ["room_id"])
    op.create_index("ix_room_members_participant_id", "room_members", ["participant_id"])

    # --- messages ---
    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sender_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_type", content_type_enum, nullable=False, server_default="text"),
        sa.Column("metadata", postgresql.JSONB(), nullable=True),
        sa.Column("parent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("is_edited", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_messages"),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], name="fk_messages_room_id_rooms", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_id"], ["participants.id"], name="fk_messages_sender_id_participants", ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["parent_id"], ["messages.id"], name="fk_messages_parent_id_messages", ondelete="SET NULL"),
    )
    op.create_index("ix_messages_room_id", "messages", ["room_id"])
    op.create_index("ix_messages_parent_id", "messages", ["parent_id"])
    op.create_index(
        "ix_messages_room_id_created_at",
        "messages",
        ["room_id", sa.text("created_at DESC")],
    )
    # Trigram index for full-text search on message content
    op.execute(
        "CREATE INDEX ix_messages_content_trgm ON messages USING gin (content gin_trgm_ops)"
    )

    # --- agent_configs ---
    op.create_table(
        "agent_configs",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("participant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_type", agent_type_enum, nullable=False, server_default="custom"),
        sa.Column("model_provider", sa.String(100), nullable=False, server_default="'anthropic'"),
        sa.Column("model_name", sa.String(100), nullable=False, server_default="'claude-sonnet-4-20250514'"),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("voice_id", sa.String(100), nullable=True),
        sa.Column("voice_provider", sa.String(100), nullable=True),
        sa.Column("capabilities", postgresql.JSONB(), nullable=True),
        sa.Column("auto_join_rooms", postgresql.JSONB(), nullable=True),
        sa.Column("is_persistent", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("max_concurrent_rooms", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("rate_limit_rpm", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_agent_configs"),
        sa.ForeignKeyConstraint(["participant_id"], ["participants.id"], name="fk_agent_configs_participant_id_participants", ondelete="CASCADE"),
        sa.UniqueConstraint("participant_id", name="uq_agent_configs_participant_id"),
    )

    # --- agent_runs ---
    op.create_table(
        "agent_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("agent_config_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("action_type", sa.String(100), nullable=False),
        sa.Column("action_detail", postgresql.JSONB(), nullable=True),
        sa.Column("status", agent_run_status_enum, nullable=False, server_default="pending_approval"),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_agent_runs"),
        sa.ForeignKeyConstraint(["agent_config_id"], ["agent_configs.id"], name="fk_agent_runs_agent_config_id_agent_configs", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], name="fk_agent_runs_room_id_rooms", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["approved_by"], ["participants.id"], name="fk_agent_runs_approved_by_participants", ondelete="SET NULL"),
    )
    op.create_index("ix_agent_runs_agent_config_id", "agent_runs", ["agent_config_id"])
    op.create_index("ix_agent_runs_room_id", "agent_runs", ["room_id"])

    # --- updated_at trigger function ---
    op.execute("""
        CREATE OR REPLACE FUNCTION trigger_set_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    # Apply updated_at trigger to all tables with that column
    for table in ["participants", "rooms", "agent_configs"]:
        op.execute(f"""
            CREATE TRIGGER set_updated_at
            BEFORE UPDATE ON {table}
            FOR EACH ROW
            EXECUTE FUNCTION trigger_set_updated_at();
        """)


def downgrade() -> None:
    # Drop triggers
    for table in ["participants", "rooms", "agent_configs"]:
        op.execute(f"DROP TRIGGER IF EXISTS set_updated_at ON {table}")
    op.execute("DROP FUNCTION IF EXISTS trigger_set_updated_at()")

    # Drop indexes
    op.execute("DROP INDEX IF EXISTS ix_messages_content_trgm")

    # Drop tables in reverse dependency order
    op.drop_table("agent_runs")
    op.drop_table("agent_configs")
    op.drop_table("messages")
    op.drop_table("room_members")
    op.drop_table("rooms")
    op.drop_table("participants")

    # Drop enums
    for enum_name in [
        "agent_run_status_enum",
        "agent_type_enum",
        "content_type_enum",
        "member_role_enum",
        "room_type_enum",
        "participant_status_enum",
        "participant_type_enum",
    ]:
        op.execute(f"DROP TYPE IF EXISTS {enum_name}")
