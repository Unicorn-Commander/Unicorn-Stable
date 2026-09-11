"""Participant-owned backend routing. Room metadata never selects a backend.

Runner provisioning sets metadata.backend='runner' and canonical_dm_room to an
existing, profile-subscribed room slug. This API never provisions runner rooms.
"""
from sqlalchemy import select
from app.models.participant import Participant, ParticipantType
from app.models.agent_gateway_key import AgentGatewayKey


def participant_backend(participant) -> str:
    meta = getattr(participant, 'metadata_', None)
    meta = meta if isinstance(meta, dict) else {}
    value = meta.get('backend', 'brigade')
    return value if value in ('brigade', 'runner') else 'unknown'


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
