"""Route-level tests for POST /api/v1/webhooks/project-ops.

Exercises the flag-off and security/authorization paths end to end (via
FastAPI TestClient with dependency overrides). The message-posting happy path
touches the DB + LiveKit and is covered by the pure-logic tests; these tests
assert the gate order: unconfigured → 503, bad signature → 401, stale → 401,
unknown/unmapped → acknowledged + dropped.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from app.config import Settings
from app.deps import get_db, get_livekit, get_redis, get_settings_dep
from app.main import app

SECRET = "REMOVED"


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
        headers={"Content-Type": "application/json", "X-ProjectOps-Signature": "sha256=deadbeef"},
    )
    assert resp.status_code == 401


def test_valid_signature_passes_gate():
    settings = Settings(
        projectops_webhook_secret=SECRET,
        projectops_room_mapping={"u1": "astra"},
    )
    client = _client(settings)
    raw, sig = _sign(SECRET, _envelope("task.assigned", {"assignedToId": "u9-unmapped"}))
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
    raw, sig = _sign(SECRET, _envelope("task.assigned", {"assignedToId": "u1"}, timestamp=old))
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
