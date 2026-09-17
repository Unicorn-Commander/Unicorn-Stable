"""Tests for the Project-Ops → Stable webhook receiver pure logic.

Covers the security-critical pieces (signature verification, replay window,
assignee extraction) and the message/link shaping, plus the room-mapping
config parser. These import no LiveKit/DB services, so they run in isolation.
"""

from __future__ import annotations

import json

import pytest

from app.config import Settings
from app.services.projectops_webhook import (
    build_message,
    build_task_link,
    extract_assignee_id,
    extract_project_id,
    is_timestamp_fresh,
    parse_envelope,
    verify_signature,
)

SECRET = "REMOVED"


def sign(secret: str, body: dict) -> tuple[bytes, str]:
    raw = json.dumps(body).encode("utf-8")
    import hashlib
    import hmac

    digest = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return raw, f"sha256={digest}"


# ── signature ────────────────────────────────────────────────────────────────


def test_verify_signature_accepts_valid():
    raw, sig = sign(SECRET, {"event": "task.assigned"})
    assert verify_signature(SECRET, raw, sig) is True


def test_verify_signature_rejects_tampered_body():
    raw, sig = sign(SECRET, {"event": "task.assigned"})
    tampered = raw.replace(b"task.assigned", b"task.comment.created")
    assert verify_signature(SECRET, tampered, sig) is False


def test_verify_signature_rejects_wrong_secret():
    raw, _ = sign(SECRET, {"event": "task.assigned"})
    _, other = sign("whsec_OTHER", {"event": "task.assigned"})
    assert verify_signature(SECRET, raw, other) is False


def test_verify_signature_rejects_missing_header():
    raw, _ = sign(SECRET, {"event": "task.assigned"})
    assert verify_signature(SECRET, raw, None) is False


def test_verify_signature_rejects_when_unconfigured():
    raw, sig = sign(SECRET, {"event": "task.assigned"})
    assert verify_signature("", raw, sig) is False


# ── envelope parsing ─────────────────────────────────────────────────────────


def test_parse_envelope_accepts_object():
    assert parse_envelope(b'{"event": "task.assigned"}') == {"event": "task.assigned"}


def test_parse_envelope_rejects_non_object():
    assert parse_envelope(b"[1,2,3]") is None
    assert parse_envelope(b'"nope"') is None


def test_parse_envelope_rejects_garbage():
    assert parse_envelope(b"not json") is None


# ── timestamp window ─────────────────────────────────────────────────────────


def test_timestamp_fresh_accepts_now():
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    assert is_timestamp_fresh(now, max_age_seconds=300) is True


def test_timestamp_fresh_rejects_old():
    from datetime import datetime, timedelta, timezone

    old = (datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat()
    assert is_timestamp_fresh(old, max_age_seconds=300) is False


def test_timestamp_fresh_rejects_far_future():
    from datetime import datetime, timedelta, timezone

    future = (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()
    assert is_timestamp_fresh(future, max_age_seconds=300) is False


def test_timestamp_fresh_rejects_missing_and_garbage():
    assert is_timestamp_fresh(None, 300) is False
    assert is_timestamp_fresh("not-a-date", 300) is False
    assert is_timestamp_fresh(12345, 300) is False


def test_timestamp_fresh_accepts_naive_and_z_suffix():
    from datetime import datetime, timezone

    # "Z" suffix is normalized before parsing.
    now_z = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    assert is_timestamp_fresh(now_z, max_age_seconds=300) is True
    assert is_timestamp_fresh(datetime.now().isoformat(), max_age_seconds=300) is False


def test_non_ascii_signature_is_rejected():
    assert not verify_signature(SECRET, b"{}", "sha256=é")


# ── assignee extraction ──────────────────────────────────────────────────────


def test_extract_assignee_id_prefers_top_level():
    data = {"assignedToId": "u-top", "task": {"assignedToId": "u-nested"}}
    assert extract_assignee_id(data) == "u-top"


def test_extract_assignee_id_falls_back_to_task():
    assert extract_assignee_id({"task": {"assignedToId": "u-nested"}}) == "u-nested"


def test_extract_assignee_id_none_when_absent():
    assert extract_assignee_id({"task": {}}) is None
    assert extract_assignee_id({}) is None
    assert extract_assignee_id(None) is None


def test_extract_project_id_prefers_top_level():
    data = {"projectId": "p-top", "task": {"projectId": "p-nested"}}
    assert extract_project_id(data) == "p-top"


def test_extract_project_id_falls_back_to_task():
    assert extract_project_id({"task": {"projectId": "p-nested"}}) == "p-nested"


def test_extract_project_id_none_when_absent():
    assert extract_project_id({"task": {}}) is None


# ── task link ────────────────────────────────────────────────────────────────


def test_build_task_link_prefers_project():
    link = build_task_link("https://projectops.example", "ws1", "t1", "p1")
    assert link == "https://projectops.example/dashboard/projects/p1"


def test_build_task_link_falls_back_to_task_query():
    link = build_task_link("https://projectops.example", "ws1", "t1", None)
    assert link == "https://projectops.example/dashboard/projects?task=t1"


def test_build_task_link_none_without_base():
    assert build_task_link("", "ws1", "t1", "p1") is None


# ── message shaping ──────────────────────────────────────────────────────────


def test_build_message_assigned():
    msg = build_message("task.assigned", {"taskId": "t1", "title": "Ship it"})
    assert "Task assigned" in msg
    assert "Ship it" in msg


def test_build_message_comment_includes_snippet():
    msg = build_message(
        "task.comment.created",
        {"taskId": "t1", "title": "Ship it", "content": "holding for client"},
    )
    assert "New comment" in msg
    assert "holding for client" in msg


def test_build_message_status():
    msg = build_message(
        "task.status_changed",
        {
            "taskId": "t1",
            "title": "Ship it",
            "fromStatus": "PENDING",
            "toStatus": "DONE",
        },
    )
    assert "Status changed" in msg
    assert "PENDING" in msg and "DONE" in msg


def test_build_message_unknown_event_is_none():
    assert build_message("task.created", {"taskId": "t1"}) is None


# ── config parsing ───────────────────────────────────────────────────────────


def test_settings_mapping_from_json_string():
    s = Settings(projectops_room_mapping='{"u1": "astra", "u2": "show-deck"}')
    assert s.projectops_room_mapping == {"u1": "astra", "u2": "show-deck"}


def test_settings_mapping_from_dict():
    s = Settings(projectops_room_mapping={"u1": "astra"})
    assert s.projectops_room_mapping == {"u1": "astra"}


def test_settings_mapping_empty_by_default():
    assert Settings().projectops_room_mapping == {}
    assert Settings().projectops_webhook_secret == ""
    assert Settings().projectops_webhook_max_age_seconds == 300


def test_settings_mapping_rejects_malformed():
    with pytest.raises(ValueError):
        Settings(projectops_room_mapping="not-json")


def test_settings_mapping_rejects_non_object_json():
    with pytest.raises(ValueError):
        Settings(projectops_room_mapping='["a", "b"]')
