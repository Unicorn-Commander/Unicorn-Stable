"""L4 — the context builder hands an agent the WHOLE room: replies inline,
voice lines marked, abandoned placeholders dropped, and the rolling summary
prepended only when it adds something the window does not show."""

from __future__ import annotations

import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock

from app.models.message import ContentType
from app.models.participant import ParticipantType
from app.services.context_builder import (
    MAX_SUMMARY_CHARS,
    build_context,
    entry_from_message,
    estimate_tokens,
    format_entry_line,
    is_abandoned,
    summary_applies,
    summary_text_of,
)

T0 = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)


def _participant(name: str, kind: ParticipantType = ParticipantType.HUMAN, pid=None):
    return SimpleNamespace(
        id=pid or uuid.uuid4(), display_name=name, username=name.lower(), participant_type=kind
    )


def _msg(
    text: str,
    *,
    sender=None,
    at: int = 0,
    parent=None,
    metadata=None,
    content_type=ContentType.TEXT,
    mid=None,
):
    return SimpleNamespace(
        id=mid or uuid.uuid4(),
        created_at=T0 + timedelta(seconds=at),
        content=text,
        content_type=content_type,
        metadata_=metadata or {},
        parent_id=parent.id if parent is not None else None,
        parent=parent,
        sender=sender,
    )


def _result(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    res.scalars.return_value.all.return_value = value
    return res


def _db(rows, *, depth=None, meta=None, since_ts=None, for_participant=False, since=False):
    """A session whose execute sequence matches build_context's query order:
    [since lookup] → rows (newest first) → [context_depth] → room metadata."""
    seq = []
    if since:
        seq.append(_result(since_ts))
    seq.append(_result(list(sorted(rows, key=lambda m: m.created_at, reverse=True))))
    if for_participant:
        seq.append(_result(depth))
    seq.append(_result(meta))
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=seq)
    return db


class EntryShape(unittest.TestCase):
    def test_reply_text_carries_the_thread_author(self) -> None:
        aaron = _participant("Aaron")
        rook = _participant("Rook", ParticipantType.AGENT)
        parent = _msg("plan for tonight?", sender=aaron)
        reply = _msg("three segments", sender=rook, parent=parent, at=5)
        entry = entry_from_message(reply)
        self.assertEqual(entry["kind"], "reply")
        self.assertEqual(entry["text"], "↳ reply to Aaron: three segments")
        self.assertEqual(entry["parent_id"], parent.id)
        # Nav v3 fix lane 4: the author's server identity rides along as data.
        self.assertEqual(
            entry["sender"],
            {"id": rook.id, "name": "Rook", "username": "rook", "participant_type": "agent", "kind": "agent"},
        )

    def test_reply_without_loaded_parent_still_marks_the_thread(self) -> None:
        reply = _msg("ok", sender=_participant("Aaron"))
        reply.parent_id = uuid.uuid4()
        reply.parent = None
        self.assertEqual(entry_from_message(reply)["text"], "↳ reply to thread: ok")

    def test_voice_line_is_a_voice_entry_with_its_speaker(self) -> None:
        entry = entry_from_message(
            _msg("hey rook, what's next", sender=_participant("Aaron"), metadata={"via": "voice"})
        )
        self.assertEqual(entry["kind"], "voice")
        self.assertEqual(format_entry_line(entry), "Aaron (voice): hey rook, what's next")

    def test_system_line_without_sender(self) -> None:
        entry = entry_from_message(_msg("Aaron started a call", content_type=ContentType.SYSTEM))
        self.assertEqual(entry["kind"], "system")
        self.assertEqual(entry["sender"]["kind"], "system")
        self.assertEqual(format_entry_line(entry), "[system] Aaron started a call")

    def test_plain_line(self) -> None:
        entry = entry_from_message(_msg("hello", sender=_participant("Shafen")))
        self.assertEqual(format_entry_line(entry), "Shafen: hello")

    def test_abandoned(self) -> None:
        self.assertTrue(is_abandoned(_msg("…")))
        self.assertTrue(is_abandoned(_msg("   ")))
        self.assertTrue(is_abandoned(_msg("partial", metadata={"stopped": True})))
        self.assertFalse(is_abandoned(_msg("real")))

    def test_summary_text_is_capped(self) -> None:
        long = "x" * (MAX_SUMMARY_CHARS + 500)
        capped = summary_text_of({"context_summary": {"text": long}})
        self.assertEqual(len(capped), MAX_SUMMARY_CHARS)
        self.assertTrue(capped.endswith("…"))
        self.assertIsNone(summary_text_of({"context_summary": {"text": "   "}}))
        self.assertIsNone(summary_text_of(None))


class SummaryRule(unittest.TestCase):
    def _entries(self, *offsets: int) -> list[dict]:
        return [
            {"id": uuid.uuid4(), "ts": T0 + timedelta(seconds=o), "sender": {}, "kind": "message", "text": "m"}
            for o in offsets
        ]

    def test_watermark_before_window_applies(self) -> None:
        cs = {"text": "earlier", "watermark_ts": (T0 - timedelta(hours=1)).isoformat()}
        self.assertTrue(summary_applies(cs, self._entries(0, 10), truncated=False))

    def test_watermark_inside_untruncated_window_does_not_apply(self) -> None:
        cs = {"text": "earlier", "watermark_ts": (T0 + timedelta(seconds=5)).isoformat()}
        self.assertFalse(summary_applies(cs, self._entries(0, 10), truncated=False))

    def test_truncated_window_always_applies(self) -> None:
        cs = {"text": "earlier", "watermark_ts": (T0 + timedelta(seconds=5)).isoformat()}
        self.assertTrue(summary_applies(cs, self._entries(0, 10), truncated=True))

    def test_empty_window_applies_and_floor_never_does(self) -> None:
        cs = {"text": "earlier", "watermark_ts": T0.isoformat()}
        self.assertTrue(summary_applies(cs, [], truncated=False))
        self.assertFalse(summary_applies(cs, [], truncated=True, floored=True))

    def test_id_fallback_when_no_timestamp(self) -> None:
        entries = self._entries(0, 10)
        inside = {"text": "s", "watermark": str(entries[0]["id"])}
        outside = {"text": "s", "watermark": str(uuid.uuid4())}
        self.assertFalse(summary_applies(inside, entries, truncated=False))
        self.assertTrue(summary_applies(outside, entries, truncated=False))

    def test_blank_summary_never_applies(self) -> None:
        self.assertFalse(summary_applies({"text": " "}, [], truncated=False))
        self.assertFalse(summary_applies(None, [], truncated=False))


class BuildContext(IsolatedAsyncioTestCase):
    async def test_replies_and_voice_lines_are_in_the_stream_oldest_first(self) -> None:
        aaron = _participant("Aaron")
        rook = _participant("Rook", ParticipantType.AGENT)
        first = _msg("first thing: the venue is the sunroom", sender=aaron, at=0)
        reply = _msg("noted", sender=rook, parent=first, at=1)
        voice = _msg("rook, what's the venue", sender=aaron, at=2, metadata={"via": "voice"})
        stopped = _msg("half an ans", sender=rook, at=3, metadata={"stopped": True})
        placeholder = _msg("…", sender=rook, at=4)
        trigger = _msg("@rook what was the first thing?", sender=aaron, at=5)
        db = _db([trigger, placeholder, stopped, voice, reply, first], meta={})

        ctx = await build_context(db, room_id=uuid.uuid4())

        self.assertEqual(
            [e["kind"] for e in ctx["entries"]], ["message", "reply", "voice", "message"]
        )
        self.assertEqual(ctx["entries"][1]["text"], "↳ reply to Aaron: noted")
        self.assertEqual(ctx["entries"][0]["ts"], first.created_at)
        self.assertEqual(ctx["watermark"], trigger.id)
        self.assertIsNone(ctx["summary"])
        self.assertFalse(ctx["truncated"])

    async def test_summary_prepended_when_its_watermark_precedes_the_window(self) -> None:
        aaron = _participant("Aaron")
        rows = [_msg(f"m{i}", sender=aaron, at=i) for i in range(3)]
        meta = {
            "context_summary": {
                "text": "Earlier: the venue is the sunroom.",
                "watermark": str(uuid.uuid4()),
                "watermark_ts": (T0 - timedelta(minutes=10)).isoformat(),
            }
        }
        ctx = await build_context(_db(rows, meta=meta), room_id=uuid.uuid4())
        self.assertEqual(ctx["summary"], "Earlier: the venue is the sunroom.")
        # The summary's tokens are charged against the budget.
        entry_tokens = sum(estimate_tokens(e["text"]) + 4 for e in ctx["entries"])
        self.assertEqual(ctx["used_tokens"], entry_tokens + estimate_tokens(ctx["summary"]))

    async def test_summary_omitted_when_the_window_already_covers_it(self) -> None:
        aaron = _participant("Aaron")
        rows = [_msg(f"m{i}", sender=aaron, at=i) for i in range(3)]
        meta = {
            "context_summary": {
                "text": "covers m0..m1",
                "watermark": str(rows[1].id),
                "watermark_ts": rows[1].created_at.isoformat(),
            }
        }
        ctx = await build_context(_db(rows, meta=meta), room_id=uuid.uuid4())
        self.assertIsNone(ctx["summary"])
        self.assertEqual(len(ctx["entries"]), 3)

    async def test_summary_prepended_when_budget_truncates_the_window(self) -> None:
        aaron = _participant("Aaron")
        rows = [_msg("x" * 400, sender=aaron, at=i) for i in range(20)]
        meta = {
            "context_summary": {
                "text": "long room so far",
                "watermark": str(rows[-1].id),
                "watermark_ts": rows[-1].created_at.isoformat(),
            }
        }
        ctx = await build_context(_db(rows, meta=meta), room_id=uuid.uuid4(), budget_tokens=600)
        self.assertTrue(ctx["truncated"])
        self.assertEqual(ctx["summary"], "long room so far")
        self.assertLessEqual(ctx["used_tokens"], 600)
        # Newest lines are the ones kept.
        self.assertEqual(ctx["entries"][-1]["id"], rows[-1].id)

    async def test_context_depth_of_the_participant_caps_entries(self) -> None:
        aaron = _participant("Aaron")
        rows = [_msg(f"m{i}", sender=aaron, at=i) for i in range(6)]
        db = _db(rows, depth=2, meta={}, for_participant=True)
        ctx = await build_context(db, room_id=uuid.uuid4(), for_participant_id=uuid.uuid4())
        self.assertEqual([e["text"] for e in ctx["entries"]], ["m4", "m5"])
        self.assertTrue(ctx["truncated"])

    async def test_delta_since_a_message_id(self) -> None:
        aaron = _participant("Aaron")
        rows = [_msg(f"m{i}", sender=aaron, at=i) for i in range(4)]
        db = _db(rows[2:], meta={}, since=True, since_ts=rows[1].created_at)
        ctx = await build_context(db, room_id=uuid.uuid4(), since_message_id=rows[1].id)
        self.assertEqual([e["text"] for e in ctx["entries"]], ["m2", "m3"])
        # The since lookup ran first, then the window query carried the filter.
        self.assertEqual(db.execute.await_count, 3)

    async def test_history_floor_suppresses_the_summary(self) -> None:
        aaron = _participant("Aaron")
        rows = [_msg("m", sender=aaron, at=0)]
        meta = {"context_summary": {"text": "before the floor", "watermark_ts": (T0 - timedelta(days=1)).isoformat()}}
        ctx = await build_context(
            _db(rows, meta=meta), room_id=uuid.uuid4(), not_before=T0 - timedelta(minutes=1)
        )
        self.assertIsNone(ctx["summary"])
