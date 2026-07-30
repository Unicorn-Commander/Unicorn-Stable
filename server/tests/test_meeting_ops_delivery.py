from __future__ import annotations

import asyncio

import httpx

from app.config import Settings
from app.services import meeting_ops
from app.services.transcript_outbox import _backoff, scoped_idempotency_key


class _FakeClient:
    response = httpx.Response(
        200,
        json={
            "session_id": "meeting-123",
            "session_url": "https://meetingops.test/sessions/meeting-123",
        },
        request=httpx.Request("POST", "https://meetingops.test/api/v1/sessions/ingest"),
    )
    captured: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def post(self, url, *, json, headers):
        self.__class__.captured = {"url": url, "json": json, "headers": headers}
        return self.__class__.response


def _settings(**overrides):
    return Settings(
        meeting_ops_url="https://meetingops.test",
        meeting_ops_api_key="mops_pat_secret",
        meeting_ops_org_slug="magic-unicorn",
        **overrides,
    )


def test_delivery_uses_pat_org_and_idempotency_headers(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    payload = {"source": "unicorn-stable", "export_id": "stable-export-1", "lines": []}

    result = asyncio.run(
        meeting_ops.forward_transcript_to_meeting_ops(
            settings=_settings(),
            payload=payload,
        )
    )

    assert result["forwarded"] is True
    assert result["remote_session_id"] == "meeting-123"
    assert result["remote_session_url"].endswith("/sessions/meeting-123")
    assert _FakeClient.captured["headers"]["Authorization"] == "Bearer mops_pat_secret"
    assert _FakeClient.captured["headers"]["X-MeetingOps-Org"] == "magic-unicorn"
    assert _FakeClient.captured["headers"]["Idempotency-Key"] == "stable-export-1"


def test_delivery_classifies_transient_and_permanent_http_failures(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    payload = {"export_id": "stable-export-2", "lines": []}

    _FakeClient.response = httpx.Response(
        503,
        text="unavailable",
        request=httpx.Request("POST", "https://meetingops.test/api/v1/sessions/ingest"),
    )
    transient = asyncio.run(
        meeting_ops.forward_transcript_to_meeting_ops(
            settings=_settings(),
            payload=payload,
        )
    )
    assert transient["forwarded"] is False
    assert transient["retryable"] is True

    _FakeClient.response = httpx.Response(
        401,
        text="bad token",
        request=httpx.Request("POST", "https://meetingops.test/api/v1/sessions/ingest"),
    )
    permanent = asyncio.run(
        meeting_ops.forward_transcript_to_meeting_ops(
            settings=_settings(),
            payload=payload,
        )
    )
    assert permanent["forwarded"] is False
    assert permanent["retryable"] is False


def test_untrusted_remote_deep_link_is_dropped(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    _FakeClient.response = httpx.Response(
        200,
        json={
            "session_id": "meeting-evil",
            "session_url": "https://evil.example/phish",
        },
        request=httpx.Request("POST", "https://meetingops.test/api/v1/sessions/ingest"),
    )
    result = asyncio.run(
        meeting_ops.forward_transcript_to_meeting_ops(
            settings=_settings(),
            payload={"export_id": "stable-export-evil", "lines": []},
        )
    )
    assert result["forwarded"] is True
    assert result["remote_session_url"] is None


def test_retry_backoff_is_bounded():
    settings = _settings(
        meeting_ops_outbox_retry_base_seconds=5,
        meeting_ops_outbox_retry_max_seconds=60,
    )
    assert [_backoff(settings, n) for n in (1, 2, 3, 9)] == [5, 10, 20, 60]


def test_caller_idempotency_keys_are_scoped_per_room():
    import uuid

    room_a = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    room_b = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    assert scoped_idempotency_key(room_a, "same-client-key") != scoped_idempotency_key(
        room_b, "same-client-key"
    )
