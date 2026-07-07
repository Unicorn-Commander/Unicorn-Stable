"""Persistent Knowledge Bases — reusable document collections bound to rooms.

Creates ``knowledge_collections`` (a named, persistent "Knowledge Base"),
``knowledge_documents`` (each indexed source doc + its state), and
``room_knowledge`` (binds a collection to a room, UNIQUE(room_id,
collection_id)). The vectors live in the SHARED qdrant collection the doc-RAG
pipeline already uses (``stable_documents``), scoped by a ``collection_id``
payload — there is no new vector store, so nothing about qdrant changes here.

Mirrors the existing message/room/artifact scoping: created_by FK ->
participants ON DELETE SET NULL; room_id / collection_id FKs ON DELETE CASCADE;
``org_id`` is a nullable forward-compat tenancy column (RLS is NOT enforced in
the deployed schema; room membership is the live access boundary).

Revision ID: 004
Revises: 003
Create Date: 2026-06-21
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- knowledge_collections ---
    op.create_table(
        "knowledge_collections",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("uuid_generate_v4()"),
            nullable=False,
        ),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_knowledge_collections"),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["participants.id"],
            name="fk_knowledge_collections_created_by_participants",
            ondelete="SET NULL",
        ),
    )
    op.create_index(
        "ix_knowledge_collections_org_id", "knowledge_collections", ["org_id"]
    )

    # --- knowledge_documents ---
    op.create_table(
        "knowledge_documents",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("uuid_generate_v4()"),
            nullable=False,
        ),
        sa.Column("collection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("content_type", sa.String(255), nullable=True),
        sa.Column("stored_name", sa.String(255), nullable=True),
        sa.Column(
            "chunk_count", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "status", sa.String(16), server_default=sa.text("'indexing'"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_knowledge_documents"),
        sa.ForeignKeyConstraint(
            ["collection_id"],
            ["knowledge_collections.id"],
            name="fk_knowledge_documents_collection_id_knowledge_collections",
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_knowledge_documents_collection_id",
        "knowledge_documents",
        ["collection_id"],
    )

    # --- room_knowledge (room <-> collection binding) ---
    op.create_table(
        "room_knowledge",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("uuid_generate_v4()"),
            nullable=False,
        ),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("collection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_room_knowledge"),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name="fk_room_knowledge_room_id_rooms",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["collection_id"],
            ["knowledge_collections.id"],
            name="fk_room_knowledge_collection_id_knowledge_collections",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "room_id", "collection_id", name="uq_room_knowledge_room_collection"
        ),
    )
    op.create_index("ix_room_knowledge_room_id", "room_knowledge", ["room_id"])
    op.create_index(
        "ix_room_knowledge_collection_id", "room_knowledge", ["collection_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_room_knowledge_collection_id", table_name="room_knowledge")
    op.drop_index("ix_room_knowledge_room_id", table_name="room_knowledge")
    op.drop_table("room_knowledge")
    op.drop_index(
        "ix_knowledge_documents_collection_id", table_name="knowledge_documents"
    )
    op.drop_table("knowledge_documents")
    op.drop_index(
        "ix_knowledge_collections_org_id", table_name="knowledge_collections"
    )
    op.drop_table("knowledge_collections")
