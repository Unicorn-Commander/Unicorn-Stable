"""Resident-agent SET semantics, and the scalar it must never break.

``metadata.brigade_agent_id`` is read by the text responder, the human-DM
guard, the sidebar row and the call UI's persona fallback. Multi-agent rooms
added ``metadata.brigade_agent_ids``; these tests pin that the scalar keeps
meaning exactly what it meant (most-recently-invited canonical responder) and
that a room written before the set existed still resolves.
"""

from __future__ import annotations

from app.services.resident_agents import (
    MAX_RESIDENT_AGENTS,
    add_resident_agent,
    remove_resident_agent,
    resident_agent_ids,
)


def test_scalar_only_metadata_still_resolves() -> None:
    """Every room in the database today looks like this."""
    assert resident_agent_ids({"brigade_agent_id": "majik"}) == ["majik"]


def test_empty_and_missing_are_empty() -> None:
    assert resident_agent_ids(None) == []
    assert resident_agent_ids({}) == []
    assert resident_agent_ids({"brigade_agent_id": ""}) == []
    assert resident_agent_ids({"brigade_agent_ids": "majik"}) == []


def test_add_writes_both_forms_and_keeps_last_invited_canonical() -> None:
    meta = add_resident_agent({"brigade_agent_id": "majik"}, "the-general")
    assert meta["brigade_agent_ids"] == ["majik", "the-general"]
    # The documented rule the text responder depends on.
    assert meta["brigade_agent_id"] == "the-general"


def test_re_inviting_moves_to_the_end_without_duplicating() -> None:
    meta = add_resident_agent({"brigade_agent_ids": ["majik", "gunny"]}, "majik")
    assert meta["brigade_agent_ids"] == ["gunny", "majik"]
    assert meta["brigade_agent_id"] == "majik"


def test_add_preserves_unrelated_metadata() -> None:
    meta = add_resident_agent(
        {"bridge_purpose": "build e03 in public", "pinned_message_ids": []},
        "majik",
    )
    assert meta["bridge_purpose"] == "build e03 in public"
    assert meta["pinned_message_ids"] == []


def test_add_returns_a_new_dict() -> None:
    """SQLAlchemy JSONB change detection needs a reassignment, not a mutation."""
    original = {"brigade_agent_id": "majik"}
    meta = add_resident_agent(original, "gunny")
    assert original == {"brigade_agent_id": "majik"}
    assert meta is not original


def test_remove_repoints_the_scalar_at_whoever_is_left() -> None:
    meta = {"brigade_agent_ids": ["majik", "the-general"], "brigade_agent_id": "the-general"}
    after = remove_resident_agent(meta, "the-general")
    assert after["brigade_agent_ids"] == ["majik"]
    # A kicked agent must not keep answering as the room's responder.
    assert after["brigade_agent_id"] == "majik"


def test_removing_the_last_agent_clears_both_forms() -> None:
    after = remove_resident_agent({"brigade_agent_id": "majik"}, "majik")
    assert "brigade_agent_id" not in after
    assert "brigade_agent_ids" not in after


def test_removing_an_absent_agent_is_a_no_op_for_the_others() -> None:
    after = remove_resident_agent({"brigade_agent_ids": ["majik"]}, "gunny")
    assert after["brigade_agent_ids"] == ["majik"]
    assert after["brigade_agent_id"] == "majik"


def test_the_set_is_capped() -> None:
    meta: dict = {}
    for i in range(MAX_RESIDENT_AGENTS + 4):
        meta = add_resident_agent(meta, f"agent-{i}")
    assert len(meta["brigade_agent_ids"]) == MAX_RESIDENT_AGENTS
    assert meta["brigade_agent_id"] == f"agent-{MAX_RESIDENT_AGENTS + 3}"


def test_a_scalar_the_list_missed_is_not_lost() -> None:
    """Half-written metadata must not drop the room's only agent."""
    ids = resident_agent_ids(
        {"brigade_agent_ids": ["gunny"], "brigade_agent_id": "majik"}
    )
    assert ids == ["gunny", "majik"]
