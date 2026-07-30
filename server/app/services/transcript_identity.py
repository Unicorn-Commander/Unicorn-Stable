"""Server-side speaker authority for browser-finalized call transcripts."""

from __future__ import annotations

import uuid
from typing import Any, Iterable

from app.models.participant import Participant, ParticipantType


class TranscriptIdentityError(ValueError):
    """A transcript line asserted an identity the room cannot authorize."""


def _participant_aliases(participant: Participant) -> set[str]:
    participant_id = str(participant.id)
    aliases = {participant_id, participant.username}
    if participant.participant_type == ParticipantType.AGENT:
        keycloak_sub = participant.keycloak_sub or ""
        if keycloak_sub.startswith("brigade:"):
            brigade_id = keycloak_sub.removeprefix("brigade:")
            aliases.update(
                {
                    brigade_id,
                    f"agent-{brigade_id}",
                    f"agent-brigade-{brigade_id}",
                }
            )
    return {alias for alias in aliases if alias}


def _uuid_from_livekit_identity(value: str) -> str | None:
    candidate = value.rsplit("_", 1)[-1]
    try:
        return str(uuid.UUID(candidate))
    except (TypeError, ValueError):
        return None


def authorize_transcript_line(
    line: Any,
    *,
    room_participants: Iterable[Participant],
) -> dict[str, Any]:
    """Resolve one client line to a canonical room-member identity.

    Names and participant IDs in the request are assertions, never authority.
    Human LiveKit identities are resolved by their UUID suffix. Agent aliases
    must match a known agent member; the generic current Brigade worker identity
    is accepted only when the room has exactly one known agent.
    """
    participants = list(room_participants)
    raw_id = str(line.participant_id or "").strip()
    by_alias: dict[str, Participant] = {}
    for participant in participants:
        for alias in _participant_aliases(participant):
            by_alias[alias] = participant

    participant = by_alias.get(raw_id)
    uuid_alias = _uuid_from_livekit_identity(raw_id)
    if participant is None and uuid_alias:
        participant = by_alias.get(uuid_alias)
    if participant is None and raw_id == "agent-brigade":
        agents = [
            item
            for item in participants
            if item.participant_type == ParticipantType.AGENT
        ]
        if len(agents) == 1:
            participant = agents[0]
    if participant is None:
        raise TranscriptIdentityError(
            "Transcript speaker is not a known member of this room"
        )

    source = str(line.source)
    is_agent = participant.participant_type == ParticipantType.AGENT
    if source == "agent" and not is_agent:
        raise TranscriptIdentityError(
            "Human room members cannot be asserted as agent transcript sources"
        )
    if is_agent and source != "agent":
        raise TranscriptIdentityError(
            "Known agents must use the agent transcript source"
        )

    text = str(line.text or "").strip()
    return {
        "participant_id": str(participant.id),
        "name": participant.display_name,
        "text": text,
        "ts": line.ts,
        "is_final": bool(line.is_final),
        **({"segment_id": line.segment_id} if line.segment_id else {}),
        "source": source,
        "identity_verification": (
            "stable_known_agent" if is_agent else "stable_room_member"
        ),
        # Identity normalization proves only that the asserted speaker maps to
        # a known room member. It does not prove these words came from audio.
        "identity_verified": True,
        "content_verification": {
            "local_mic": "client_caption",
            "agent_stt": "agent_stt",
            "agent": "agent_generated_caption",
            "unknown": "unverified",
        }[source],
    }
