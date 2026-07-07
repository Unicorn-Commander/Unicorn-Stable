from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ArtifactKind(str, enum.Enum):
    """Renderer/runtime hint for an artifact's content.

    Mirrors the Claude-Artifacts / Vercel ai-chatbot set: prose, code,
    self-contained web docs, vector graphics, diagrams, a live React
    component, and a tabular sheet.
    """

    MARKDOWN = "markdown"
    CODE = "code"
    HTML = "html"
    SVG = "svg"
    MERMAID = "mermaid"
    REACT = "react"
    SHEET = "sheet"


class ArtifactAuthorKind(str, enum.Enum):
    """Who authored a given version — a human editor or the resident agent."""

    HUMAN = "human"
    AGENT = "agent"


class Artifact(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A co-edited document ("canvas") that lives alongside a room's chat.

    Scoped to a room exactly like ``messages`` (FK → rooms, ON DELETE CASCADE).
    ``org_id`` is carried but nullable: tenancy/RLS is not enforced in the
    deployed schema yet, so this is a forward-compatible column rather than an
    enforced boundary — room membership is the live access boundary (matching
    the rest of the app). ``current_version_id`` points at the head snapshot in
    ``artifact_versions`` (nullable + ON DELETE SET NULL to avoid a circular
    NOT-NULL FK at insert time / on version restore).
    """

    __tablename__ = "artifacts"

    room_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Forward-compatible tenancy column. Nullable on purpose — see class doc.
    org_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        nullable=True,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[ArtifactKind] = mapped_column(
        Enum(
            ArtifactKind,
            name="artifact_kind_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=ArtifactKind.MARKDOWN,
    )
    # Free-form language tag for kind=code (e.g. "python", "tsx"). Nullable.
    language: Mapped[str | None] = mapped_column(String(64), nullable=True)
    current_version_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("artifact_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Same convention as Message.sender_id / Room.created_by: FK → participants,
    # SET NULL so deleting a participant doesn't cascade-delete shared work.
    created_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Relationships
    room: Mapped[Room] = relationship("Room", lazy="selectin")
    creator: Mapped[Participant | None] = relationship(
        "Participant", foreign_keys=[created_by], lazy="selectin"
    )
    # All versions of this artifact (oldest-first when loaded explicitly).
    versions: Mapped[list[ArtifactVersion]] = relationship(
        "ArtifactVersion",
        back_populates="artifact",
        primaryjoin="Artifact.id == ArtifactVersion.artifact_id",
        order_by="ArtifactVersion.seq",
        cascade="all, delete-orphan",
        lazy="noload",
    )
    current_version: Mapped[ArtifactVersion | None] = relationship(
        "ArtifactVersion",
        foreign_keys=[current_version_id],
        lazy="selectin",
        post_update=True,
    )


class ArtifactVersion(Base, UUIDPrimaryKeyMixin):
    """An immutable full-content snapshot of an artifact at a point in time.

    Snapshots, not diffs: ``content`` is the COMPLETE document for this
    version. ``seq`` is a monotonically increasing per-artifact counter
    (UNIQUE(artifact_id, seq)). ``parent_version_id`` records lineage (the
    version this one was derived from) so restores/branches are traceable.
    ``edit_op`` captures HOW this version was produced (create / rewrite /
    edit with its search-replace blocks / restore) for audit + replay.
    """

    __tablename__ = "artifact_versions"
    __table_args__ = (
        UniqueConstraint("artifact_id", "seq", name="uq_artifact_versions_artifact_id_seq"),
    )

    artifact_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("artifacts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    parent_version_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("artifact_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    author_kind: Mapped[ArtifactAuthorKind] = mapped_column(
        Enum(
            ArtifactAuthorKind,
            name="artifact_author_kind_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=ArtifactAuthorKind.HUMAN,
    )
    # FK → participants (SET NULL), same convention as messages/rooms. Agent
    # authors are the agent-typed Participant row (keycloak_sub "brigade:<id>").
    author_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    edit_op: Mapped[dict | None] = mapped_column(JSONB, nullable=True, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    artifact: Mapped[Artifact] = relationship(
        "Artifact",
        back_populates="versions",
        foreign_keys=[artifact_id],
        lazy="selectin",
    )
    parent: Mapped[ArtifactVersion | None] = relationship(
        "ArtifactVersion",
        remote_side="ArtifactVersion.id",
        foreign_keys=[parent_version_id],
        lazy="selectin",
        uselist=False,
    )
    author: Mapped[Participant | None] = relationship(
        "Participant", foreign_keys=[author_id], lazy="selectin"
    )


class ArtifactSuggestion(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """An inline, not-yet-applied suggested edit on a specific version.

    Cheap to include now; powers a later "agent proposes / human accept|reject"
    inline-diff flow (the aider/Claude SEARCH-REPLACE pattern surfaced in the
    UI instead of applied straight away). ``status`` in {pending, accepted,
    rejected}. Not wired into the REST surface in v1 — table only.
    """

    __tablename__ = "artifact_suggestions"

    artifact_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("artifacts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("artifact_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    original_text: Mapped[str] = mapped_column(Text, nullable=False)
    suggested_text: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'pending'")
    )
    created_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )

    artifact: Mapped[Artifact] = relationship(
        "Artifact", foreign_keys=[artifact_id], lazy="selectin"
    )


# Resolve forward references at module level after all models are imported.
from app.models.participant import Participant  # noqa: E402
from app.models.room import Room  # noqa: E402

__all__ = [
    "Artifact",
    "ArtifactVersion",
    "ArtifactSuggestion",
    "ArtifactKind",
    "ArtifactAuthorKind",
]
