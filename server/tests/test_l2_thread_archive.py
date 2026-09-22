"""L2 — thread auto-archive (item 2): idle 14 d → is_archived, any new
message unarchives. Periodic task in the outbox-worker pattern.

* the sweep's UPDATE targets live THREADS only, measures idleness from the
  newest message (falling back to updated_at), stamps
  ``metadata.thread_archived_at`` and returns the ids it flipped;
* the safety-net UPDATE unarchives archived threads that got a message
  after the stamp; the immediate hook runs from the send path only when the
  room row it already fetched says "archived thread";
* both directions fan out ``thread_archived`` to thread + parent;
* the loop survives a failing pass; main.py starts and cancels it;
* PATCH is_archived on a thread stamps / clears the same key.
"""

from __future__ import annotations

import asyncio
import inspect
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.dialects import postgresql

from app.models.room import RoomType
from app.services import room_archive as RA

NOW = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)


def _compiled(stmt):
    return stmt.compile(dialect=postgresql.dialect())


def _sql(stmt) -> str:
    return str(_compiled(stmt)).replace("\n", " ")


class ArchiveStatements(unittest.TestCase):
    def test_idle_update_targets_live_threads_by_newest_message(self) -> None:
        stmt = RA.idle_threads_update(now=NOW, idle_days=14, batch=500)
        sql = _sql(stmt)
        self.assertTrue(sql.startswith("UPDATE rooms SET"))
        self.assertIs(_compiled(stmt).params["is_archived"], True)
        self.assertIn("thread.parent_room_id IS NOT NULL", sql)
        self.assertIn("thread.is_archived = false", sql)
        self.assertIn("max(messages.created_at)", sql)
        self.assertIn("messages.is_deleted = false", sql)
        self.assertIn("coalesce(", sql)
        self.assertIn("LIMIT", sql)
        self.assertIn("RETURNING rooms.id, rooms.parent_room_id", sql)
        params = _compiled(stmt).params
        self.assertIn(NOW - timedelta(days=14), params.values())
        stamp = next(v for v in params.values() if isinstance(v, dict))
        self.assertEqual(stamp[RA.THREAD_ARCHIVED_AT_KEY], NOW.isoformat())
        self.assertEqual(stamp[RA.THREAD_ARCHIVED_REASON_KEY], "idle")
        self.assertIn(500, params.values())

    def test_stale_update_compares_the_newest_message_to_the_stamp(self) -> None:
        stmt = RA.stale_archived_threads_update(batch=100)
        sql = _sql(stmt)
        self.assertTrue(sql.startswith("UPDATE rooms SET"))
        self.assertIs(_compiled(stmt).params["is_archived"], False)
        self.assertIn("thread.is_archived = true", sql)
        self.assertIn("thread.parent_room_id IS NOT NULL", sql)
        self.assertIn("thread.metadata ?", sql)  # has_key(thread_archived_at)
        self.assertIn(RA.THREAD_ARCHIVED_AT_KEY, _compiled(stmt).params.values())
        self.assertIn("TIMESTAMP WITH TIME ZONE", sql)
        self.assertIn("RETURNING rooms.id, rooms.parent_room_id", sql)

    def test_unarchive_one_targets_only_an_archived_thread(self) -> None:
        rid = uuid.uuid4()
        stmt = RA.unarchive_thread_update(rid)
        sql = _sql(stmt)
        self.assertIn("rooms.id = ", sql)
        self.assertIn("rooms.is_archived = true", sql)
        self.assertIn("rooms.parent_room_id IS NOT NULL", sql)
        self.assertIn("RETURNING", sql)
        self.assertIn(rid, _compiled(stmt).params.values())

    def test_default_idle_days_is_the_design_number(self) -> None:
        from app.config import Settings

        self.assertEqual(RA.THREAD_IDLE_DAYS_DEFAULT, 14)
        s = Settings()
        self.assertEqual(s.thread_auto_archive_idle_days, 14)
        self.assertTrue(s.thread_auto_archive_enabled)
        self.assertGreaterEqual(s.thread_auto_archive_interval_seconds, 60)


class ReturnedRowsTolerance(unittest.TestCase):
    def test_real_rows_are_pairs_and_mocks_are_ignored(self) -> None:
        a, b = uuid.uuid4(), uuid.uuid4()
        res = MagicMock()
        res.all.return_value = [(a, b), (None, b), "junk"]
        self.assertEqual(RA._returned_rows(res), [(a, b)])
        self.assertEqual(RA._returned_rows(MagicMock()), [])
        broken = MagicMock()
        broken.all.side_effect = RuntimeError("no result")
        self.assertEqual(RA._returned_rows(broken), [])


class SweepAndHook(IsolatedAsyncioTestCase):
    def _db(self, rows):
        db = AsyncMock()
        res = MagicMock()
        res.all.return_value = rows
        db.execute = AsyncMock(return_value=res)
        return db

    async def test_archive_pass_commits_and_fans_out_each_row(self) -> None:
        t1, p1, t2, p2 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        db = self._db([(t1, p1), (t2, p2)])
        with patch.object(RA, "_fanout", AsyncMock()) as fanout:
            n = await RA.archive_idle_threads(db, idle_days=14, batch=10, now=NOW)
        self.assertEqual(n, 2)
        db.commit.assert_awaited_once()
        self.assertEqual(fanout.await_count, 2)
        self.assertEqual(fanout.await_args_list[0].args, (t1, p1))
        self.assertEqual(fanout.await_args_list[0].kwargs, {"archived": True, "reason": "idle"})

    async def test_stale_pass_unarchives(self) -> None:
        t1, p1 = uuid.uuid4(), uuid.uuid4()
        db = self._db([(t1, p1)])
        with patch.object(RA, "_fanout", AsyncMock()) as fanout:
            n = await RA.unarchive_stale_threads(db, batch=10)
        self.assertEqual(n, 1)
        self.assertEqual(fanout.await_args.kwargs, {"archived": False, "reason": "message"})

    async def test_immediate_hook_flips_only_when_a_row_returns(self) -> None:
        t1, p1 = uuid.uuid4(), uuid.uuid4()
        db = self._db([(t1, p1)])
        with patch.object(RA, "_fanout", AsyncMock()) as fanout:
            self.assertTrue(await RA.unarchive_thread_on_message(db, t1))
        db.commit.assert_awaited_once()
        fanout.assert_awaited_once_with(t1, p1, archived=False, reason="message")

        db = self._db([])
        with patch.object(RA, "_fanout", AsyncMock()) as fanout:
            self.assertFalse(await RA.unarchive_thread_on_message(db, t1))
        db.commit.assert_not_awaited()
        fanout.assert_not_awaited()

    async def test_fanout_reaches_thread_and_parent_with_the_direction(self) -> None:
        t1, p1 = uuid.uuid4(), uuid.uuid4()
        with patch("app.api.messages._ws_broadcast_room", AsyncMock()) as ws:
            await RA._fanout(t1, p1, archived=True, reason="idle")
        self.assertEqual(ws.await_count, 2)
        targets = {c.args[1] for c in ws.await_args_list}
        self.assertEqual(targets, {t1, p1})
        envelope = ws.await_args_list[0].args[2]
        self.assertEqual(envelope["type"], "thread_archived")
        self.assertEqual(envelope["payload"], {"room_id": str(t1), "parent_room_id": str(p1), "is_archived": True, "reason": "idle"})
        # A parentless row (defensive) still reaches the thread.
        with patch("app.api.messages._ws_broadcast_room", AsyncMock()) as ws:
            await RA._fanout(t1, None, archived=False, reason="message")
        self.assertEqual(ws.await_count, 1)

    async def test_sweep_uses_one_session_for_both_halves(self) -> None:
        db = self._db([])
        factory = MagicMock()
        factory.return_value.__aenter__ = AsyncMock(return_value=db)
        factory.return_value.__aexit__ = AsyncMock(return_value=False)
        out = await RA.sweep_threads(factory, idle_days=14, batch=5, now=NOW)
        self.assertEqual(out, {"archived": 0, "unarchived": 0})
        self.assertEqual(db.execute.await_count, 2)


class SendPathHook(IsolatedAsyncioTestCase):
    """``MessageService.send_message`` decides off the room row it already
    fetches for the LiveKit broadcast — no extra query unless it must flip."""

    def _svc(self, room_row):
        from app.services.message_service import MessageService

        db = AsyncMock()
        db.add = MagicMock()
        membership = MagicMock()
        membership.scalar_one_or_none.return_value = SimpleNamespace(is_muted=False)
        members = MagicMock()
        members.all.return_value = []
        sender = MagicMock()
        sender.scalar_one_or_none.return_value = None
        room = MagicMock()
        room.one_or_none.return_value = room_row
        db.execute = AsyncMock(side_effect=[membership, members, sender, room])
        return MessageService(db=db, livekit=AsyncMock()), db

    # livekit_room_name is None in these rows: the LiveKit broadcast branch
    # needs a refreshed created_at the mocked session never supplies, and the
    # hook decision does not depend on it.

    async def test_archived_thread_row_triggers_the_hook(self) -> None:
        room_id, parent_id = uuid.uuid4(), uuid.uuid4()
        svc, db = self._svc((None, RoomType.AGENT_HUB, True, parent_id))
        with patch.object(RA, "unarchive_thread_on_message", AsyncMock(return_value=True)) as hook:
            await svc.send_message(room_id=room_id, sender_id=uuid.uuid4(), content="back again")
        hook.assert_awaited_once_with(db, room_id)
        # The widened select asks for the two extra columns.
        self.assertIn("rooms.is_archived, rooms.parent_room_id", _sql(db.execute.call_args_list[3].args[0]))

    async def test_live_rooms_and_narrow_rows_do_not(self) -> None:
        for row in ((None, RoomType.DM, False, None), (None, RoomType.DM, True, None), (None, RoomType.DM), None):
            with self.subTest(row=row):
                svc, _db = self._svc(row)
                with patch.object(RA, "unarchive_thread_on_message", AsyncMock()) as hook:
                    await svc.send_message(room_id=uuid.uuid4(), sender_id=uuid.uuid4(), content="hello")
                hook.assert_not_awaited()


class LoopAndWiring(IsolatedAsyncioTestCase):
    async def test_a_failing_pass_is_logged_and_the_loop_goes_on(self) -> None:
        settings = SimpleNamespace(thread_auto_archive_interval_seconds=600, thread_auto_archive_idle_days=14, thread_auto_archive_batch=5)
        sweep = AsyncMock(side_effect=[RuntimeError("db blip"), {"archived": 0, "unarchived": 0}, asyncio.CancelledError()])
        with patch.object(RA, "sweep_threads", sweep), patch.object(RA.asyncio, "sleep", AsyncMock()) as sleep:
            with self.assertRaises(asyncio.CancelledError):
                await RA.run_thread_auto_archive(MagicMock(), settings)
        self.assertEqual(sweep.await_count, 3)
        self.assertEqual(sweep.await_args.kwargs, {"idle_days": 14, "batch": 5})
        self.assertEqual(sleep.await_args.args, (600.0,))

    def test_main_starts_and_cancels_the_task_like_the_other_workers(self) -> None:
        import app.main as M

        src = inspect.getsource(M.lifespan)
        self.assertIn("run_thread_auto_archive(session_factory, settings)", src)
        self.assertIn("settings.thread_auto_archive_enabled", src)
        self.assertIn("thread_archive_task.cancel()", src)
        self.assertIn("app.state.thread_archive_task", src)

    def test_ws_event_names_are_registered_additively(self) -> None:
        from app.ws import events

        self.assertEqual(events.THREAD_ARCHIVED, RA.THREAD_ARCHIVED_EVENT)
        self.assertEqual(events.ROOM_CONVERTED, "room_converted")
        self.assertEqual(events.ROOM_INVITED, "room_invited")
        self.assertNotIn(events.THREAD_ARCHIVED, events.CONTRACT_EVENTS)  # L0's frozen tuple


class ManualArchiveStamp(IsolatedAsyncioTestCase):
    async def test_patch_is_archived_on_a_thread_stamps_and_clears(self) -> None:
        from app.services.room_service import RoomService

        room = SimpleNamespace(
            id=uuid.uuid4(), room_type=RoomType.CHANNEL, parent_room_id=uuid.uuid4(), is_archived=False,
            display_name="t", description=None, metadata_={"thread": {}}, visibility="public",
        )
        db = AsyncMock()
        res = MagicMock()
        res.scalar_one_or_none.return_value = room
        db.execute = AsyncMock(return_value=res)
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        svc._require_role = AsyncMock()
        await svc.update_room(room_id=room.id, participant_id=uuid.uuid4(), is_archived=True)
        self.assertTrue(room.is_archived)
        self.assertIn(RA.THREAD_ARCHIVED_AT_KEY, room.metadata_)
        self.assertEqual(room.metadata_[RA.THREAD_ARCHIVED_REASON_KEY], "manual")
        self.assertIn("thread", room.metadata_)  # other keys kept
        await svc.update_room(room_id=room.id, participant_id=uuid.uuid4(), is_archived=False)
        self.assertFalse(room.is_archived)
        self.assertNotIn(RA.THREAD_ARCHIVED_AT_KEY, room.metadata_)

    async def test_top_level_rooms_are_not_stamped(self) -> None:
        from app.services.room_service import RoomService

        room = SimpleNamespace(
            id=uuid.uuid4(), room_type=RoomType.CHANNEL, parent_room_id=None, is_archived=False,
            display_name="c", description=None, metadata_={}, visibility="public",
        )
        db = AsyncMock()
        res = MagicMock()
        res.scalar_one_or_none.return_value = room
        db.execute = AsyncMock(return_value=res)
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        svc._require_role = AsyncMock()
        await svc.update_room(room_id=room.id, participant_id=uuid.uuid4(), is_archived=True)
        self.assertEqual(room.metadata_, {})


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
