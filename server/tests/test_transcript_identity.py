from types import SimpleNamespace
import uuid

import pytest

from app.models.participant import ParticipantType
from app.services.transcript_identity import (
    TranscriptIdentityError,
    authorize_transcript_line,
)


def _participant(
    participant_id: str,
    *,
    username: str,
    display_name: str,
    kind: ParticipantType,
    keycloak_sub: str,
):
    return SimpleNamespace(
        id=uuid.UUID(participant_id),
        username=username,
        display_name=display_name,
        participant_type=kind,
        keycloak_sub=keycloak_sub,
    )


HUMAN = _participant(
    "11111111-1111-1111-1111-111111111111",
    username="aaron",
    display_name="Aaron Stransky",
    kind=ParticipantType.HUMAN,
    keycloak_sub="kc-aaron",
)
AGENT = _participant(
    "22222222-2222-2222-2222-222222222222",
    username="agent-shafen",
    display_name="Shafen",
    kind=ParticipantType.AGENT,
    keycloak_sub="brigade:shafen",
)


def _line(**overrides):
    values = {
        "participant_id": "aaron_11111111-1111-1111-1111-111111111111",
        "name": "Forged Name",
        "text": "  Valid words.  ",
        "ts": 100,
        "is_final": True,
        "segment_id": "segment-1",
        "source": "local_mic",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_human_livekit_identity_and_name_are_server_normalized():
    result = authorize_transcript_line(_line(), room_participants=[HUMAN, AGENT])
    assert result["participant_id"] == str(HUMAN.id)
    assert result["name"] == "Aaron Stransky"
    assert result["text"] == "Valid words."
    assert result["identity_verification"] == "stable_room_member"
    assert result["identity_verified"] is True
    assert result["content_verification"] == "client_caption"


def test_unknown_or_forged_speaker_is_rejected():
    with pytest.raises(TranscriptIdentityError):
        authorize_transcript_line(
            _line(participant_id="attacker"),
            room_participants=[HUMAN, AGENT],
        )


def test_human_cannot_claim_agent_source():
    with pytest.raises(TranscriptIdentityError):
        authorize_transcript_line(
            _line(source="agent"),
            room_participants=[HUMAN, AGENT],
        )


def test_known_agent_alias_is_normalized():
    result = authorize_transcript_line(
        _line(participant_id="agent-shafen", source="agent"),
        room_participants=[HUMAN, AGENT],
    )
    assert result["participant_id"] == str(AGENT.id)
    assert result["name"] == "Shafen"
    assert result["identity_verification"] == "stable_known_agent"
    assert result["content_verification"] == "agent_generated_caption"


def test_agent_cannot_claim_human_source():
    with pytest.raises(TranscriptIdentityError):
        authorize_transcript_line(
            _line(participant_id="agent-shafen", source="local_mic"),
            room_participants=[HUMAN, AGENT],
        )
