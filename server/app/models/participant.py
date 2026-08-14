from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Enum, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

# JSONB metadata key holding a Stable-local avatar override. Deliberately NOT a
# column: see the AVATAR RESOLUTION note on Participant below.
AVATAR_OVERRIDE_KEY = "avatar_override_url"
# JSONB metadata key holding a single-glyph emoji avatar (agents; mirrored from
# Brigade's ``avatar`` field, which is the only agent avatar that actually
# exists today).
AVATAR_EMOJI_KEY = "avatar_emoji"


class ParticipantType(str, enum.Enum):
    HUMAN = "human"
    AGENT = "agent"
    # An outsider who redeemed a room invite link. A THIRD kind, not a flavour
    # of HUMAN, and that distinction is load bearing rather than cosmetic:
    # ``people_directory`` (api/users.py) filters on ``== HUMAN`` and is
    # INSTANCE-WIDE, not room-scoped — typing guests as HUMAN would put every
    # stranger who ever joined one call into every user's People directory,
    # permanently. The same ``== HUMAN`` filter appears at ~10 other sites
    # (user search, favourites validation, mention emails, push targeting, DM
    # and group-creation targets, approver resolution, email-identity linking),
    # and a guest is correctly excluded from every one of them. Adding the
    # member here fixes all of them at once, by construction, instead of
    # bolting a "and not a guest" clause onto each and hoping the next one
    # remembers. Mirrors how ``MemberRole.GUEST`` was pre-carved in
    # models/room.py.
    #
    # Requires the value to exist in the PG type too — see
    # alembic/versions/014_guest_access.py.
    GUEST = "guest"


class ParticipantStatus(str, enum.Enum):
    ONLINE = "online"
    AWAY = "away"
    BUSY = "busy"
    OFFLINE = "offline"


class Participant(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A human or agent resident of the Stable.

    AVATAR RESOLUTION (the documented order, top wins)
    --------------------------------------------------
    1. ``avatar_override_url`` — a picture the user uploaded IN Stable. Stored
       in ``metadata->>'avatar_override_url'`` and served from our own origin.
    2. ``keycloak_avatar_url`` — the Ops-Center/Keycloak ``picture`` claim,
       mirrored here on every sign-in by ``deps.get_current_user``. This is the
       suite-wide identity and is the auto-pull half of the feature.
    3. Neither → ``None``, and the client falls back to the agent emoji glyph
       and then to initials on the identity colour (``web/src/lib/avatar.ts``).

    ``avatar_url`` is a HYBRID over 1 and 2, not a plain column. This is load
    bearing, for two reasons:

    * **The override must survive sign-in.** ``deps.get_current_user`` assigns
      ``participant.avatar_url = <keycloak picture>`` on every token exchange.
      If the override lived in that same physical column, the very next sign-in
      would silently wipe it. The hybrid's SETTER routes those writes to
      ``keycloak_avatar_url`` (the mirror), so the Keycloak half stays fresh and
      the override is untouchable from that path.
    * **~20 render sites already read ``.avatar_url``** (message_service,
      messages.py, schemas/participant, room member serialisation, ...). Making
      the hybrid the resolved value means every one of them honours an override
      with no edit. Nothing writes an override except
      ``api/participants.py``.

    The physical column is still named ``avatar_url`` — only the ORM attribute
    for it is renamed to ``keycloak_avatar_url``. There is deliberately NO
    migration: the override rides in the existing ``metadata`` JSONB so this
    ships against the live dogfood schema untouched. If it earns a column later,
    move it and keep the hybrid.
    """

    __tablename__ = "participants"
    __table_args__ = (
        # "The oldest N participants of this kind." Roughly ten sites filter
        # this table by kind (people directory, user search, agent roster,
        # push targeting, home counts) and the guest reaper walks it that way
        # on every pass in every worker. Deliberately NOT a partial index on
        # `participant_type = 'guest'`: 014 adds that enum label, and Postgres
        # refuses to USE a new label in the transaction that added it, so a
        # partial index would fail on every FRESH database while working fine
        # on every already-migrated one. See 016_guest_participant_gc.py.
        Index("ix_participants_type_created", "participant_type", "created_at"),
    )

    keycloak_sub: Mapped[str] = mapped_column(
        String(255), unique=True, index=True, nullable=False
    )
    username: Mapped[str] = mapped_column(
        String(100), unique=True, nullable=False
    )
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # The Ops-Center (Keycloak ``picture`` claim) mirror. Physical column is
    # still "avatar_url"; read it through the ``avatar_url`` hybrid unless you
    # specifically want the un-overridden suite picture.
    keycloak_avatar_url: Mapped[str | None] = mapped_column(
        "avatar_url", Text, nullable=True
    )
    participant_type: Mapped[ParticipantType] = mapped_column(
        Enum(
            ParticipantType,
            name="participant_type_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=ParticipantType.HUMAN,
    )
    status: Mapped[ParticipantStatus] = mapped_column(
        Enum(
            ParticipantStatus,
            name="participant_status_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=ParticipantStatus.OFFLINE,
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    metadata_: Mapped[dict | None] = mapped_column(
        "metadata", JSONB, nullable=True, default=dict
    )

    # ---- Avatar resolution -------------------------------------------------

    @hybrid_property
    def avatar_url(self) -> str | None:
        """The EFFECTIVE avatar: Stable override, else the Ops-Center picture."""
        meta = self.metadata_ if isinstance(self.metadata_, dict) else {}
        override = meta.get(AVATAR_OVERRIDE_KEY)
        if isinstance(override, str) and override.strip():
            return override.strip()
        return self.keycloak_avatar_url

    @avatar_url.inplace.setter
    def _avatar_url_setter(self, value: str | None) -> None:
        """Writes land on the Keycloak MIRROR, never on the override.

        ``deps.get_current_user`` does ``participant.avatar_url = <picture>``
        on every sign-in. Routing that here is what keeps a local override from
        being clobbered by the suite identity — and, symmetrically, keeps a
        local override from ever being pushed back to Keycloak.
        """
        self.keycloak_avatar_url = value

    @avatar_url.inplace.expression
    @classmethod
    def _avatar_url_expression(cls) -> Any:
        """SQL form, so ``select(Participant.avatar_url)`` matches the Python."""
        return func.coalesce(
            func.nullif(cls.metadata_[AVATAR_OVERRIDE_KEY].astext, ""),
            cls.keycloak_avatar_url,
        )

    @property
    def avatar_override_url(self) -> str | None:
        """The Stable-local override alone (None if the user hasn't set one)."""
        meta = self.metadata_ if isinstance(self.metadata_, dict) else {}
        val = meta.get(AVATAR_OVERRIDE_KEY)
        return val.strip() if isinstance(val, str) and val.strip() else None

    @property
    def avatar_emoji(self) -> str | None:
        """Single-glyph emoji avatar (agents, mirrored from Brigade)."""
        meta = self.metadata_ if isinstance(self.metadata_, dict) else {}
        val = meta.get(AVATAR_EMOJI_KEY)
        return val.strip() if isinstance(val, str) and val.strip() else None

    def set_avatar_override(self, url: str | None) -> None:
        """Set (or clear, with None) the Stable-local override.

        Reassigns ``metadata_`` rather than mutating it — SQLAlchemy does not
        track in-place mutation of a plain JSONB dict, so mutating would look
        like it worked and persist nothing.
        """
        meta = dict(self.metadata_ or {})
        if url and url.strip():
            meta[AVATAR_OVERRIDE_KEY] = url.strip()
        else:
            meta.pop(AVATAR_OVERRIDE_KEY, None)
        self.metadata_ = meta

    def set_avatar_emoji(self, emoji: str | None) -> None:
        """Set (or clear) the emoji glyph avatar. Same reassign-not-mutate rule."""
        meta = dict(self.metadata_ or {})
        if emoji and emoji.strip():
            meta[AVATAR_EMOJI_KEY] = emoji.strip()[:8]
        else:
            meta.pop(AVATAR_EMOJI_KEY, None)
        self.metadata_ = meta

    # Relationships
    agent_config: Mapped[AgentConfig | None] = relationship(
        "AgentConfig", back_populates="participant", uselist=False, lazy="selectin"
    )
    room_memberships: Mapped[list[RoomMember]] = relationship(
        "RoomMember", back_populates="participant", lazy="selectin"
    )
    messages: Mapped[list[Message]] = relationship(
        "Message", back_populates="sender", lazy="noload"
    )


# Resolve forward references at module level after all models are imported
from app.models.agent import AgentConfig  # noqa: E402
from app.models.message import Message  # noqa: E402
from app.models.room import RoomMember  # noqa: E402

__all__ = [
    "Participant",
    "ParticipantType",
    "ParticipantStatus",
    "AVATAR_OVERRIDE_KEY",
    "AVATAR_EMOJI_KEY",
]
