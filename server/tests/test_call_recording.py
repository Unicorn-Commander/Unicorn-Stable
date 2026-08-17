"""Call-audio recording (LiveKit egress → Meeting-Ops attach) unit tests.

DB-backed lease/outbox behaviour is exercised end-to-end on a real deployment
(the partial unique index needs Postgres); these tests pin the pure decision
surfaces: configuration gating, identity classification, backoff, and the
exact HTTP conversation the hand-off has with Meeting-Ops' upload API.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx

from app.config import Settings
from app.services import call_recording


def _settings(**overrides):
    values = {
        "call_recording_enabled": True,
        "meeting_ops_url": "https://meetingops.test",
        "meeting_ops_org_slug": "magic-unicorn",
        "meeting_ops_upload_pat": "mops_pat_secret",
        **overrides,
    }
    return Settings(**values)


# ---------------------------------------------------------------------------
# Configuration gating
# ---------------------------------------------------------------------------


def test_handoff_config_requires_url_pat_and_org():
    assert call_recording.handoff_config_error(_settings()) is None
    assert "URL" in call_recording.handoff_config_error(
        _settings(meeting_ops_url="", meeting_ops_upload_url="")
    )
    assert "PAT" in call_recording.handoff_config_error(
        _settings(meeting_ops_upload_pat="")
    )
    assert "Personal Access Token" in call_recording.handoff_config_error(
        _settings(meeting_ops_upload_pat="sk-not-a-pat")
    )
    assert "organization" in call_recording.handoff_config_error(
        _settings(meeting_ops_org_slug="")
    )


def test_upload_base_url_prefers_dedicated_upload_url():
    assert (
        call_recording.upload_base_url(
            _settings(meeting_ops_upload_url="http://meet-backend:9050/")
        )
        == "http://meet-backend:9050"
    )
    assert (
        call_recording.upload_base_url(_settings()) == "https://meetingops.test"
    )


def test_disabled_recording_never_touches_the_database():
    # db=None would explode on ANY attribute access; returning None proves the
    # flag short-circuits before any I/O.
    result = asyncio.run(
        call_recording.ensure_room_recording(
            None, _settings(call_recording_enabled=False), None, None
        )
    )
    assert result is None


def test_service_identities_are_not_call_participants():
    assert call_recording.is_service_identity("EG_abc123")
    assert call_recording.is_service_identity("broadcast-xyz")
    assert not call_recording.is_service_identity("aaron_2f9c…")
    assert not call_recording.is_service_identity("agent-majik")
    assert not call_recording.is_service_identity("")


def test_backoff_is_exponential_and_capped():
    s = _settings(
        call_recording_handoff_retry_base_seconds=10,
        call_recording_handoff_retry_max_seconds=60,
    )
    assert call_recording._backoff_seconds(s, 1) == 10
    assert call_recording._backoff_seconds(s, 2) == 20
    assert call_recording._backoff_seconds(s, 3) == 40
    assert call_recording._backoff_seconds(s, 4) == 60
    assert call_recording._backoff_seconds(s, 9) == 60


# ---------------------------------------------------------------------------
# Meeting-Ops upload conversation
# ---------------------------------------------------------------------------


class _FakeMOClient:
    """Meeting-Ops uploads API double: start → chunk* → finalize."""

    chunk_size = 4  # absurdly small so a tiny file spans multiple chunks
    start_status = 200
    chunk_status = 200
    finalize_status = 200
    calls: list[dict] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def post(self, url, *, json=None, data=None, files=None, headers=None):
        record = {
            "url": url,
            "json": json,
            "data": data,
            "files": files,
            "headers": headers,
        }
        type(self).calls.append(record)
        request = httpx.Request("POST", url)
        if url.endswith("/api/uploads/start"):
            return httpx.Response(
                type(self).start_status,
                json={"upload_id": "job-1", "chunk_size": type(self).chunk_size},
                request=request,
            )
        if url.endswith("/finalize"):
            return httpx.Response(
                type(self).finalize_status,
                json={"job_id": "job-1", "session_id": 754},
                request=request,
            )
        return httpx.Response(
            type(self).chunk_status,
            json={"received_chunks": 1, "total_chunks": 3},
            request=request,
        )


def _reset_fake():
    _FakeMOClient.calls = []
    _FakeMOClient.start_status = 200
    _FakeMOClient.chunk_status = 200
    _FakeMOClient.finalize_status = 200


def test_upload_attaches_to_target_session_in_server_sized_chunks(
    monkeypatch, tmp_path: Path
):
    _reset_fake()
    monkeypatch.setattr(httpx, "AsyncClient", _FakeMOClient)
    audio = tmp_path / "stable-call-x.ogg"
    audio.write_bytes(b"0123456789")  # 10 bytes / 4-byte chunks = 3 chunks

    result = asyncio.run(
        call_recording.upload_audio_to_meeting_ops(
            _settings(meeting_ops_upload_url="http://meet-backend:9050"),
            file_path=audio,
            target_session_id="6173999b-607f-4628-b58f-4d66f29c7f01",
            filename="stable-call-x.ogg",
        )
    )

    assert result["ok"] is True
    assert result["upload_id"] == "job-1"

    start = _FakeMOClient.calls[0]
    assert start["url"] == "http://meet-backend:9050/api/uploads/start"
    assert start["json"]["action"] == "attach"
    assert start["json"]["target_session_id"] == (
        "6173999b-607f-4628-b58f-4d66f29c7f01"
    )
    assert start["json"]["total_size"] == 10
    assert start["headers"]["Authorization"] == "Bearer mops_pat_secret"
    assert start["headers"]["X-MeetingOps-Org"] == "magic-unicorn"

    chunk_calls = [c for c in _FakeMOClient.calls if c["url"].endswith("/chunk")]
    assert [c["data"]["chunk_index"] for c in chunk_calls] == ["0", "1", "2"]
    sent = b"".join(c["files"]["data"][1] for c in chunk_calls)
    assert sent == b"0123456789"

    assert _FakeMOClient.calls[-1]["url"].endswith("/api/uploads/job-1/finalize")


def test_upload_classifies_server_errors_as_retryable(monkeypatch, tmp_path: Path):
    _reset_fake()
    monkeypatch.setattr(httpx, "AsyncClient", _FakeMOClient)
    audio = tmp_path / "a.ogg"
    audio.write_bytes(b"abcd")

    _FakeMOClient.start_status = 503
    result = asyncio.run(
        call_recording.upload_audio_to_meeting_ops(
            _settings(),
            file_path=audio,
            target_session_id="s",
            filename="a.ogg",
        )
    )
    assert result["ok"] is False
    assert result["retryable"] is True

    _reset_fake()
    _FakeMOClient.start_status = 404  # e.g. target session deleted
    result = asyncio.run(
        call_recording.upload_audio_to_meeting_ops(
            _settings(),
            file_path=audio,
            target_session_id="s",
            filename="a.ogg",
        )
    )
    assert result["ok"] is False
    assert result["retryable"] is False


def test_upload_refuses_missing_or_empty_files(tmp_path: Path):
    missing = asyncio.run(
        call_recording.upload_audio_to_meeting_ops(
            _settings(),
            file_path=tmp_path / "nope.ogg",
            target_session_id="s",
            filename="nope.ogg",
        )
    )
    assert missing["ok"] is False
    assert missing["retryable"] is False

    empty_file = tmp_path / "empty.ogg"
    empty_file.write_bytes(b"")
    empty = asyncio.run(
        call_recording.upload_audio_to_meeting_ops(
            _settings(),
            file_path=empty_file,
            target_session_id="s",
            filename="empty.ogg",
        )
    )
    assert empty["ok"] is False
    assert empty["retryable"] is False
