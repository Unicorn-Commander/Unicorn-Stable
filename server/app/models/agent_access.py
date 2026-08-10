"""Per-user agent access grants.

One row = one explicit override of the instance-wide default
(``Settings.agent_access_default``, env AGENT_ACCESS_DEFAULT) for one
(human participant, Brigade agent) pair:

* default **open**  → a ``deny`` grant blocks that user from that agent;
* default **closed** → an ``allow`` grant is the only way the user reaches it.

``agent_id`` is the Brigade string id (``the-general``, ``perry``, …) — the
same id the roster carries and ``invite-brigade-agent`` receives. It is NOT a
FK: Brigade owns the agent registry, Stable does not mirror it, and a grant
must be creatable before the agent's Participant row exists locally.

Enforcement lives in ``app/services/agent_access.py`` and gates HUMAN actions
only (agent-DM creation, inviting/binding an agent into a room, the call-time
voice dispatch). The agents worker runtime and the internal/gateway surfaces
are deliberately exempt — see the service module docstring.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin


class AgentAccessEffect(str, enum.Enum):
    ALLOW = "allow"
    DENY = "deny"


class AgentAccessGrant(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "agent_access_grants"
    __table_args__ = (
        UniqueConstraint("participant_id", "agent_id", name="uq_agent_access_grants_participant_agent"),
    )

    participant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Brigade string agent id (see module docstring for why it's not a FK).
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    effect: Mapped[AgentAccessEffect] = mapped_column(
        Enum(
            AgentAccessEffect,
            name="agent_access_effect_enum",
            native_enum=True,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
    )
    # The admin who wrote the grant. SET NULL on their deletion — the grant's
    # policy effect must survive its author.
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participants.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


__all__ = ["AgentAccessGrant", "AgentAccessEffect"]
