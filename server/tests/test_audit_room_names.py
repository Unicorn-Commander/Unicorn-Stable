from __future__ import annotations

from types import SimpleNamespace

from scripts.audit_room_names import (
    AgentSeatSnapshot,
    RoomSnapshot,
    _agent_snapshots,
    agent_findings,
    load_puppet_names,
    room_findings,
)


def test_room_fixture_reports_each_requested_naming_drift() -> None:
    empty = room_findings(
        RoomSnapshot("room-empty", "readiness", "", {}, False)
    )
    slug = room_findings(
        RoomSnapshot("room-slug", "readiness", "Readiness", {}, False)
    )
    thread = room_findings(
        RoomSnapshot("room-thread", "readiness-t-brief", "New thread", {}, True)
    )
    bridge = room_findings(
        RoomSnapshot(
            "room-bridge",
            "bureau-of-readiness",
            "New thread",
            {"bridge_pair": "fictional-human:fictional-agent"},
            False,
        )
    )

    assert empty[0].issues == ("empty_display_name",)
    assert slug[0].issues == ("display_name_equals_slug",)
    assert thread[0].issues == ("new_thread_with_messages",)
    assert bridge[0].issues == ("bridge_metadata_without_human_title",)
    assert room_findings(
        RoomSnapshot(
            "room-good",
            "bureau-of-readiness",
            "Bureau of Readiness",
            {"bridge_purpose": "readiness"},
            True,
        )
    ) == []


def test_agent_fixture_reports_config_hub_and_puppet_drift() -> None:
    finding = agent_findings(
        AgentSeatSnapshot(
            agent_id="fictional-seat",
            config_name="Rook",
            hub_names=("Rook Desk",),
            puppet_name="Rook",
            seat_id="participant-fictional-seat",
        )
    )
    assert finding[0].identifier == "participant-fictional-seat"
    assert finding[0].issues == ("agent_name_drift",)
    assert agent_findings(
        AgentSeatSnapshot(
            agent_id="fictional-seat",
            config_name="Rook",
            hub_names=("Rook", "Rook"),
            puppet_name="Rook",
        )
    ) == []


def test_manifest_reader_accepts_key_and_stable_username(tmp_path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        '{"fictional-seat": {"display_name": "Rook", "stable_username": "agent-rook"}}',
        encoding="utf-8",
    )

    names = load_puppet_names(manifest)

    assert names == {"fictional-seat": "Rook", "agent-rook": "Rook"}


def test_agent_fixture_can_be_built_from_orm_like_rows() -> None:
    # Keep a small fixture documenting the three database shapes the script
    # joins: an agent config participant, a hub carrying agent_hub metadata,
    # and a runner participant without a legacy AgentConfig row.
    config_participant = SimpleNamespace(
        id="p-config",
        username="agent-fictional-seat",
        keycloak_sub="brigade:fictional-seat",
        display_name="Rook",
        metadata_={"backend": "runner"},
    )
    hub = SimpleNamespace(
        metadata_={"agent_hub": {"agent_id": "fictional-seat"}},
        display_name="Rook",
    )
    runner = SimpleNamespace(
        id="p-runner",
        username="agent-runner",
        keycloak_sub="brigade:runner",
        display_name="Runner",
        metadata_={"backend": "runner"},
    )
    runner_hub = SimpleNamespace(
        metadata_={"brigade_agent_id": "runner"},
        display_name="Runner",
    )

    snapshots = _agent_snapshots(
        [(SimpleNamespace(), config_participant)],
        [config_participant, runner],
        [hub, runner_hub],
        {"agent-fictional-seat": "Rook", "runner": "Runner"},
    )

    assert snapshots == [
        AgentSeatSnapshot(
            agent_id="fictional-seat",
            config_name="Rook",
            hub_names=("Rook",),
            puppet_name="Rook",
            seat_id="p-config",
        ),
        AgentSeatSnapshot(
            agent_id="runner",
            config_name="Runner",
            hub_names=("Runner",),
            puppet_name="Runner",
            seat_id="p-runner",
        ),
    ]
