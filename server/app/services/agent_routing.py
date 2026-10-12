"""Participant-owned backend routing. Room metadata never selects a backend.

Runner provisioning sets metadata.backend='runner' and canonical_dm_room to an
existing, profile-subscribed room slug. This API never provisions runner rooms.
"""
from __future__ import annotations

import uuid

from sqlalchemy import or_, select
from app.models.participant import Participant, ParticipantType
from app.models.agent_gateway_key import AgentGatewayKey
from app.models.room import Room


def participant_backend(participant) -> str:
    meta = getattr(participant, 'metadata_', None)
    meta = meta if isinstance(meta, dict) else {}
    value = meta.get('backend', 'brigade')
    return value if value in ('brigade', 'runner') else 'unknown'


def canonical_room_slug(participant) -> str | None:
    """Return the runner seat's provisioned canonical room reference.

    The reference is deliberately read from the participant-owned seat
    metadata. A room's ``brigade_agent_id`` is a resident/chat fact and must
    not be allowed to turn a runner into a Brigade agent.
    """
    meta = getattr(participant, "metadata_", None)
    if not isinstance(meta, dict):
        return None
    value = meta.get("canonical_dm_room")
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


async def find_canonical_room(db, participant):
    """Resolve a runner's metadata reference to the actual room row."""
    slug = canonical_room_slug(participant)
    if not slug:
        return None

    conditions = [Room.name == slug, Room.livekit_room_name == slug]
    try:
        conditions.append(Room.id == uuid.UUID(slug))
    except (TypeError, ValueError):
        pass
    return (
        await db.execute(
            select(Room).where(
                Room.is_archived.is_(False),
                or_(*conditions),
            )
        )
    ).scalar_one_or_none()


def canonical_room_reference(room) -> dict[str, str] | None:
    """Return the read-only room target carried to clients."""
    if room is None or getattr(room, "id", None) is None:
        return None
    name = (
        getattr(room, "display_name", None)
        or getattr(room, "name", None)
        or str(room.id)
    )
    return {"id": str(room.id), "name": str(name)}


def runner_voice_canonical_only(
    participant,
    canonical_room,
    *,
    seat: str | None = None,
) -> dict[str, str | None]:
    """Build the stable 409 detail shared by invite and call/ring."""
    if seat is None:
        subject = str(getattr(participant, "keycloak_sub", "") or "")
        seat = subject.removeprefix("brigade:") or None
    reference = canonical_room_reference(canonical_room) or {}
    return {
        "code": "runner_voice_canonical_only",
        "detail": "Open this runner's canonical chat; new runner rooms require provisioning",
        "canonical_room_id": reference.get("id"),
        "canonical_room_name": reference.get("name"),
        "seat": seat,
    }


async def find_agent_participant(db, agent_id):
    participant = (await db.execute(select(Participant).where(
        Participant.keycloak_sub == f'brigade:{agent_id}',
        Participant.participant_type == ParticipantType.AGENT,
    ))).scalar_one_or_none()
    if participant is not None:
        return participant
    # A provisioned gateway seat may not have posted yet. Do not misclassify
    # it as Brigade merely because its participant row has not been created.
    key = (await db.execute(select(AgentGatewayKey.id).where(
        AgentGatewayKey.agent_id == agent_id,
    ).limit(1))).scalar_one_or_none()
    if key is not None:
        return Participant(keycloak_sub=f"brigade:{agent_id}", metadata_={"backend": "runner"})
    return None
