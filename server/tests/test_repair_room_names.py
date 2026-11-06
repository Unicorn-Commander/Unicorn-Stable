from __future__ import annotations

from types import SimpleNamespace

from scripts.repair_room_names import (
    apply_changes,
    plan_repairs,
    restore_changes,
    restore_payload,
    title_from_message,
)


def _room(
    room_id: str,
    name: str,
    display_name: str,
    *,
    metadata: dict | None = None,
    parent_room_id: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=room_id,
        name=name,
        display_name=display_name,
        metadata_=metadata or {},
        parent_room_id=parent_room_id,
    )


def test_title_strips_fictional_markdown_mentions_and_cuts_on_a_word() -> None:
    content = (
        "# **Prepare** @rook, the [fictional launch](https://example.com) "
        "with careful checks and follow-up notes for tomorrow"
    )

    title = title_from_message(content)

    assert title == "Prepare the fictional launch with careful checks and…"
    assert len(title) <= 60
    assert "@" not in title
    assert "**" not in title


def test_fictional_fixture_repairs_threads_and_one_agent_seat() -> None:
    unnamed_with_message = _room(
        "thread-1",
        "hub-fictional-t-one",
        "New thread",
        parent_room_id="hub-fictional",
    )
    unnamed_empty = _room(
        "thread-2",
        "hub-fictional-t-empty",
        "",
        parent_room_id="hub-fictional",
    )
    human_named = _room(
        "thread-3",
        "hub-fictional-t-named",
        "Keep this human title",
        parent_room_id="hub-fictional",
    )
    top_level_channel = _room("channel-1", "fictional-channel", "New thread")
    top_level_dm_with_marker = _room("dm-1", "legacy-t-not-a-thread", "New thread")
    hub = _room(
        "hub-1",
        "hub-fictional",
        "Old Rook",
        metadata={"agent_hub": {"agent_id": "rook"}},
    )
    rooms = [
        unnamed_with_message,
        unnamed_empty,
        human_named,
        top_level_channel,
        top_level_dm_with_marker,
        hub,
    ]
    first_messages = {
        "thread-1": SimpleNamespace(
            content="**Prepare** @rook the fictional launch with careful checks"
        )
    }
    participant = SimpleNamespace(
        id="participant-rook",
        username="agent-rook",
        keycloak_sub="brigade:rook",
        display_name="Rook",
    )
    config = SimpleNamespace()

    changes = plan_repairs(
        rooms,
        first_messages,
        [(config, participant)],
        [participant],
        [hub],
    )

    assert [
        (change.kind, change.slug, change.before, change.after) for change in changes
    ] == [
        (
            "thread",
            "hub-fictional-t-one",
            "New thread",
            "Prepare the fictional launch with careful checks",
        ),
        ("agent-hub", "hub-fictional", "Old Rook", "Rook"),
    ]
    assert unnamed_empty.display_name == ""
    assert human_named.display_name == "Keep this human title"
    assert top_level_channel.display_name == "New thread"
    assert top_level_dm_with_marker.display_name == "New thread"

    apply_changes(changes, {str(room.id): room for room in rooms})
    assert (
        unnamed_with_message.display_name
        == "Prepare the fictional launch with careful checks"
    )
    assert hub.display_name == "Rook"

    second_plan = plan_repairs(
        rooms,
        first_messages,
        [(config, participant)],
        [participant],
        [hub],
    )
    assert second_plan == []


def test_restore_fixture_returns_previous_names_and_is_idempotent() -> None:
    thread = _room(
        "thread-1",
        "hub-fictional-t-one",
        "New thread",
        parent_room_id="hub-fictional",
    )
    hub = _room(
        "hub-1",
        "hub-fictional",
        "Old Rook",
        metadata={"agent_hub": {"agent_id": "rook"}},
    )
    repaired = _room(
        "thread-1",
        "hub-fictional-t-one",
        "Prepare the fictional launch",
        parent_room_id="hub-fictional",
    )
    repaired_hub = _room(
        "hub-1",
        "hub-fictional",
        "Rook",
        metadata={"agent_hub": {"agent_id": "rook"}},
    )
    changes = plan_repairs(
        [thread, hub],
        {"thread-1": SimpleNamespace(content="Prepare the fictional launch")},
        [
            (
                SimpleNamespace(),
                SimpleNamespace(keycloak_sub="brigade:rook", display_name="Rook"),
            )
        ],
        [SimpleNamespace(keycloak_sub="brigade:rook", display_name="Rook")],
        [hub],
    )
    payload = restore_payload(changes)

    restore_plan = restore_changes([repaired, repaired_hub], payload["changes"])
    apply_changes(restore_plan, {"thread-1": repaired, "hub-1": repaired_hub})

    assert repaired.display_name == "New thread"
    assert repaired_hub.display_name == "Old Rook"
    assert restore_changes([repaired, repaired_hub], payload["changes"]) == []
