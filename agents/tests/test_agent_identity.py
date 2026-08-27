"""Per-agent LiveKit identity — the fix for "a second agent evicts the first".

Every Brigade agent used to join as the one identity ``agent-brigade``
(identity was derived from ``agent_type``, which is ``"brigade"`` for all ~56
personas), and LiveKit's duplicate-identity handling tore the first job down
when the second arrived. These tests pin the two properties that make
multi-agent rooms work: DISTINCT identities per persona, and an unchanged
type-shaped fallback for jobs that name no persona.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_runtime.registry import (  # noqa: E402
    AgentRegistry,
    agent_participant_identity,
    agent_participant_name,
)


class _Job:
    def __init__(self, metadata: str) -> None:
        self.metadata = metadata


class _Room:
    def __init__(self, metadata: str) -> None:
        self.metadata = metadata
        self.name = "stable-test-room"


class _Req:
    def __init__(self, job_meta: str = "", room_meta: str = "") -> None:
        self.job = _Job(job_meta)
        self.room = _Room(room_meta)


def test_persona_identities_are_distinct() -> None:
    assert agent_participant_identity("brigade", "majik") == "agent-majik"
    assert (
        agent_participant_identity("brigade", "the-general") == "agent-the-general"
    )
    assert agent_participant_identity("brigade", "majik") != agent_participant_identity(
        "brigade", "the-general"
    )


def test_type_shaped_fallback_is_unchanged() -> None:
    """A job with no Brigade persona keeps the historical identity + name."""
    assert agent_participant_identity("triage", None) == "agent-triage"
    assert agent_participant_identity("brigade", "") == "agent-brigade"
    assert agent_participant_name("triage", None) == "stable-triage"


def test_display_name_matches_the_server_derivation() -> None:
    # agent_chat_responder / transcript_publisher._agent_display_name
    assert agent_participant_name("brigade", "majik") == "Majik"
    assert agent_participant_name("brigade", "the-general") == "The General"
    assert agent_participant_name("brigade", "corporal-qwen") == "Corporal Qwen"


def test_job_metadata_outranks_room_metadata() -> None:
    """The room copy names whoever was invited LAST.

    ``dispatch_agent`` bakes each dispatch's metadata onto the shared room, so
    in a multi-agent room the room copy is the other agent by the time the
    second job is accepted. Trusting it would hand both workers the same
    identity again.
    """
    reg = AgentRegistry.__new__(AgentRegistry)
    req = _Req(
        job_meta=json.dumps({"agent_type": "brigade", "brigade_agent_id": "majik"}),
        room_meta=json.dumps(
            {"agent_type": "brigade", "brigade_agent_id": "the-general"}
        ),
    )
    assert reg._resolve_brigade_agent_id(req) == "majik"


def test_room_metadata_is_the_fallback() -> None:
    reg = AgentRegistry.__new__(AgentRegistry)
    req = _Req(
        job_meta="",
        room_meta=json.dumps({"brigade_agent_id": "gunny"}),
    )
    assert reg._resolve_brigade_agent_id(req) == "gunny"


def test_malformed_metadata_never_raises() -> None:
    reg = AgentRegistry.__new__(AgentRegistry)
    for job_meta in ("", "not json", "[]", "null", json.dumps({"brigade_agent_id": 7})):
        assert reg._resolve_brigade_agent_id(_Req(job_meta=job_meta)) is None
