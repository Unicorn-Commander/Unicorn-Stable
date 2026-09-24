"""Recording lifecycle (design §8): policy-driven auto-start, the composite
path (capacity slot + recorder token + MP4 egress), receipts on every
transition, egress end → retention, storage-first hand-off, local cleanup and
the retention sweep.

LiveKit, Redis, S3 and Postgres are MOCKED (tests/recording_fakes.py). The
OGG naming and the Meeting-Ops attach for audio are pinned byte-for-byte to
what the pre-§8 lane did, so the only behaviour change on deploy is the
policy gate.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

import httpx

from app.config import Settings
from app.models.call_egress import CallEgress
from app.models.message import ContentType, Message
from app.services import call_recording as CR
from app.services import recording_capacity
from app.services.recording_policy import RECORD_MY_CALLS_KEY, RECORDER_ENTITLED_KEY
from recording_fakes import FakeDB, FakeRedis, FakeResult, livekit, participant, room, stmt_sql


def _settings(**overrides) -> Settings:
    values = {
        "call_recording_enabled": True,
        "public_base_url": "https://stable.test",
        "meeting_ops_url": "https://meetingops.test",
        "meeting_ops_org_slug": "magic-unicorn",
        "meeting_ops_upload_pat": "mops_pat_secret",
        **overrides,
    }
    return Settings(**values)


def _entitled(pref=True):
    return participant(metadata_={RECORDER_ENTITLED_KEY: True, RECORD_MY_CALLS_KEY: pref})


class AutoStartPolicy(IsolatedAsyncioTestCase):
    async def test_policy_off_never_touches_the_database(self) -> None:
        # db=None would explode on ANY attribute access.
        out = await CR.ensure_room_recording(None, _settings(), None, room(recording_policy="off"))
        self.assertIsNone(out)

    async def test_master_switch_off_short_circuits_even_always_rooms(self) -> None:
        out = await CR.ensure_room_recording(
            None, _settings(call_recording_enabled=False), None, room(recording_policy="always")
        )
        self.assertIsNone(out)

    async def _ensure(self, r, joiner=None, identities=None, active=None):
        db = FakeDB(router=lambda s: FakeResult(scalar=active))
        started = AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4()))
        lk = livekit(identities or [])
        with patch.object(CR, "start_recording", started):
            out = await CR.ensure_room_recording(
                db, _settings(), lk, r, redis=FakeRedis(), joiner=joiner,
                joiner_identity=f"{joiner.username}_{joiner.id}" if joiner else None,
            )
        return out, started

    async def test_always_room_starts_policy_driven_with_no_starter(self) -> None:
        r = room(recording_policy="always", recording_kind="composite")
        _, started = await self._ensure(r, joiner=participant())
        kwargs = started.await_args.kwargs
        self.assertIsNone(kwargs["started_by"])
        self.assertEqual(kwargs["kind"], "composite")
        self.assertTrue(kwargs["allow_fallback"], "an always room must still produce a receipt")
        self.assertEqual(kwargs["trigger"], "policy always")

    async def test_always_room_with_a_recording_in_flight_does_nothing(self) -> None:
        r = room(recording_policy="always")
        _, started = await self._ensure(r, active=SimpleNamespace(id=uuid.uuid4()))
        started.assert_not_awaited()

    async def test_on_request_pref_starts_when_the_joiner_started_the_call(self) -> None:
        r = room(recording_policy="on_request")
        j = _entitled()
        _, started = await self._ensure(r, joiner=j, identities=[f"aaron_{j.id}"])
        kwargs = started.await_args.kwargs
        self.assertEqual(kwargs["started_by"], j.id)
        self.assertEqual(kwargs["trigger"], "record_my_calls")

    async def test_on_request_pref_ignores_a_joiner_of_an_ongoing_call(self) -> None:
        r = room(recording_policy="on_request")
        j = _entitled()
        _, started = await self._ensure(r, joiner=j, identities=[f"shafen_{uuid.uuid4()}", f"aaron_{j.id}"])
        started.assert_not_awaited()

    async def test_agents_and_service_identities_do_not_count_as_humans(self) -> None:
        r = room(recording_policy="on_request")
        j = _entitled()
        _, started = await self._ensure(
            r, joiner=j, identities=["agent-majik", "broadcast-x", "EG_1", f"aaron_{j.id}"]
        )
        started.assert_awaited_once()

    async def test_on_request_pref_without_the_role_never_starts(self) -> None:
        r = room(recording_policy="on_request")
        j = participant(metadata_={RECORD_MY_CALLS_KEY: True})
        _, started = await self._ensure(r, joiner=j, identities=[f"aaron_{j.id}"])
        started.assert_not_awaited()

    async def test_on_request_without_pref_never_starts(self) -> None:
        r = room(recording_policy="on_request")
        j = _entitled(pref=False)
        _, started = await self._ensure(r, joiner=j, identities=[f"aaron_{j.id}"])
        started.assert_not_awaited()

    async def test_refusals_are_swallowed_fail_open(self) -> None:
        r = room(recording_policy="always")
        db = FakeDB(router=lambda s: FakeResult(scalar=None))
        with patch.object(CR, "start_recording", AsyncMock(side_effect=CR.RecordingError("capacity", 429, "full"))):
            self.assertIsNone(await CR.ensure_room_recording(db, _settings(), livekit(), r))
        with patch.object(CR, "start_recording", AsyncMock(side_effect=RuntimeError("boom"))):
            self.assertIsNone(await CR.ensure_room_recording(db, _settings(), livekit(), r))


class StartRecording(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.announce = AsyncMock()
        self._p = patch.object(CR, "announce_recording", self.announce)
        self._p.start()

    def tearDown(self) -> None:
        self._p.stop()

    async def test_audio_path_is_byte_for_byte_the_original(self) -> None:
        r = room()
        db = FakeDB()
        lk = livekit()
        row = await CR.start_recording(db, _settings(), lk, r, kind="audio", started_by=None, trigger="policy always")
        self.assertEqual(row.status, "active")
        self.assertEqual(row.egress_id, "EG_audio")
        self.assertEqual(row.kind, "audio")
        room_name, filepath = lk.start_room_audio_egress.await_args.args
        self.assertEqual(room_name, r.livekit_room_name)
        self.assertRegex(filepath, rf"^/egress-out/stable-call-{r.id}-\d{{8}}T\d{{6}}Z\.ogg$")
        lk.start_room_composite_video_egress.assert_not_awaited()
        self.announce.assert_awaited_once()
        self.assertTrue(self.announce.await_args.kwargs["active"])

    async def test_lease_race_is_409_already_active(self) -> None:
        db = FakeDB()
        db.fail_next_commit = True
        with self.assertRaises(CR.RecordingError) as ctx:
            await CR.start_recording(db, _settings(), livekit(), room(), kind="audio", started_by=None)
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(db.rollbacks, 1)

    async def test_unknown_kind_is_400_and_disabled_is_503(self) -> None:
        with self.assertRaises(CR.RecordingError) as ctx:
            await CR.start_recording(FakeDB(), _settings(), livekit(), room(), kind="track", started_by=None)
        self.assertEqual(ctx.exception.status, 400)
        with self.assertRaises(CR.RecordingError) as ctx:
            await CR.start_recording(
                FakeDB(), _settings(call_recording_enabled=False), livekit(), room(), kind="audio", started_by=None
            )
        self.assertEqual(ctx.exception.status, 503)

    async def test_composite_takes_a_slot_mints_a_recorder_token_and_starts_mp4(self) -> None:
        r = room()
        db = FakeDB()
        lk = livekit()
        redis = FakeRedis()
        mint = AsyncMock(return_value=("sbt-raw", SimpleNamespace(id=uuid.uuid4())))
        starter = uuid.uuid4()
        with patch("app.api.broadcast.mint_recorder_token", mint):
            row = await CR.start_recording(
                db, _settings(call_recording_composite_preset="H264_1080P_30", call_recording_composite_template="stable"), lk, r,
                kind="composite", started_by=starter, redis=redis, trigger="user", started_by_name="Aaron",
            )
        self.assertEqual(row.kind, "composite")
        self.assertEqual(row.egress_id, "EG_video")
        self.assertEqual(row.started_by, starter)
        # capacity slot held under the row id
        self.assertIn(str(row.id), redis.zsets[recording_capacity.SLOTS_KEY])
        # recorder token minted for THIS row, TTL = max duration
        self.assertEqual(mint.await_args.kwargs["egress_row_id"], row.id)
        self.assertEqual(mint.await_args.kwargs["ttl_seconds"], 6 * 3600)
        # egress request: our template with the rt param, MP4 output, preset
        args, kwargs = lk.start_room_composite_video_egress.await_args
        self.assertEqual(args[0], r.livekit_room_name)
        self.assertRegex(args[1], rf"^/egress-out/stable-call-{r.id}-\d{{8}}T\d{{6}}Z\.mp4$")
        self.assertEqual(kwargs["custom_base_url"], f"https://stable.test/broadcast/{r.id}/composite?rt=sbt-raw")
        self.assertEqual(kwargs["preset"], "H264_1080P_30")
        lk.start_room_audio_egress.assert_not_awaited()
        self.assertEqual(self.announce.await_args.kwargs["started_by_name"], "Aaron")

    async def test_third_composite_is_refused_with_429_and_leaves_no_row(self) -> None:
        redis = FakeRedis()
        for m in ("a", "b"):
            await recording_capacity.acquire_composite_slot(redis, member=m, limit=2, ttl_seconds=60)
        db = FakeDB()
        with self.assertRaises(CR.RecordingError) as ctx:
            await CR.start_recording(db, _settings(), livekit(), room(), kind="composite", started_by=None, redis=redis)
        self.assertEqual(ctx.exception.status, 429)
        self.assertIn("capacity", ctx.exception.detail)
        self.assertEqual(len(db.deleted), 1, "the lease row must not linger as a failed attempt")
        self.assertEqual(set(redis.zsets[recording_capacity.SLOTS_KEY]), {"a", "b"})

    async def test_policy_start_at_capacity_falls_back_to_audio(self) -> None:
        redis = FakeRedis()
        for m in ("a", "b"):
            await recording_capacity.acquire_composite_slot(redis, member=m, limit=2, ttl_seconds=60)
        lk = livekit()
        row = await CR.start_recording(
            FakeDB(), _settings(), lk, room(), kind="composite", started_by=None, redis=redis, allow_fallback=True
        )
        self.assertEqual(row.kind, "audio")
        lk.start_room_audio_egress.assert_awaited_once()
        lk.start_room_composite_video_egress.assert_not_awaited()

    async def test_no_redis_means_composite_capacity_unknown(self) -> None:
        with self.assertRaises(CR.RecordingError) as ctx:
            await CR.start_recording(FakeDB(), _settings(), livekit(), room(), kind="composite", started_by=None, redis=None)
        self.assertEqual(ctx.exception.status, 503)

    async def test_egress_failure_frees_slot_and_token_and_is_503(self) -> None:
        r = room()
        redis = FakeRedis()
        lk = livekit()
        lk.start_room_composite_video_egress = AsyncMock(side_effect=RuntimeError("no egress worker"))
        mint = AsyncMock(return_value=("sbt-raw", SimpleNamespace(id=uuid.uuid4())))
        revoke = AsyncMock(return_value=1)
        db = FakeDB()
        with patch("app.api.broadcast.mint_recorder_token", mint), patch("app.api.broadcast.revoke_recorder_tokens", revoke):
            with self.assertRaises(CR.RecordingError) as ctx:
                await CR.start_recording(db, _settings(), lk, r, kind="composite", started_by=None, redis=redis)
        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual(redis.zsets.get(recording_capacity.SLOTS_KEY, {}), {})
        revoke.assert_awaited_once()
        failed = [o for o in db.added if isinstance(o, CallEgress)][0]
        self.assertEqual(failed.status, "failed")
        self.assertIn("StartEgress failed", failed.error)
        self.announce.assert_not_awaited()


class Receipts(IsolatedAsyncioTestCase):
    async def _announce(self, r, row, active, **kw):
        frames: list = []
        posted: list = []

        async def ws(room_id, envelope):
            frames.append((room_id, envelope))

        async def post(db, room_id, content, metadata):
            posted.append((content, metadata))

        with patch.object(CR, "_ws_room", ws), patch.object(CR, "_post_system_message", post):
            await CR.announce_recording(FakeDB(), r, row, active=active, **kw)
        return frames, posted

    def _row(self, **kw):
        base = dict(id=uuid.uuid4(), kind="audio", started_by=None, started_at=datetime.now(timezone.utc), created_at=None)
        base.update(kw)
        return SimpleNamespace(**base)

    async def test_started_by_a_person(self) -> None:
        r = room()
        pid = uuid.uuid4()
        frames, posted = await self._announce(r, self._row(started_by=pid), True, started_by_name="Aaron", reason="user")
        (room_id, env), = frames
        self.assertEqual(room_id, r.id)
        self.assertEqual(env["type"], "recording_state")
        self.assertEqual(env["payload"]["active"], True)
        self.assertEqual(env["payload"]["kind"], "audio")
        self.assertEqual(env["payload"]["started_by"], {"id": str(pid), "display_name": "Aaron"})
        self.assertIsNotNone(env["payload"]["started_at"])
        content, meta = posted[0]
        self.assertEqual(content, "Recording started by Aaron")
        self.assertEqual(meta["event"], "started")
        self.assertEqual(meta["kind"], "recording")

    async def test_policy_start_and_composite_wording(self) -> None:
        r = room()
        _, posted = await self._announce(r, self._row(), True, reason="policy always")
        self.assertEqual(posted[0][0], "Recording started (this room always records)")
        _, posted = await self._announce(r, self._row(kind="composite", started_by=uuid.uuid4()), True, started_by_name="Shafen")
        self.assertEqual(posted[0][0], "Video recording started by Shafen")

    async def test_stopped(self) -> None:
        r = room()
        frames, posted = await self._announce(r, self._row(), False, reason="stop_requested")
        self.assertFalse(frames[0][1]["payload"]["active"])
        self.assertEqual(posted[0][0], "Recording stopped")
        _, posted = await self._announce(r, self._row(), False, reason="room_idle")
        self.assertEqual(posted[0][0], "Recording stopped (room idle)")

    async def test_system_message_row_and_envelope(self) -> None:
        r = room()
        db = FakeDB()
        frames: list = []

        async def ws(room_id, envelope):
            frames.append(envelope)

        with patch.object(CR, "_ws_room", ws):
            await CR._post_system_message(db, r.id, "Recording stopped", {"kind": "recording"})
        msg = [o for o in db.added if isinstance(o, Message)][0]
        self.assertIsNone(msg.sender_id)
        self.assertEqual(msg.content_type, ContentType.SYSTEM)
        self.assertEqual(msg.content, "Recording stopped")
        env = frames[0]
        self.assertEqual(env["type"], "message")
        self.assertEqual(env["payload"]["message"]["sender_type"], "system")
        self.assertEqual(env["payload"]["message"]["content_type"], "system")
        self.assertEqual(env["payload"]["message"]["sender_name"], "Stable")


def _egress_info(egress_id="EG_1", room_name="stable-test-room", status=3, size=1234, duration_s=42.0, error=""):
    return SimpleNamespace(
        egress_id=egress_id,
        room_name=room_name,
        status=status,
        error=error,
        file_results=[SimpleNamespace(filename="/egress-out/stable-call-x.ogg", size=size, duration=int(duration_s * 1e9))],
    )


class EgressEnded(IsolatedAsyncioTestCase):
    def _row(self, r, **kw):
        base = dict(
            id=uuid.uuid4(), room_id=r.id, livekit_room_name=r.livekit_room_name, egress_id="EG_1",
            status="active", kind="audio", started_by=None, started_at=datetime.now(timezone.utc),
            created_at=datetime.now(timezone.utc), ended_at=None, file_path=None, file_size_bytes=None,
            duration_seconds=None, error=None, handoff_status="none", handoff_next_attempt_at=None,
            handoff_error=None, retention_until=None, legal_hold=False,
        )
        base.update(kw)
        return SimpleNamespace(**base)

    async def test_complete_sets_retention_queues_handoff_and_announces_stop(self) -> None:
        r = room()
        row = self._row(r)
        db = FakeDB(router=lambda s: FakeResult(scalar=row), objects={r.id: r})
        announce = AsyncMock()
        with patch.object(CR, "announce_recording", announce):
            await CR.handle_egress_event(db, _settings(call_recording_retention_days=30), "egress_ended", _egress_info())
        self.assertEqual(row.status, "complete")
        self.assertEqual(row.file_path, "/egress-out/stable-call-x.ogg")
        self.assertEqual(row.duration_seconds, 42.0)
        self.assertEqual(row.handoff_status, "pending")
        delta = row.retention_until - datetime.now(timezone.utc)
        self.assertGreater(delta, timedelta(days=29, hours=23))
        self.assertLessEqual(delta, timedelta(days=30))
        announce.assert_awaited_once()
        self.assertFalse(announce.await_args.kwargs["active"])
        self.assertEqual(announce.await_args.kwargs["reason"], "ended")

    async def test_a_stop_already_announced_is_not_announced_twice(self) -> None:
        r = room()
        row = self._row(r, status="stopping")
        db = FakeDB(router=lambda s: FakeResult(scalar=row), objects={r.id: r})
        announce = AsyncMock()
        with patch.object(CR, "announce_recording", announce):
            await CR.handle_egress_event(db, _settings(), "egress_ended", _egress_info())
        announce.assert_not_awaited()
        self.assertEqual(row.status, "complete")

    async def test_failed_egress_is_failed_with_the_error_and_announced(self) -> None:
        r = room()
        row = self._row(r)
        db = FakeDB(router=lambda s: FakeResult(scalar=row), objects={r.id: r})
        announce = AsyncMock()
        with patch.object(CR, "announce_recording", announce):
            await CR.handle_egress_event(db, _settings(), "egress_ended", _egress_info(status=4, error="chrome crashed"))
        self.assertEqual(row.status, "failed")
        self.assertEqual(row.error, "chrome crashed")
        self.assertIsNone(row.retention_until)
        self.assertEqual(announce.await_args.kwargs["reason"], "failed")

    async def test_unconfigured_handoff_is_blocked_not_pending(self) -> None:
        r = room()
        row = self._row(r)
        db = FakeDB(router=lambda s: FakeResult(scalar=row), objects={r.id: r})
        with patch.object(CR, "announce_recording", AsyncMock()):
            await CR.handle_egress_event(db, _settings(meeting_ops_upload_pat=""), "egress_ended", _egress_info())
        self.assertEqual(row.handoff_status, "blocked")

    async def test_composite_end_frees_the_slot_and_revokes_the_token(self) -> None:
        r = room()
        row = self._row(r, kind="composite", egress_id="EG_video")
        redis = FakeRedis()
        await recording_capacity.acquire_composite_slot(redis, member=str(row.id), limit=2, ttl_seconds=60)
        db = FakeDB(router=lambda s: FakeResult(scalar=row), objects={r.id: r})
        revoke = AsyncMock(return_value=1)
        with patch.object(CR, "announce_recording", AsyncMock()), patch("app.api.broadcast.revoke_recorder_tokens", revoke):
            await CR.handle_egress_event(
                db, _settings(), "egress_ended", _egress_info(egress_id="EG_video"), redis=redis, livekit=livekit()
            )
        self.assertEqual(redis.zsets.get(recording_capacity.SLOTS_KEY, {}), {})
        self.assertEqual(revoke.await_args.kwargs["egress_row_id"], row.id)

    async def test_started_event_activates_a_starting_row(self) -> None:
        r = room()
        row = self._row(r, status="starting", started_at=None)
        db = FakeDB(router=lambda s: FakeResult(scalar=row))
        await CR.handle_egress_event(db, _settings(), "egress_started", _egress_info())
        self.assertEqual(row.status, "active")
        self.assertIsNotNone(row.started_at)


class StopRecording(IsolatedAsyncioTestCase):
    async def test_stop_requests_each_egress_once_and_announces_once(self) -> None:
        r = room()
        rows = [
            SimpleNamespace(id=uuid.uuid4(), egress_id="EG_1", status="active", kind="audio", started_by=None, started_at=None, created_at=None),
            SimpleNamespace(id=uuid.uuid4(), egress_id=None, status="starting", kind="audio", started_by=None, started_at=None, created_at=None),
        ]
        db = FakeDB(router=lambda s: FakeResult(rows=rows))
        lk = livekit()
        announce = AsyncMock()
        with patch.object(CR, "announce_recording", announce):
            stopped = await CR.stop_room_recording(db, _settings(), lk, r, reason="room_idle")
        self.assertEqual(stopped, 1)
        lk.stop_egress.assert_awaited_once_with("EG_1")
        self.assertEqual(rows[0].status, "stopping")
        self.assertEqual(rows[1].status, "starting", "an in-flight StartEgress is left for egress_ended")
        announce.assert_awaited_once()
        self.assertEqual(announce.await_args.kwargs["reason"], "room_idle")

    async def test_idle_stop_ignores_service_identities(self) -> None:
        r = room()
        db = FakeDB(router=lambda s: FakeResult(scalar=uuid.uuid4(), rows=[]))
        lk = livekit(["broadcast-x", "EG_1"])
        stop = AsyncMock()
        with patch.object(CR, "stop_room_recording", stop):
            await CR.stop_room_recording_if_idle(db, _settings(), lk, r, redis="R")
        stop.assert_awaited_once()
        self.assertEqual(stop.await_args.kwargs["redis"], "R")


class FilesAndRetention(IsolatedAsyncioTestCase):
    S3 = dict(
        recording_s3_endpoint="https://garage.test",
        recording_s3_bucket="stable",
        recording_s3_access_key="ak",
        recording_s3_secret_key="sk",
    )

    def _row(self, r, tmp: Path | None = None, **kw):
        base = dict(
            id=uuid.uuid4(), room_id=r.id, kind="audio", status="complete", storage_url=None,
            file_path=str(tmp) if tmp else None, retention_until=datetime.now(timezone.utc) - timedelta(days=1),
            legal_hold=False, handoff_status="delivered", egress_id="EG_1", livekit_room_name=r.livekit_room_name,
        )
        base.update(kw)
        return SimpleNamespace(**base)

    async def test_retention_query_excludes_legal_hold_and_future_rows(self) -> None:
        db = FakeDB(router=lambda s: FakeResult(rows=[]))
        await CR._sweep_retention(lambda: db, _settings())
        sql = stmt_sql(db.executed[0])
        self.assertIn("legal_hold", sql)
        self.assertIn("retention_until <", sql)
        self.assertIn("SKIP LOCKED", sql)

    async def test_expired_row_loses_its_object_and_local_file(self) -> None:
        import tempfile

        r = room()
        with tempfile.TemporaryDirectory() as d:
            local = Path(d) / "stable-call-x.ogg"
            local.write_bytes(b"abc")
            row = self._row(r, tmp=local, storage_url="https://garage.test/stable/stable-recordings/r/x.ogg")
            db = FakeDB(router=lambda s: FakeResult(rows=[row]))
            deleted: list[str] = []

            async def delete_object(settings, *, key):
                deleted.append(key)
                return {"ok": True}

            with patch.object(CR.recording_storage, "delete_object", delete_object):
                purged = await CR._sweep_retention(lambda: db, _settings(**self.S3))
            self.assertEqual(purged, 1)
            self.assertEqual(deleted, ["stable-recordings/r/x.ogg"])
            self.assertIsNone(row.storage_url)
            self.assertIsNone(row.file_path)
            self.assertFalse(local.exists())
            self.assertEqual(db.commits, 1)

    async def test_storage_delete_failure_keeps_the_pointer_for_the_next_sweep(self) -> None:
        r = room()
        row = self._row(r, storage_url="https://garage.test/stable/stable-recordings/r/x.ogg")

        async def delete_object(settings, *, key):
            return {"ok": False, "retryable": True, "detail": "HTTP 500"}

        with patch.object(CR.recording_storage, "delete_object", delete_object):
            outcome = await CR.purge_recording_files(_settings(**self.S3), row)
        self.assertEqual(outcome["storage"], "HTTP 500")
        self.assertIsNotNone(row.storage_url)

    async def test_foreign_storage_url_is_never_deleted(self) -> None:
        r = room()
        row = self._row(r, storage_url="https://elsewhere.test/other/x.ogg")
        delete_object = AsyncMock()
        with patch.object(CR.recording_storage, "delete_object", delete_object):
            outcome = await CR.purge_recording_files(_settings(**self.S3), row)
        delete_object.assert_not_awaited()
        self.assertIn("does not belong", outcome["storage"])

    async def test_local_file_freed_only_with_a_durable_copy_and_settled_handoff(self) -> None:
        import tempfile

        r = room()
        with tempfile.TemporaryDirectory() as d:
            local = Path(d) / "a.ogg"
            local.write_bytes(b"abc")
            row = self._row(r, tmp=local, storage_url="https://garage.test/stable/x.ogg", handoff_status="delivered")
            db = FakeDB(router=lambda s: FakeResult(rows=[row]))
            freed = await CR._sweep_local_files_after_delivery(lambda: db)
            self.assertEqual(freed, 1)
            self.assertFalse(local.exists())
            self.assertIsNone(row.file_path)
            # The query itself demands storage_url + terminal hand-off.
            sql = stmt_sql(db.executed[0])
            self.assertIn("storage_url IS NOT NULL", sql)
            self.assertIn("handoff_status IN", sql)

    async def test_maintenance_steps_fail_independently(self) -> None:
        calls: list[str] = []

        async def boom(*a, **k):
            calls.append("stale")
            raise RuntimeError("x")

        async def ok(*a, **k):
            calls.append("ok")

        with patch.object(CR, "_sweep_stale_rows", boom), patch.object(CR, "_sweep_retention", ok), patch.object(
            CR, "_sweep_local_files_after_delivery", ok
        ), patch.object(CR, "_sweep_composite_slots", ok):
            await CR.run_maintenance_sweep(lambda: FakeDB(), _settings(), None)
        self.assertEqual(calls, ["stale", "ok", "ok", "ok"])


class HandoffPipeline(IsolatedAsyncioTestCase):
    """Storage first, then Meeting-Ops, then the local file goes."""

    S3 = dict(
        recording_s3_endpoint="https://garage.test",
        recording_s3_bucket="stable",
        recording_s3_access_key="ak",
        recording_s3_secret_key="sk",
    )

    def _row(self, r, local: Path, **kw):
        base = dict(
            id=uuid.uuid4(), room_id=r.id, kind="composite", status="complete", storage_url=None,
            file_path=str(local), handoff_status="delivering", handoff_attempts=1, handoff_error=None,
            handoff_next_attempt_at=None, mo_session_id="sess-1", mo_upload_id=None, egress_id="EG_v",
            started_at=datetime.now(timezone.utc), created_at=datetime.now(timezone.utc),
            ended_at=datetime.now(timezone.utc),
        )
        base.update(kw)
        return SimpleNamespace(**base)

    async def test_storage_failure_holds_the_mo_attach_back_with_backoff(self) -> None:
        import tempfile

        r = room()
        with tempfile.TemporaryDirectory() as d:
            local = Path(d) / "call.mp4"
            local.write_bytes(b"mp4")
            row = self._row(r, local)
            db = FakeDB(objects={row.id: row})
            mo = AsyncMock()
            with patch.object(CR.recording_storage, "put_object", AsyncMock(return_value={"ok": False, "retryable": True, "detail": "HTTP 503"})), patch.object(
                CR, "upload_audio_to_meeting_ops", mo
            ):
                await CR._deliver_claimed_handoff(lambda: db, _settings(**self.S3), row.id)
            mo.assert_not_awaited()
            self.assertEqual(row.handoff_status, "pending")
            self.assertIn("storage upload", row.handoff_error)
            self.assertIsNotNone(row.handoff_next_attempt_at)
            self.assertTrue(local.exists())

    async def test_success_uploads_then_attaches_as_mp4_then_frees_the_local_file(self) -> None:
        import tempfile

        r = room()
        with tempfile.TemporaryDirectory() as d:
            local = Path(d) / "call.mp4"
            local.write_bytes(b"mp4")
            row = self._row(r, local)
            db = FakeDB(objects={row.id: row})
            put = AsyncMock(return_value={"ok": True, "url": "https://garage.test/stable/stable-recordings/r/x.mp4"})
            mo = AsyncMock(return_value={"ok": True, "upload_id": "job-9"})
            with patch.object(CR.recording_storage, "put_object", put), patch.object(CR, "upload_audio_to_meeting_ops", mo):
                await CR._deliver_claimed_handoff(lambda: db, _settings(**self.S3), row.id)
            self.assertEqual(put.await_args.kwargs["content_type"], "video/mp4")
            self.assertEqual(put.await_args.kwargs["key"], f"stable-recordings/{r.id}/{row.id}.mp4")
            self.assertEqual(mo.await_args.kwargs["content_type"], "video/mp4")
            self.assertEqual(mo.await_args.kwargs["target_session_id"], "sess-1")
            self.assertEqual(row.handoff_status, "delivered")
            self.assertEqual(row.mo_upload_id, "job-9")
            self.assertEqual(row.storage_url, "https://garage.test/stable/stable-recordings/r/x.mp4")
            self.assertIsNone(row.file_path)
            self.assertFalse(local.exists())

    async def test_without_storage_the_audio_lane_is_unchanged_and_keeps_its_file(self) -> None:
        import tempfile

        r = room()
        with tempfile.TemporaryDirectory() as d:
            local = Path(d) / "call.ogg"
            local.write_bytes(b"ogg")
            row = self._row(r, local, kind="audio", egress_id="EG_a")
            db = FakeDB(objects={row.id: row})
            put = AsyncMock()
            mo = AsyncMock(return_value={"ok": True, "upload_id": "job-1"})
            with patch.object(CR.recording_storage, "put_object", put), patch.object(CR, "upload_audio_to_meeting_ops", mo):
                await CR._deliver_claimed_handoff(lambda: db, _settings(), row.id)
            put.assert_not_awaited()
            self.assertEqual(mo.await_args.kwargs["content_type"], "audio/ogg")
            self.assertEqual(mo.await_args.kwargs["filename"], "call.ogg")
            self.assertEqual(row.handoff_status, "delivered")
            self.assertTrue(local.exists(), "no durable copy → the local file stays until retention")
            self.assertEqual(row.file_path, str(local))


class MeetingOpsAttachContentType(IsolatedAsyncioTestCase):
    async def test_start_call_carries_the_media_type(self) -> None:
        import tempfile

        seen: list[dict] = []

        class Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return None

            async def post(self, url, *, json=None, data=None, files=None, headers=None):
                seen.append({"url": url, "json": json, "files": files})
                req = httpx.Request("POST", url)
                if url.endswith("/start"):
                    return httpx.Response(200, json={"upload_id": "u", "chunk_size": 1024}, request=req)
                return httpx.Response(200, json={}, request=req)

        with tempfile.TemporaryDirectory() as d, patch.object(httpx, "AsyncClient", Client):
            f = Path(d) / "v.mp4"
            f.write_bytes(b"mp4data")
            out = await CR.upload_audio_to_meeting_ops(
                _settings(), file_path=f, target_session_id="s", filename="v.mp4", content_type="video/mp4"
            )
        self.assertTrue(out["ok"])
        self.assertEqual(seen[0]["json"]["content_type"], "video/mp4")
        self.assertEqual(seen[0]["json"]["action"], "attach")
        self.assertEqual(seen[1]["files"]["data"][2], "video/mp4")
        # default stays the original audio/ogg
        with tempfile.TemporaryDirectory() as d, patch.object(httpx, "AsyncClient", Client):
            f = Path(d) / "a.ogg"
            f.write_bytes(b"ogg")
            seen.clear()
            await CR.upload_audio_to_meeting_ops(_settings(), file_path=f, target_session_id="s", filename="a.ogg")
        self.assertEqual(seen[0]["json"]["content_type"], "audio/ogg")


class RoomState(IsolatedAsyncioTestCase):
    async def test_state_shape_idle_and_active(self) -> None:
        r = room(recording_policy="always", recording_kind="composite")
        db = FakeDB(router=lambda s: FakeResult(scalar=None))
        idle = await CR.room_recording_state(db, r)
        self.assertEqual(idle, {"active": False, "policy": "always", "kind": "composite", "started_by": None, "started_at": None, "recording_id": None})
        pid = uuid.uuid4()
        row = SimpleNamespace(id=uuid.uuid4(), kind="audio", started_by=pid, started_at=datetime.now(timezone.utc), created_at=None)
        db = FakeDB(router=lambda s: FakeResult(scalar=row), objects={pid: participant(id=pid, display_name="Aaron")})
        live = await CR.room_recording_state(db, r)
        self.assertTrue(live["active"])
        self.assertEqual(live["started_by"], {"id": str(pid), "display_name": "Aaron"})
        self.assertEqual(live["recording_id"], str(row.id))
