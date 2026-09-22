"""Conversation model — agent hubs, threads, channel visibility, project
channels, per-member agent mode, invite links.

Revision ID: 021_conversation_model
Revises: 020_agent_backend

Design: docs/design/stable-ux-north-star-2026-09-21.md §3 and §9.

Everything here is ADDITIVE. No existing row changes meaning:

* ``room_type_enum`` gains ``agent_hub`` — the one canonical room per
  (human, agent) pair that holds that pair's threads. ``ADD VALUE IF NOT
  EXISTS`` is transaction-safe on PostgreSQL 12+ but the new label may not be
  USED until the transaction commits, so nothing in this revision writes it;
  the backfill (022) is the first migration that does.
* ``rooms.parent_room_id`` — a thread is a child ROOM. It inherits its
  parent's ``room_type`` (so a thread under a hub auto-answers and a thread
  under a channel answers when named) and gets every existing message, call
  and voice path for free.
* ``rooms.visibility`` — ``public`` (browse + self-join, org-scoped) or
  ``private`` (invite-only, never listed). Meaningful for channels only; DMs,
  groups and hubs are inherently private by membership.
* ``rooms.project_number`` — a channel bound to a Project-Ops project.
* ``room_members.agent_mode`` — for AGENT members only: ``answers_all`` |
  ``when_named`` | ``listening`` | ``muted``. NULL keeps today's rule
  (DM = always, channel = when @-mentioned). The same field drives voice.
* ``room_members.context_depth`` — per-room override of how much history the
  context builder hands an agent (NULL = default budget).
* ``room_invites`` — shareable member invite links (SHA-256 stored, raw value
  shown once at mint; expiry, max uses, role). Guest invites are a different
  thing (no account) and stay in ``guest_invites``.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# NOTE: alembic_version.version_num is varchar(32) — keep ids short.
# "021_conversation_model" is 22 chars.
revision = "021_conversation_model"
down_revision = "020_agent_backend"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # room_type_enum += 'agent_hub'   (see module docstring: not USED here)
    # ------------------------------------------------------------------
    op.execute("ALTER TYPE room_type_enum ADD VALUE IF NOT EXISTS 'agent_hub'")

    # ------------------------------------------------------------------
    # rooms: threads, visibility, project binding
    # ------------------------------------------------------------------
    op.add_column(
        "rooms",
        sa.Column("parent_room_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_rooms_parent_room_id_rooms",
        "rooms",
        "rooms",
        ["parent_room_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_rooms_parent_room_id", "rooms", ["parent_room_id"])

    op.add_column(
        "rooms",
        sa.Column(
            "visibility",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'public'"),
        ),
    )
    op.create_check_constraint(
        "ck_rooms_visibility",
        "rooms",
        "visibility IN ('public', 'private')",
    )

    op.add_column(
        "rooms",
        sa.Column("project_number", sa.String(length=64), nullable=True),
    )
    op.create_index("ix_rooms_project_number", "rooms", ["project_number"])

    # ------------------------------------------------------------------
    # room_members: agent mode + context depth
    # ------------------------------------------------------------------
    op.add_column(
        "room_members",
        sa.Column("agent_mode", sa.String(length=16), nullable=True),
    )
    op.create_check_constraint(
        "ck_room_members_agent_mode",
        "room_members",
        "agent_mode IS NULL OR agent_mode IN "
        "('answers_all', 'when_named', 'listening', 'muted')",
    )
    op.add_column(
        "room_members",
        sa.Column("context_depth", sa.Integer(), nullable=True),
    )

    # ------------------------------------------------------------------
    # room_invites — the shareable MEMBER invite link
    # ------------------------------------------------------------------
    op.create_table(
        "room_invites",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("uuid_generate_v4()"),
        ),
        # SHA-256 of the raw token; the raw value is returned once at mint and
        # never stored — same contract as broadcast_tokens / guest_invites.
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("token_prefix", sa.String(length=16), nullable=False),
        sa.Column(
            "room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("participants.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Role granted on accept: member | admin. Owner is never grantable by
        # a link.
        sa.Column(
            "role",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'member'"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column(
            "use_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('member', 'admin')", name="ck_room_invites_role"
        ),
    )
    op.create_index(
        "ix_room_invites_token_hash", "room_invites", ["token_hash"], unique=True
    )
    op.create_index("ix_room_invites_room_id", "room_invites", ["room_id"])


def downgrade() -> None:
    op.drop_index("ix_room_invites_room_id", table_name="room_invites")
    op.drop_index("ix_room_invites_token_hash", table_name="room_invites")
    op.drop_table("room_invites")

    op.drop_column("room_members", "context_depth")
    op.drop_constraint("ck_room_members_agent_mode", "room_members", type_="check")
    op.drop_column("room_members", "agent_mode")

    op.drop_index("ix_rooms_project_number", table_name="rooms")
    op.drop_column("rooms", "project_number")
    op.drop_constraint("ck_rooms_visibility", "rooms", type_="check")
    op.drop_column("rooms", "visibility")
    op.drop_index("ix_rooms_parent_room_id", table_name="rooms")
    op.drop_constraint("fk_rooms_parent_room_id_rooms", "rooms", type_="foreignkey")
    op.drop_column("rooms", "parent_room_id")

    # The 'agent_hub' value is deliberately LEFT on room_type_enum: PostgreSQL
    # cannot drop an enum label, and 022's downgrade removes every row that
    # uses it, so the orphan label is harmless (same stance as 014's 'guest').
