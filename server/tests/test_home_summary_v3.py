"""Dashboard v3 shape, mention-count source, and federation nulls.

Pure functions only — no database and no live Project-Ops / Meeting-Ops call.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

from app.api.home import (
    ACTION_FOR,
    ActorRef,
    CrewCard,
    HomeCounts,
    HomeSummary,
    HomeSummaryV3,
    LiveCallV3,
    NeedsYouRow,
    RoomRef,
    TodayMeeting,
    assemble_meetings,
    build_today,
    classify_attention,
    finalize_needs_you,
    floor_holder,
    mention_rooms_statement,
    normalize_section_prefs,
    pick_actor,
    recaps_from_payload,
    router,
    select_due_tasks,
    standing_meetings,
)

NOW = datetime(2026, 9, 22, 15, 0, tzinfo=timezone.utc)
TODAY = date(2026, 9, 22)


def _room(room_id: str = "room-1") -> dict:
    return {
        "id": room_id,
        "display_name": "War Room",
        "room_type": "channel",
        "parent_room_id": None,
    }


def _actor(name: str = "Majik") -> dict:
    return {
        "participant_id": "p-1",
        "kind": "agent",
        "display_name": name,
        "avatar_url": None,
        "agent_id": "majik",
    }


def test_mention_count_reads_the_member_flag_not_message_text() -> None:
    sql = str(mention_rooms_statement(uuid.uuid4())).lower()
    assert "has_unread_mention" in sql
    assert "ilike" not in sql
    assert "content" not in sql


def test_v3_summary_shape_and_actions() -> None:
    row = NeedsYouRow(
        kind="approval",
        actor=ActorRef(**_actor()),
        room=RoomRef(**_room()),
        preview="Deploy the patch?",
        created_at=NOW,
        action="approve",
        stale=False,
        message_id="m-1",
    )
    summary = HomeSummaryV3(
        generated_at=NOW,
        live_calls=[
            LiveCallV3(
                room_id="room-1",
                display_name="War Room",
                room_type="channel",
                participant_count=2,
                has_agent=True,
                recording=True,
                broadcast=False,
                floor_holder=ActorRef(**_actor("Aaron")),
            )
        ],
        agent_activity=[],
        recent_artifacts=[],
        recent_transcripts=[],
        counts=HomeCounts(
            unread_rooms=1,
            mention_rooms=1,
            approvals_pending=1,
            agents_available=0,
            people_online=1,
            worker_last_seen_at=None,
        ),
        needs_you=[row],
        crew=[
            CrewCard(
                agent_id="majik",
                participant_id="p-1",
                display_name="Majik",
                avatar_url=None,
                status="online",
                agent_mode="answers_all",
                current_task="draft the note",
                last_line="On it.",
                since=NOW,
                hub_room_id="hub-1",
            )
        ],
        today=build_today(None, None),
    )
    dumped = summary.model_dump(mode="json")
    assert set(dumped) >= {"needs_you", "crew", "today", "counts", "live_calls"}
    assert dumped["needs_you"][0]["kind"] == "approval"
    assert dumped["needs_you"][0]["action"] == "approve"
    assert dumped["needs_you"][0]["actor"]["agent_id"] == "majik"
    assert dumped["needs_you"][0]["room"]["parent_room_id"] is None
    assert dumped["needs_you"][0]["stale"] is False
    assert dumped["live_calls"][0]["recording"] is True
    assert dumped["crew"][0]["current_task"] == "draft the note"
    assert dumped["today"] is None
    v1 = HomeSummary(
        generated_at=NOW,
        live_calls=[],
        agent_activity=[],
        recent_artifacts=[],
        recent_transcripts=[],
        counts=summary.counts,
    )
    assert "needs_you" not in v1.model_dump()


def test_routes_expose_summary_and_section_prefs() -> None:
    paths = {getattr(route, "path", "") for route in router.routes}
    assert "/home/summary" in paths
    assert "/home/section-prefs" in paths


def test_classify_priority_and_invite() -> None:
    common = dict(created_by="other", caller_id="me", last_read_is_none=True, role="member")
    assert (
        classify_attention(
            room_type="channel", unread=True, mention=True, brigade_agent_id=None, **common
        )
        == "mention"
    )
    assert (
        classify_attention(
            room_type="dm", unread=True, mention=False, brigade_agent_id=None, **common
        )
        == "dm"
    )
    assert (
        classify_attention(
            room_type="dm", unread=True, mention=False, brigade_agent_id="majik", **common
        )
        == "agent_waiting"
    )
    assert (
        classify_attention(
            room_type="agent_hub", unread=True, mention=False, brigade_agent_id=None, **common
        )
        == "agent_waiting"
    )
    assert (
        classify_attention(
            room_type="channel", unread=False, mention=False, brigade_agent_id=None, **common
        )
        == "invite"
    )
    assert (
        classify_attention(
            room_type="channel",
            unread=False,
            mention=False,
            brigade_agent_id=None,
            created_by="other",
            caller_id="me",
            last_read_is_none=True,
            role="owner",
        )
        is None
    )


def test_finalize_sorts_by_urgency_then_time_and_marks_stale() -> None:
    fresh = NOW - timedelta(hours=1)
    old = NOW - timedelta(days=20)
    items = [
        {
            "kind": "dm",
            "actor": _actor("Sam"),
            "room": _room("dm"),
            "preview": "hey",
            "created_at": fresh,
            "message_id": None,
        },
        {
            "kind": "approval",
            "actor": _actor(),
            "room": _room("ap"),
            "preview": "ship it?",
            "created_at": old,
            "message_id": "m",
        },
        {
            "kind": "mention",
            "actor": _actor("Ada"),
            "room": _room("men"),
            "preview": "@you",
            "created_at": fresh,
            "message_id": None,
        },
    ]
    rows = finalize_needs_you(items, NOW)
    assert [row.kind for row in rows] == ["approval", "mention", "dm"]
    assert [row.action for row in rows] == [ACTION_FOR[row.kind] for row in rows]
    assert rows[0].stale is True
    assert rows[1].stale is False


def test_pick_actor_uses_the_agent_for_a_waiting_row() -> None:
    members = [
        {
            "participant_id": "me",
            "participant_type": "human",
            "display_name": "Aaron",
            "avatar_url": None,
            "agent_id": None,
        },
        {
            "participant_id": "ag",
            "participant_type": "agent",
            "display_name": "Majik",
            "avatar_url": "/puppets/majik.png",
            "agent_id": "majik",
        },
    ]
    actor = pick_actor(members, caller_id="me", kind="agent_waiting", sender=None, creator_id=None)
    assert actor["kind"] == "agent"
    assert actor["agent_id"] == "majik"
    assert actor["display_name"] == "Majik"


def test_floor_holder_is_null_when_nobody_is_speaking() -> None:
    quiet = SimpleNamespace(is_speaking=False, identity="aaron", name="Aaron")
    assert floor_holder([quiet]) is None
    speaking = SimpleNamespace(is_speaking=True, identity="agent-majik", name="Majik")
    holder = floor_holder([quiet, speaking])
    assert holder is not None
    assert holder.kind == "agent"
    assert holder.agent_id == "majik"
    assert holder.display_name == "Majik"


def test_due_window_keeps_overdue_and_tomorrow_only() -> None:
    tasks = [
        {"id": "over", "title": "Overdue", "dueDate": "2026-09-20", "status": "PENDING"},
        {"id": "today", "title": "Today", "dueDate": "2026-09-22", "status": "IN_PROGRESS"},
        {"id": "tomorrow", "title": "Tomorrow", "dueDate": "2026-09-23T18:00:00Z", "status": "PENDING"},
        {"id": "later", "title": "Later", "dueDate": "2026-09-24", "status": "PENDING"},
        {"id": "done", "title": "Done", "dueDate": "2026-09-22", "status": "COMPLETED"},
        {"id": "none", "title": "No due", "status": "PENDING"},
    ]
    rows = select_due_tasks(
        tasks,
        today=TODAY,
        trusted_caller=True,
        caller_email="aaron@magicunicorn.tech",
        dashboard_url="https://projectops.magicunicorn.dev",
    )
    assert rows is not None
    assert [row.id for row in rows] == ["over", "today", "tomorrow"]


def test_service_jwt_tasks_without_an_assignee_are_null_not_empty() -> None:
    tasks = [{"id": "svc", "title": "Service queue", "dueDate": "2026-09-22", "status": "PENDING"}]
    assert (
        select_due_tasks(
            tasks,
            today=TODAY,
            trusted_caller=False,
            caller_email="aaron@magicunicorn.tech",
            dashboard_url="https://projectops.magicunicorn.dev",
        )
        is None
    )


def test_service_jwt_keeps_only_the_caller_email() -> None:
    tasks = [
        {
            "id": "mine",
            "title": "Mine",
            "dueDate": "2026-09-22",
            "status": "PENDING",
            "assignedTo": {"email": "Aaron@magicunicorn.tech"},
            "projectId": "p1",
        },
        {
            "id": "theirs",
            "title": "Theirs",
            "dueDate": "2026-09-22",
            "status": "PENDING",
            "assignedTo": {"email": "other@magicunicorn.tech"},
        },
    ]
    rows = select_due_tasks(
        tasks,
        today=TODAY,
        trusted_caller=False,
        caller_email="aaron@magicunicorn.tech",
        dashboard_url="https://projectops.magicunicorn.dev",
    )
    assert rows is not None
    assert [row.id for row in rows] == ["mine"]
    assert rows[0].url == "https://projectops.magicunicorn.dev/dashboard/projects/p1"


def test_recaps_are_the_last_day_and_meetings_null_when_unreachable() -> None:
    payload = {
        "sessions": [
            {"id": "new", "title": "Standup", "ended_at": "2026-09-22T14:00:00Z", "summary": "Shipped the inbox."},
            {"id": "old", "title": "Last week", "ended_at": "2026-09-10T14:00:00Z", "summary": "Ancient."},
        ]
    }
    recaps = recaps_from_payload(payload, NOW)
    assert [row.id for row in recaps] == ["new"]
    assert recaps[0].kind == "recap"
    assert recaps[0].summary == "Shipped the inbox."
    standing = standing_meetings(
        [("main-conference", "Main Conference Hall", "drop in")],
        {},
    )
    assert assemble_meetings(standing, None) is None
    merged = assemble_meetings(standing, recaps)
    assert merged is not None
    assert [row.kind for row in merged] == ["standing", "recap"]
    assert build_today(None, None) is None
    block = build_today([], None)
    assert block is not None
    assert block.po_tasks == []
    assert block.meetings is None


def test_section_prefs_fill_missing_ids_and_drop_unknown() -> None:
    prefs = normalize_section_prefs(
        {"order": ["today", "nope", "today", "crew"], "collapsed": {"crew": True, "nope": True, "live_now": "yes"}}
    )
    assert prefs["order"] == ["today", "crew", "needs_you", "live_now", "recent"]
    assert prefs["collapsed"]["crew"] is True
    assert prefs["collapsed"]["live_now"] is False
    assert "nope" not in prefs["collapsed"]


def _m(pid: str, ptype: str, name: str, agent_id: str | None = None) -> dict:
    return {
        "participant_id": pid,
        "participant_type": ptype,
        "display_name": name,
        "avatar_url": f"/puppets/{pid}.png",
        "agent_id": agent_id,
    }


def test_pick_actor_dm_row_wears_the_senders_face_not_the_first_member() -> None:
    # Fleet Watch (2026-09-28): a group DM whose member rows sort Persephone
    # first; the unread line is The Colonel's. The row must show The Colonel.
    members = [
        _m("per", "agent", "Persephone", "persephone"),
        _m("col", "agent", "The Colonel", "colonel"),
        _m("me", "human", "Aaron"),
    ]
    actor = pick_actor(
        members, caller_id="me", kind="dm", sender=_m("col", "agent", "The Colonel", "colonel"), creator_id=None
    )
    assert actor["agent_id"] == "colonel"
    assert actor["display_name"] == "The Colonel"
    assert actor["avatar_url"] == "/puppets/col.png"


def test_pick_actor_waiting_row_prefers_the_agent_that_actually_spoke() -> None:
    members = [
        _m("per", "agent", "Persephone", "persephone"),
        _m("col", "agent", "The Colonel", "colonel"),
        _m("me", "human", "Aaron"),
    ]
    actor = pick_actor(
        members, caller_id="me", kind="agent_waiting", sender=_m("col", "agent", "The Colonel", "colonel"), creator_id=None
    )
    assert actor["agent_id"] == "colonel"


def test_pick_actor_never_returns_the_caller_as_sender() -> None:
    members = [_m("me", "human", "Aaron"), _m("ada", "human", "Ada")]
    actor = pick_actor(members, caller_id="me", kind="dm", sender=_m("me", "human", "Aaron"), creator_id=None)
    assert actor["participant_id"] == "ada"


def test_pick_actor_invite_row_keeps_the_inviter() -> None:
    members = [_m("me", "human", "Aaron"), _m("ada", "human", "Ada"), _m("bob", "human", "Bob")]
    actor = pick_actor(members, caller_id="me", kind="invite", sender=_m("bob", "human", "Bob"), creator_id="ada")
    assert actor["participant_id"] == "ada"
