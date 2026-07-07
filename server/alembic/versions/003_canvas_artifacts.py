"""Canvas / Artifacts — co-edited documents scoped to a room.

Creates ``artifacts``, ``artifact_versions`` (full-snapshot version history),
and ``artifact_suggestions`` (forward-looking inline accept/reject), plus their
enums. Mirrors the existing message/room scoping: room_id FK ON DELETE CASCADE,
created_by/author_id FK -> participants ON DELETE SET NULL. ``org_id`` is a
nullable forward-compat tenancy column (RLS is NOT enforced in the deployed
schema; room membership is the live access boundary).

The artifacts.current_version_id <-> artifact_versions.artifact_id pair is a
mutual FK; we create both tables first, then add the artifacts.current_version_id
FK with ALTER TABLE to avoid an ordering deadlock.

Revision ID: 003
Revises: 002
Create Date: 2026-06-21
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- Enums (create_type=False on the column refs; explicit .create here) ---
    artifact_kind_enum = postgresql.ENUM(
        "markdown", "code", "html", "svg", "mermaid", "react", "sheet",
        name="artifact_kind_enum", create_type=False,
    )
    artifact_author_kind_enum = postgresql.ENUM(
        "human", "agent", name="artifact_author_kind_enum", create_type=False,
    )
    artifact_kind_enum.create(op.get_bind(), checkfirst=True)
    artifact_author_kind_enum.create(op.get_bind(), checkfirst=True)

    # --- artifacts (current_version_id FK added after artifact_versions) ---
    op.create_table(
        "artifacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("kind", artifact_kind_enum, nullable=False, server_default="markdown"),
        sa.Column("language", sa.String(64), nullable=True),
        sa.Column("current_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_artifacts"),
        sa.ForeignKeyConstraint(
            ["room_id"], ["rooms.id"], name="fk_artifacts_room_id_rooms", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["participants.id"], name="fk_artifacts_created_by_participants", ondelete="SET NULL"
        ),
    )
    op.create_index("ix_artifacts_room_id", "artifacts", ["room_id"])
    op.create_index("ix_artifacts_org_id", "artifacts", ["org_id"])

    # --- artifact_versions ---
    op.create_table(
        "artifact_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("artifact_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("parent_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("author_kind", artifact_author_kind_enum, nullable=False, server_default="human"),
        sa.Column("author_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("edit_op", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_artifact_versions"),
        sa.UniqueConstraint("artifact_id", "seq", name="uq_artifact_versions_artifact_id_seq"),
        sa.ForeignKeyConstraint(
            ["artifact_id"], ["artifacts.id"], name="fk_artifact_versions_artifact_id_artifacts", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["parent_version_id"], ["artifact_versions.id"],
            name="fk_artifact_versions_parent_version_id_artifact_versions", ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["author_id"], ["participants.id"], name="fk_artifact_versions_author_id_participants", ondelete="SET NULL"
        ),
    )
    op.create_index("ix_artifact_versions_artifact_id", "artifact_versions", ["artifact_id"])

    # --- now the deferred artifacts.current_version_id FK ---
    op.create_foreign_key(
        "fk_artifacts_current_version_id_artifact_versions",
        "artifacts",
        "artifact_versions",
        ["current_version_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # --- artifact_suggestions (forward-looking inline accept/reject) ---
    op.create_table(
        "artifact_suggestions",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("uuid_generate_v4()"), nullable=False),
        sa.Column("artifact_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("original_text", sa.Text(), nullable=False),
        sa.Column("suggested_text", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_artifact_suggestions"),
        sa.ForeignKeyConstraint(
            ["artifact_id"], ["artifacts.id"], name="fk_artifact_suggestions_artifact_id_artifacts", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["version_id"], ["artifact_versions.id"],
            name="fk_artifact_suggestions_version_id_artifact_versions", ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["participants.id"],
            name="fk_artifact_suggestions_created_by_participants", ondelete="SET NULL",
        ),
    )
    op.create_index("ix_artifact_suggestions_artifact_id", "artifact_suggestions", ["artifact_id"])


def downgrade() -> None:
    op.drop_index("ix_artifact_suggestions_artifact_id", table_name="artifact_suggestions")
    op.drop_table("artifact_suggestions")
    op.drop_constraint(
        "fk_artifacts_current_version_id_artifact_versions", "artifacts", type_="foreignkey"
    )
    op.drop_index("ix_artifact_versions_artifact_id", table_name="artifact_versions")
    op.drop_table("artifact_versions")
    op.drop_index("ix_artifacts_org_id", table_name="artifacts")
    op.drop_index("ix_artifacts_room_id", table_name="artifacts")
    op.drop_table("artifacts")
    op.execute("DROP TYPE IF EXISTS artifact_author_kind_enum")
    op.execute("DROP TYPE IF EXISTS artifact_kind_enum")
