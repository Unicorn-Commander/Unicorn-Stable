"""Regression pins for the dogfood N2 recording failures (2026-09-24).

Three real rows drove this:
* a completed 3.5 MB recording with nowhere to attach (``no_session``)
  because no browser exported a transcript for the call;
* an egress that died 1.2 s after StartEgress ("Start signal not received",
  0 bytes) and was only recorded because a second person happened to join;
* a finished egress whose ``egress_ended`` webhook never arrived and was
  terminalised as lost by the sweep.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.models.agent import AgentEvent
from app.models.message import Message
from app.services import call_recording as CR
from recording_fakes import FakeDB, FakeResult, livekit, room
from test_call_recording import _FakeMOClient, _reset_fake


def _settings(**overrides):
    from app.config import Settings

    return Settings(
        call_recording_enabled=True,
        meeting_ops_url="https://mo.test",
        meeting_ops_org_slug="org",
        meeting_ops_upload_pat="mops_pat_test",
        **overrides,
    )


def _failed_row(r, **overrides) -> SimpleNamespace:
    base = dict(
        id="row-failed",
        room_id=r.id,
        livekit_room_name=r.livekit_room_name,
        egress_id="EG_dead",
        status="active",
        kind="audio",
        started_by=None,
        started_at=CR._now(),
        created_at=CR._now(),
        updated_at=CR._now(),
        ended_at=None,
        file_path=None,
        file_size_bytes=None,
        duration_seconds=None,
        error=None,
        handoff_status="none",
        handoff_next_attempt_at=None,
        handoff_error=None,
        retention_until=None,
        legal_hold=False,
        storage_url=None,
        mo_session_id=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _dead_egress(egress_id="EG_dead", room_name="stable-test-room") -> SimpleNamespace:
    return SimpleNamespace(
        egress_id=egress_id,
        room_name=room_name,
        status=4,  # EGRESS_FAILED
        error="Start signal not received",
        file_results=[],
    )


def _router_for(row, *, recent_failures: int = 0):
    """Answer the row lookup with ``row`` and the retry-budget count."""

    def router(stmt):
        sql = str(stmt).lower()
        if "count(" in sql:
            return FakeResult(scalar=recent_failures)
        return FakeResult(scalar=row)

    return router


def _sweep_router(row):
    """The sweep's first select is the stale-`starting` scan, the second the
    stale-`active` scan; ``row`` is an active row, so it answers the second.
    Every later execute is the egress-id lookup inside handle_egress_event."""
    calls = {"n": 0}

    def router(stmt):
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeResult(rows=[])
        if calls["n"] == 2:
            return FakeResult(rows=[row])
        return FakeResult(scalar=row)

    return router


# --- 1. a start failure is loud ---------------------------------------------


@pytest.mark.asyncio
async def test_start_failure_is_visible_and_audited() -> None:
    r = room()
    db = FakeDB()
    lk = livekit()
    lk.start_room_audio_egress = AsyncMock(side_effect=RuntimeError("Start signal not received"))
    with patch.object(CR, "_ws_room", AsyncMock()):
        with pytest.raises(CR.RecordingError):
            await CR.start_recording(db, _settings(), lk, r, kind="audio", started_by=None)
    assert any(isinstance(item, Message) and "Recording failed" in item.content for item in db.added)
    assert any(isinstance(item, AgentEvent) and item.event_type == "recording_failed" for item in db.added)


# --- 2. an egress that died before recording is retried once for `always` rooms


@pytest.mark.asyncio
async def test_dead_egress_in_an_always_room_is_retried_and_not_announced_as_lost() -> None:
    r = room(recording_policy="always")
    row = _failed_row(r)
    db = FakeDB(router=_router_for(row), objects={r.id: r})
    lk = livekit(identities=["aaron_123"])
    replacement = SimpleNamespace(id="row-replacement")
    with (
        patch.object(CR, "start_recording", AsyncMock(return_value=replacement)) as start,
        patch.object(CR, "_announce_recording_failure", AsyncMock()) as shout,
        patch.object(CR, "announce_recording", AsyncMock()) as receipt,
    ):
        await CR.handle_egress_event(db, _settings(), "egress_ended", _dead_egress(), livekit=lk)
    assert row.status == "failed"
    assert "retried automatically as recording row-replacement" in row.error
    start.assert_awaited_once()
    assert start.await_args.kwargs["kind"] == "audio"
    shout.assert_not_awaited()
    receipt.assert_not_awaited()


@pytest.mark.asyncio
async def test_dead_egress_is_announced_when_nobody_is_left_to_record() -> None:
    r = room(recording_policy="always")
    row = _failed_row(r)
    db = FakeDB(router=_router_for(row), objects={r.id: r})
    lk = livekit(identities=["agent-rook"])  # only an agent remains
    with (
        patch.object(CR, "start_recording", AsyncMock()) as start,
        patch.object(CR, "_announce_recording_failure", AsyncMock()) as shout,
        patch.object(CR, "announce_recording", AsyncMock()) as receipt,
    ):
        await CR.handle_egress_event(db, _settings(), "egress_ended", _dead_egress(), livekit=lk)
    start.assert_not_awaited()
    shout.assert_awaited_once()
    receipt.assert_awaited_once()
    assert receipt.await_args.kwargs["reason"] == "failed"


@pytest.mark.asyncio
async def test_retry_budget_is_two_failures_per_room_in_three_minutes() -> None:
    r = room(recording_policy="always")
    row = _failed_row(r)
    db = FakeDB(router=_router_for(row, recent_failures=2), objects={r.id: r})
    lk = livekit(identities=["aaron_123"])
    with (
        patch.object(CR, "start_recording", AsyncMock()) as start,
        patch.object(CR, "_announce_recording_failure", AsyncMock()) as shout,
        patch.object(CR, "announce_recording", AsyncMock()),
    ):
        await CR.handle_egress_event(db, _settings(), "egress_ended", _dead_egress(), livekit=lk)
    start.assert_not_awaited()
    shout.assert_awaited_once()


@pytest.mark.asyncio
async def test_on_request_rooms_are_not_retried_silently() -> None:
    r = room(recording_policy="on_request")
    row = _failed_row(r, started_by="aaron")
    db = FakeDB(router=_router_for(row), objects={r.id: r})
    lk = livekit(identities=["aaron_123"])
    with (
        patch.object(CR, "start_recording", AsyncMock()) as start,
        patch.object(CR, "_announce_recording_failure", AsyncMock()) as shout,
        patch.object(CR, "announce_recording", AsyncMock()),
    ):
        await CR.handle_egress_event(db, _settings(), "egress_ended", _dead_egress(), livekit=lk)
    start.assert_not_awaited()
    shout.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_completed_egress_is_never_retried() -> None:
    r = room(recording_policy="always")
    row = _failed_row(r)
    db = FakeDB(router=_router_for(row), objects={r.id: r})
    lk = livekit(identities=["aaron_123"])
    done = SimpleNamespace(
        egress_id="EG_dead",
        room_name=r.livekit_room_name,
        status=3,
        error="",
        file_results=[SimpleNamespace(filename="/egress-out/a.ogg", size=10, duration=1_000_000_000)],
    )
    with (
        patch.object(CR, "start_recording", AsyncMock()) as start,
        patch.object(CR, "_announce_recording_failure", AsyncMock()) as shout,
        patch.object(CR, "announce_recording", AsyncMock()) as receipt,
    ):
        await CR.handle_egress_event(db, _settings(), "egress_ended", done, livekit=lk)
    assert row.status == "complete"
    start.assert_not_awaited()
    shout.assert_not_awaited()
    assert receipt.await_args.kwargs["reason"] == "ended"


# --- 3. a missed webhook is reconciled against LiveKit before it is called lost


@pytest.mark.asyncio
async def test_stale_sweep_reconciles_livekit_before_declaring_loss() -> None:
    r = room()
    stale_since = CR._now() - dt.timedelta(seconds=CR.max_duration_seconds(_settings()) + 60)
    row = _failed_row(r, egress_id="EG_live", updated_at=stale_since)
    lk = livekit()
    lk.list_egress = AsyncMock(
        return_value=[
            SimpleNamespace(
                egress_id="EG_live",
                room_name=r.livekit_room_name,
                status=3,
                file_results=[SimpleNamespace(filename="/egress-out/a.ogg", size=10, duration=1_000_000_000)],
                error="",
            )
        ]
    )
    db = FakeDB(router=_sweep_router(row), objects={r.id: r})
    with (
        patch.object(CR, "announce_recording", AsyncMock()),
        patch.object(CR, "_announce_recording_failure", AsyncMock()) as shout,
    ):
        await CR._sweep_stale_rows(lambda: db, _settings(), livekit=lk)
    lk.list_egress.assert_awaited_once_with(r.livekit_room_name)
    assert row.status == "complete"
    assert row.handoff_status == "pending"
    shout.assert_not_awaited()


@pytest.mark.asyncio
async def test_stale_sweep_without_a_livekit_record_is_loud() -> None:
    r = room()
    stale_since = CR._now() - dt.timedelta(seconds=CR.max_duration_seconds(_settings()) + 60)
    row = _failed_row(r, egress_id="EG_gone", updated_at=stale_since)
    lk = livekit()
    lk.list_egress = AsyncMock(return_value=[])
    db = FakeDB(router=_sweep_router(row), objects={r.id: r})
    with patch.object(CR, "_announce_recording_failure", AsyncMock()) as shout:
        await CR._sweep_stale_rows(lambda: db, _settings(), livekit=lk)
    assert row.status == "failed"
    assert "LiveKit egress was not found" in row.error
    shout.assert_awaited_once()


# --- 4. no transcript export → the media upload makes the session ------------


def test_upload_without_a_session_asks_meeting_ops_to_transcribe(monkeypatch, tmp_path: Path) -> None:
    _reset_fake()
    monkeypatch.setattr(httpx, "AsyncClient", _FakeMOClient)
    audio = tmp_path / "stable-call-x.ogg"
    audio.write_bytes(b"0123456789")

    result = asyncio.run(
        CR.upload_audio_to_meeting_ops(
            _settings(meeting_ops_upload_url="http://meet-backend:9050"),
            file_path=audio,
            target_session_id=None,
            filename="stable-call-x.ogg",
        )
    )

    assert result["ok"] is True
    assert result["session_id"] == "754"  # from finalize
    start = _FakeMOClient.calls[0]
    assert start["json"]["action"] == "transcribe"
    assert "target_session_id" not in start["json"]


def test_upload_with_a_session_still_attaches(monkeypatch, tmp_path: Path) -> None:
    _reset_fake()
    monkeypatch.setattr(httpx, "AsyncClient", _FakeMOClient)
    audio = tmp_path / "stable-call-x.ogg"
    audio.write_bytes(b"0123456789")

    result = asyncio.run(
        CR.upload_audio_to_meeting_ops(
            _settings(meeting_ops_upload_url="http://meet-backend:9050"),
            file_path=audio,
            target_session_id="sess-1",
            filename="stable-call-x.ogg",
        )
    )

    assert result["ok"] is True
    start = _FakeMOClient.calls[0]
    assert start["json"]["action"] == "attach"
    assert start["json"]["target_session_id"] == "sess-1"


# --- 5. the row learns which session MO made from the media --------------


class _FakeStatusClient:
    """httpx.AsyncClient double for GET /api/uploads/{id}."""

    responses: dict[str, dict] = {}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, *, headers=None):
        assert url.endswith("/status"), url  # MO: GET /api/uploads/{id}/status
        upload_id = url.rsplit("/", 2)[-2]
        body = type(self).responses.get(upload_id)
        if body is None:
            return httpx.Response(404, json={"detail": "no such upload"}, request=httpx.Request("GET", url))
        return httpx.Response(200, json=body, request=httpx.Request("GET", url))


@pytest.mark.asyncio
async def test_media_session_backfill_fills_session_or_records_pipeline_failure(monkeypatch) -> None:
    monkeypatch.setattr(httpx, "AsyncClient", _FakeStatusClient)
    _FakeStatusClient.responses = {
        "up-ok": {"stage": "done", "session_id": 754},
        "up-pending": {"stage": "transcribing", "session_id": None},
        "up-dead": {"stage": "failed", "session_id": None, "error": "ffmpeg exploded"},
        "up-silent": {"stage": "failed", "session_id": 1004, "error": "Transcription produced no segments."},
    }
    r = room()
    ok = _failed_row(r, id="row-ok", status="complete", handoff_status="delivered", mo_upload_id="up-ok",
                     handoff_last_attempt_at=CR._now())
    pending = _failed_row(r, id="row-pending", status="complete", handoff_status="delivered",
                          mo_upload_id="up-pending", handoff_last_attempt_at=CR._now())
    dead = _failed_row(r, id="row-dead", status="complete", handoff_status="delivered", mo_upload_id="up-dead",
                       handoff_last_attempt_at=CR._now())
    silent = _failed_row(r, id="row-silent", status="complete", handoff_status="delivered",
                         mo_upload_id="up-silent", handoff_last_attempt_at=CR._now())
    db = FakeDB(router=lambda stmt: FakeResult(rows=[ok, pending, dead, silent]))
    filled = await CR._sweep_media_sessions(lambda: db, _settings(meeting_ops_upload_url="http://meet-backend:9050"))
    assert filled == 2
    assert ok.mo_session_id == "754"
    assert pending.mo_session_id is None and pending.handoff_status == "delivered"
    assert dead.handoff_status == "failed" and "ffmpeg exploded" in dead.handoff_error
    # measured 09-24: MO made session 1004 but its STT found no segments —
    # the link works, the reason is on the row, the status stays delivered
    assert silent.mo_session_id == "1004" and silent.handoff_status == "delivered"
    assert "no segments" in silent.handoff_error
    assert db.commits == 1


@pytest.mark.asyncio
async def test_media_session_backfill_is_quiet_when_unconfigured() -> None:
    from app.config import Settings

    db = FakeDB()
    assert await CR._sweep_media_sessions(lambda: db, Settings(call_recording_enabled=True)) == 0
    assert db.executed == []


# --- 6. composite template: livekit's own grid until our page exists ------


@pytest.mark.asyncio
async def test_default_composite_uses_livekit_template_without_a_recorder_token() -> None:
    from recording_fakes import FakeRedis

    r = room(recording_policy="always", recording_kind="composite")
    db = FakeDB()
    lk = livekit()
    mint = AsyncMock()
    with (
        patch("app.api.broadcast.mint_recorder_token", mint),
        patch.object(CR, "_ws_room", AsyncMock()),
        patch.object(CR, "announce_recording", AsyncMock()),
    ):
        row = await CR.start_recording(
            db, _settings(call_recording_composite_layout="speaker"), lk, r,
            kind="composite", started_by=None, redis=FakeRedis(), trigger="policy always",
        )
    assert row.kind == "composite"
    mint.assert_not_awaited()
    args, kwargs = lk.start_room_composite_video_egress.await_args
    assert args[0] == r.livekit_room_name
    assert kwargs["custom_base_url"] is None
    assert kwargs["layout"] == "speaker"


def test_composite_template_normalises() -> None:
    from app.config import Settings

    assert CR.composite_template(Settings(call_recording_composite_template="stable")) == "stable"
    assert CR.composite_template(Settings(call_recording_composite_template="STABLE ")) == "stable"
    assert CR.composite_template(Settings(call_recording_composite_template="")) == "livekit"
    assert CR.composite_template(Settings(call_recording_composite_template="whatever")) == "livekit"
