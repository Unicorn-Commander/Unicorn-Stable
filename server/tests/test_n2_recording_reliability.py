"""Regression pins for the dogfood N2 recording failures."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.api.transcripts import _merge_transcript_lines
from app.models.agent import AgentEvent
from app.models.message import Message
from app.services import call_recording as CR
from recording_fakes import FakeDB, livekit, room


def test_transcript_buffers_merge_by_segment_id() -> None:
    merged = _merge_transcript_lines(
        [{"segment_id": "s1", "text": "old", "ts": 1}],
        [{"segment_id": "s1", "text": "final", "ts": 2}, {"segment_id": "s2", "text": "next", "ts": 3}],
    )
    assert [line["text"] for line in merged] == ["final", "next"]


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


@pytest.mark.asyncio
async def test_stale_sweep_reconciles_livekit_before_declaring_loss() -> None:
    r = room()
    row = SimpleNamespace(id="row", room_id=r.id, livekit_room_name=r.livekit_room_name,
                          egress_id="EG_live", status="active", updated_at=CR._now() - CR.max_duration_seconds(_settings()) * __import__("datetime").timedelta(seconds=1),
                          kind="audio", started_at=CR._now(), created_at=CR._now(), ended_at=None,
                          file_path=None, file_size_bytes=None, duration_seconds=None,
                          error=None, handoff_status="none", handoff_next_attempt_at=None,
                          handoff_error=None, retention_until=None, legal_hold=False)
    lk = livekit()
    lk.list_egress = AsyncMock(return_value=[SimpleNamespace(egress_id="EG_live", status=3,
        file_results=[SimpleNamespace(filename="/egress-out/a.ogg", size=10, duration=1_000_000_000)], error="")])
    db = FakeDB(router=lambda stmt: __import__("recording_fakes").FakeResult(rows=[row]), objects={r.id: r})
    with patch.object(CR, "_announce_recording", AsyncMock()), patch.object(CR, "_announce_recording_failure", AsyncMock()):
        await CR._sweep_stale_rows(lambda: db, _settings(), livekit=lk)
    lk.list_egress.assert_awaited_once_with(r.livekit_room_name)
    assert row.status == "complete"


def _settings(**overrides):
    from app.config import Settings
    return Settings(call_recording_enabled=True, meeting_ops_url="https://mo.test",
                    meeting_ops_org_slug="org", meeting_ops_upload_pat="mops_pat_test", **overrides)
