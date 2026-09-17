"""Route-level tests for POST /api/v1/webhooks/project-ops.

Exercises the flag-off and security/authorization paths end to end (via
FastAPI TestClient with dependency overrides). Stateful outcomes at the message
service boundary cover retry/commit and concurrency error handling. These are
route tests with DB/LiveKit doubles, not a live PostgreSQL concurrency test.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from fastapi.testclient import TestClient

from app.config import Settings
from app.deps import get_db, get_livekit, get_redis, get_settings_dep
from app.main import app

SECRET = "REMOVED"


@pytest.fixture(autouse=True)
def clear_overrides():
    yield
    app.dependency_overrides.clear()


class FakeRedis:
    """Minimal redis double for the dedupe + rate-limit calls the route makes."""

    def __init__(self, *, dedupe_seen: bool = False) -> None:
        self.dedupe_seen = dedupe_seen
        self._counters: dict[str, int] = {}

    async def set(self, key, value, ex=None, nx=False):
        if key.startswith("projectops:delivery:") and nx:
            return not self.dedupe_seen
        return True

    async def incr(self, key):
        self._counters[key] = self._counters.get(key, 0) + 1
        return self._counters[key]

    async def expire(self, key, seconds):
        return True

    async def get(self, key):
        return None


def _sign(secret: str, body: dict) -> tuple[bytes, str]:
    raw = json.dumps(body).encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return raw, f"sha256={digest}"


def _envelope(event: str, data: dict, timestamp: str | None = None) -> dict:
    ts = timestamp if timestamp is not None else datetime.now(timezone.utc).isoformat()
    return {"event": event, "workspaceId": "ws1", "data": data, "timestamp": ts}


def _client(settings: Settings, redis: FakeRedis | None = None) -> TestClient:
    settings.projectops_workspace_id = "ws1"
    client = TestClient(app)
    # The gate paths below never reach the DB/LiveKit, so a mock that would
    # fail loudly if accidentally touched is the right guard.
    client.app.dependency_overrides[get_settings_dep] = lambda: settings
    client.app.dependency_overrides[get_db] = lambda: AsyncMock()
    client.app.dependency_overrides[get_livekit] = lambda: AsyncMock()
    client.app.dependency_overrides[get_redis] = lambda: redis or FakeRedis()
    return client


def test_flag_off_returns_503():
    client = _client(Settings(projectops_webhook_secret=""))
    resp = client.post(
        "/api/v1/webhooks/project-ops",
        content=b"{}",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Project-Ops webhooks not configured"


def test_bad_signature_returns_401():
    settings = Settings(projectops_webhook_secret=SECRET)
    client = _client(settings)
    raw, _ = _sign(SECRET, _envelope("task.assigned", {"assignedToId": "u1"}))
    resp = client.post(
        "/api/v1/webhooks/project-ops",
        content=raw,
        headers={
            "Content-Type": "application/json",
            "X-ProjectOps-Signature": "sha256=deadbeef",
        },
    )
    assert resp.status_code == 401


def test_valid_signature_passes_gate():
    settings = Settings(
        projectops_webhook_secret=SECRET,
        projectops_room_mapping={"u1": "astra"},
    )
    client = _client(settings)
    raw, sig = _sign(
        SECRET, _envelope("task.assigned", {"assignedToId": "u9-unmapped"})
    )
    resp = client.post(
        "/api/v1/webhooks/project-ops",
        content=raw,
        headers={
            "Content-Type": "application/json",
            "X-ProjectOps-Signature": sig,
            "X-ProjectOps-Delivery": "d1",
        },
    )
    # Valid signature, fresh timestamp → passes the gate; assignee is unmapped
    # so it is acknowledged + dropped (not an error).
    assert resp.status_code == 200
    assert resp.json()["status"] == "ignored"


def test_duplicate_delivery_is_dropped():
    settings = Settings(
        projectops_webhook_secret=SECRET,
        projectops_room_mapping={"u1": "astra"},
    )
    client = _client(settings, redis=FakeRedis(dedupe_seen=True))
    db = AsyncMock()
    db.get.return_value = SimpleNamespace(id="persisted")
    client.app.dependency_overrides[get_db] = lambda: db
    raw, sig = _sign(SECRET, _envelope("task.assigned", {"assignedToId": "u1"}))
    resp = client.post(
        "/api/v1/webhooks/project-ops",
        content=raw,
        headers={
            "Content-Type": "application/json",
            "X-ProjectOps-Signature": sig,
            "X-ProjectOps-Delivery": "d1",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "duplicate"


def test_stale_timestamp_returns_401():
    settings = Settings(projectops_webhook_secret=SECRET)
    client = _client(settings)
    old = (datetime.now(timezone.utc) - timedelta(seconds=3600)).isoformat()
    raw, sig = _sign(
        SECRET, _envelope("task.assigned", {"assignedToId": "u1"}, timestamp=old)
    )
    resp = client.post(
        "/api/v1/webhooks/project-ops",
        content=raw,
        headers={"Content-Type": "application/json", "X-ProjectOps-Signature": sig},
    )
    assert resp.status_code == 401
    assert "Stale" in resp.json()["detail"]


def test_unhandled_event_acknowledged():
    settings = Settings(projectops_webhook_secret=SECRET)
    client = _client(settings)
    raw, sig = _sign(SECRET, _envelope("task.created", {}))
    resp = client.post(
        "/api/v1/webhooks/project-ops",
        content=raw,
        headers={"Content-Type": "application/json", "X-ProjectOps-Signature": sig},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "ignored"


def _posting_client(monkeypatch):
    import app.api.project_ops as route

    settings = Settings(
        projectops_webhook_secret=SECRET,
        projectops_room_mapping={"u1": "astra"},
        rate_limit_enabled=False,
    )
    client = _client(settings)
    db = AsyncMock()
    db.get.return_value = None
    room = SimpleNamespace(id="room-id")
    result = MagicMock()
    result.scalar_one_or_none.return_value = room
    db.execute.return_value = result
    client.app.dependency_overrides[get_db] = lambda: db
    monkeypatch.setattr(
        route,
        "_get_or_create_sender",
        AsyncMock(return_value=SimpleNamespace(id="sender-id")),
    )
    monkeypatch.setattr(route, "_ensure_membership", AsyncMock())
    send = AsyncMock(return_value=SimpleNamespace(id="message-id"))
    monkeypatch.setattr(route.MessageService, "send_message", send)
    return client, db, send


def _post(client, envelope, delivery="d1"):
    raw, sig = _sign(SECRET, envelope)
    return client.post(
        "/api/v1/webhooks/project-ops",
        content=raw,
        headers={"X-ProjectOps-Signature": sig, "X-ProjectOps-Delivery": delivery},
    )


def test_workspace_is_checked_before_room_or_dedupe(monkeypatch):
    client, db, send = _posting_client(monkeypatch)
    env = _envelope("task.assigned", {"assignedToId": "u1", "taskId": "t1"})
    env["workspaceId"] = "foreign-workspace"
    assert _post(client, env).status_code == 403
    db.get.assert_not_awaited()
    db.execute.assert_not_awaited()
    send.assert_not_awaited()


def test_missing_workspace_binding_is_inert(monkeypatch):
    client, db, send = _posting_client(monkeypatch)
    app.dependency_overrides[get_settings_dep] = lambda: Settings(
        projectops_webhook_secret=SECRET
    )
    assert _post(client, _envelope("task.assigned", {})).status_code == 503
    db.get.assert_not_awaited()
    send.assert_not_awaited()


def test_unsigned_delivery_header_cannot_bypass_dedupe(monkeypatch):
    client, db, send = _posting_client(monkeypatch)
    env = _envelope("task.assigned", {"assignedToId": "u1", "taskId": "t1"})
    assert _post(client, env).json()["status"] == "ok"
    first_id = send.call_args.kwargs["message_id"]
    db.get.return_value = SimpleNamespace(id=first_id)
    assert _post(client, env, "changed-header").json()["status"] == "duplicate"
    assert db.get.call_args.args[1] == first_id
    assert send.await_count == 1


def test_failure_before_commit_remains_retryable(monkeypatch):
    from fastapi import HTTPException

    client, db, send = _posting_client(monkeypatch)
    send.side_effect = [
        HTTPException(status_code=503, detail="temporary"),
        SimpleNamespace(id="ok"),
    ]
    env = _envelope("task.assigned", {"assignedToId": "u1", "taskId": "t1"})
    assert _post(client, env).status_code == 503
    assert _post(client, env).json()["status"] == "ok"
    assert send.await_count == 2
    assert (
        send.call_args_list[0].kwargs["message_id"]
        == send.call_args_list[1].kwargs["message_id"]
    )


def test_concurrent_message_primary_key_conflict_returns_duplicate(monkeypatch):
    from sqlalchemy.exc import IntegrityError

    client, db, send = _posting_client(monkeypatch)
    db.get.side_effect = [None, SimpleNamespace(id="winner")]
    send.side_effect = IntegrityError("insert", {}, Exception("unique key"))
    env = _envelope("task.assigned", {"assignedToId": "u1", "taskId": "t1"})
    assert _post(client, env).json()["status"] == "duplicate"
    db.rollback.assert_awaited_once()


def test_unrelated_integrity_error_is_not_acknowledged(monkeypatch):
    from sqlalchemy.exc import IntegrityError

    client, db, send = _posting_client(monkeypatch)
    send.side_effect = IntegrityError("insert", {}, Exception("foreign key"))
    with pytest.raises(IntegrityError):
        _post(
            client, _envelope("task.assigned", {"assignedToId": "u1", "taskId": "t1"})
        )


def test_bad_event_type_is_acknowledged_without_crash():
    client = _client(Settings(projectops_webhook_secret=SECRET))
    assert _post(client, _envelope([], {})).json()["status"] == "ignored"


@pytest.mark.asyncio
async def test_sender_never_matches_an_unrelated_username():
    from app.api.project_ops import _get_or_create_sender
    from app.models.participant import ParticipantType
    db = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = SimpleNamespace(participant_type=ParticipantType.AGENT)
    db.execute.return_value = result
    await _get_or_create_sender(db, "astra")
    query = str(db.execute.call_args.args[0].whereclause)
    assert "keycloak_sub" in query
    assert "username" not in query


@pytest.mark.asyncio
async def test_sender_identity_type_conflict_fails_closed():
    from app.api.project_ops import _get_or_create_sender
    from app.models.participant import ParticipantType
    from fastapi import HTTPException
    db = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = SimpleNamespace(participant_type=ParticipantType.HUMAN)
    db.execute.return_value = result
    with pytest.raises(HTTPException) as error:
        await _get_or_create_sender(db, "astra")
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_membership_race_uses_savepoint_and_verifies_winner():
    from app.api.project_ops import _ensure_membership
    from sqlalchemy.exc import IntegrityError
    db = AsyncMock()
    db.add = MagicMock()
    db.begin_nested = MagicMock(return_value=AsyncMock())
    missing, winner = MagicMock(), MagicMock()
    missing.scalar_one_or_none.return_value = None
    winner.scalar_one_or_none.return_value = object()
    db.execute.side_effect = [missing, winner]
    db.flush.side_effect = IntegrityError("insert", {}, Exception("unique"))
    await _ensure_membership(db, "room", "sender")
    db.rollback.assert_not_awaited()
    db.commit.assert_not_awaited()
    assert db.execute.await_count == 2
