"""JIT participant provisioning.

Pure extraction of the upsert that lived inline in ``deps.get_current_user``
so it can be exercised directly by tests. Behavior is unchanged: exact
``keycloak_sub`` match, else create; mutable Keycloak facts synced on the
match path.
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models.participant import Participant, ParticipantStatus, ParticipantType

logger = structlog.get_logger(__name__)


async def resolve_participant_for_identity(
    db: AsyncSession,
    settings: Settings,
    identity: dict[str, Any],
    claims: dict[str, Any],
) -> Participant:
    """Resolve (or JIT-provision) the Participant for a validated login."""
    result = await db.execute(
        select(Participant).where(Participant.keycloak_sub == identity["sub"])
    )
    participant = result.scalar_one_or_none()

    if participant is None:
        participant = Participant(
            keycloak_sub=identity["sub"],
            username=identity["username"],
            display_name=identity.get("display_name") or identity["username"],
            avatar_url=identity.get("avatar_url"),
            participant_type=ParticipantType(identity["participant_type"]),
            status=ParticipantStatus.ONLINE,
        )
        db.add(participant)
        await db.commit()
        await db.refresh(participant)
        logger.info(
            "participant_auto_created",
            participant_id=str(participant.id),
            username=participant.username,
        )
        return participant

    changed = False
    new_display = identity.get("display_name")
    if new_display and new_display != participant.display_name:
        participant.display_name = new_display
        changed = True
    new_avatar = identity.get("avatar_url")
    if new_avatar and new_avatar != participant.avatar_url:
        participant.avatar_url = new_avatar
        changed = True
    if changed:
        await db.commit()
        await db.refresh(participant)
    return participant
