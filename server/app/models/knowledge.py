"""Persistent Knowledge Bases — reusable document collections bound to rooms.

A ``KnowledgeCollection`` is a named, persistent bundle of documents (the
"Knowledge Base") that lives independently of any one room. Documents are
extracted → chunked → embedded → upserted into the SAME qdrant collection the
doc-RAG pipeline uses (``settings.rag_collection`` / ``stable_documents``),
only scoped by a ``collection_id`` payload instead of ``messages``' ``room_id``
payload. A ``RoomKnowledge`` row binds a collection to a room so the room's
agent can retrieve across every collection attached to that room.

Conventions mirror ``models/artifact.py`` and ``models/room.py`` exactly:
  * UUID pk + created_at/updated_at via the shared mixins.
  * ``created_by`` FK -> participants ON DELETE SET NULL (same as
    Artifact.created_by / Room.created_by) — deleting a participant never
    cascade-deletes shared knowledge.
  * ``org_id`` is a nullable forward-compat tenancy column (RLS is NOT enforced
    in the deployed schema; room membership is the live access boundary).
  * FK -> rooms / knowledge_collections ON DELETE CASCADE for the join + the
    documents, so detaching a room or deleting a collection cleans up rows.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class KnowledgeCollection(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A persistent, named bundle of documents (a "Knowledge Base").

    Independent of any room: bound to rooms via ``RoomKnowledge``. Its chunks
    live in the shared qdrant collection scoped by a ``collection_id`` payload.
    """

    __tablename__ = "knowledge_collections"

    # Forward-compatible tenancy column. Nullable on purpose — see module doc.
    org_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Same convention as Artifact.created_by / Room.created_by: FK ->
    # participants, SET NULL so deleting a participant doesn't delete the KB.
    created_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Relationships
    creator: Mapped[Participant | None] = relationship(
        "Participant", foreign_keys=[created_by], lazy="selectin"
    )
    documents: Mapped[list[KnowledgeDocument]] = relationship(
        "KnowledgeDocument",
        back_populates="collection",
        cascade="all, delete-orphan",
        lazy="noload",
    )


class KnowledgeDocument(Base, UUIDPrimaryKeyMixin):
    """A single source document indexed into a collection.

    Tracks the upload (``filename`` / ``content_type`` / ``stored_name`` on
    disk under ``settings.upload_dir``) plus indexing state (``status`` in
    {indexing, ready, failed} and ``chunk_count``). The vectors themselves live
    in qdrant keyed by this row's ``collection_id`` + ``document_id`` payload.
    """

    __tablename__ = "knowledge_documents"

    collection_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("knowledge_collections.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # On-disk stored name under settings.upload_dir ("<32hex>.<ext>").
    stored_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    chunk_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0"), default=0
    )
    # indexing | ready | failed
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'indexing'")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    collection: Mapped[KnowledgeCollection] = relationship(
        "KnowledgeCollection", back_populates="documents", lazy="selectin"
    )


class RoomKnowledge(Base, UUIDPrimaryKeyMixin):
    """Binds a ``KnowledgeCollection`` to a ``Room``.

    A room retrieves across every collection bound to it. UNIQUE(room_id,
    collection_id) keeps a collection attached at most once per room; both FKs
    cascade so deleting a room/collection clears the binding.
    """

    __tablename__ = "room_knowledge"
    __table_args__ = (
        UniqueConstraint(
            "room_id", "collection_id", name="uq_room_knowledge_room_collection"
        ),
    )

    room_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    collection_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("knowledge_collections.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    collection: Mapped[KnowledgeCollection] = relationship(
        "KnowledgeCollection", foreign_keys=[collection_id], lazy="selectin"
    )


# Resolve forward references at module level after all models are imported.
from app.models.participant import Participant  # noqa: E402

__all__ = [
    "KnowledgeCollection",
    "KnowledgeDocument",
    "RoomKnowledge",
]
