"""L4 — the rolling room summary job, against a FAKE model gateway.

Off by default; env-named settings; prompt carries the previous summary and
the delta; the stored summary has text/watermark/updated_at; the lease
de-duplicates; the worker idles when unconfigured; nothing here ever logs
or returns the gateway URL or key."""

from __future__ import annotations

import asyncio
import json
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from app.models.message import ContentType
from app.models.participant import ParticipantType
from app.services import context_summary as cs

T0 = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)
FAKE_KEY = "sk-fake-summary-key-for-tests"


def _settings(**overrides):
    base = dict(
        context_summary_enabled=True,
        context_summary_base_url="http://fake-gateway/v1",
        context_summary_api_key=FAKE_KEY,
        context_summary_model="qwen3.6-35b-long-batch",
        context_summary_every_messages=50,
        context_summary_poll_seconds=60.0,
        context_summary_lookback_days=30,
        context_summary_timeout_seconds=30.0,
        context_summary_max_chars=2400,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _participant(name, kind=ParticipantType.HUMAN):
    return SimpleNamespace(id=uuid.uuid4(), display_name=name, username=name.lower(), participant_type=kind)


def _msg(text, *, sender, at=0, metadata=None, parent=None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        created_at=T0 + timedelta(seconds=at),
        content=text,
        content_type=ContentType.TEXT,
        metadata_=metadata or {},
        parent_id=parent.id if parent else None,
        parent=parent,
        sender=sender,
    )


def _result(value, *, rows=None):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    res.scalar_one.return_value = value
    res.scalars.return_value.all.return_value = value
    res.all.return_value = rows if rows is not None else value
    return res


class FakeGateway:
    """An OpenAI-compatible /chat/completions that records what it was asked."""

    def __init__(self, reply="SUMMARY TEXT", status=200):
        self.reply = reply
        self.status = status
        self.requests: list[dict] = []
        self.headers: list[dict] = []
        self.urls: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.urls.append(str(request.url))
        self.headers.append(dict(request.headers))
        self.requests.append(json.loads(request.content))
        if self.status != 200:
            return httpx.Response(self.status, text="upstream says no")
        return httpx.Response(
            200, json={"choices": [{"message": {"role": "assistant", "content": self.reply}}]}
        )

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler), base_url="http://fake-gateway/v1")


class ConfigAndPureHelpers(unittest.TestCase):
    def test_disabled_by_default_and_names_the_switch(self) -> None:
        from app.config import Settings

        with patch.dict(os.environ, {}, clear=False):
            for name in list(os.environ):
                if name.startswith("CONTEXT_SUMMARY_"):
                    os.environ.pop(name)
            cfg = cs.summary_config(Settings(_env_file=None))
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.model, "qwen3.6-35b-long-batch")
        self.assertIn("CONTEXT_SUMMARY_ENABLED", cs.config_error(cfg))

    def test_env_names_reach_the_settings(self) -> None:
        from app.config import Settings

        env = {
            "CONTEXT_SUMMARY_ENABLED": "true",
            "CONTEXT_SUMMARY_BASE_URL": "http://gw.local/v1/",
            "CONTEXT_SUMMARY_API_KEY": "sk-env-test",
            "CONTEXT_SUMMARY_MODEL": "some-lane",
            "CONTEXT_SUMMARY_EVERY_MESSAGES": "25",
        }
        with patch.dict(os.environ, env, clear=False):
            cfg = cs.summary_config(Settings(_env_file=None))
        self.assertTrue(cfg.enabled)
        self.assertEqual(cfg.base_url, "http://gw.local/v1")  # trailing slash stripped
        self.assertEqual(cfg.api_key, "sk-env-test")
        self.assertEqual(cfg.model, "some-lane")
        self.assertEqual(cfg.every_messages, 25)
        self.assertIsNone(cs.config_error(cfg))

    def test_config_error_names_missing_settings_without_values(self) -> None:
        err = cs.config_error(cs.summary_config(_settings(context_summary_base_url="")))
        self.assertIn("CONTEXT_SUMMARY_BASE_URL", err)
        err = cs.config_error(cs.summary_config(_settings(context_summary_api_key="")))
        self.assertIn("CONTEXT_SUMMARY_API_KEY", err)
        self.assertNotIn(FAKE_KEY, err)

    def test_strip_thinking_and_cap(self) -> None:
        self.assertEqual(cs.strip_thinking("<think>hmm\nhm</think>\nThe summary."), "The summary.")
        self.assertEqual(cs.cap_text("abcdef", 4), "abc…")
        self.assertEqual(cs.cap_text("abc", 4), "abc")

    def test_render_lines_marks_voice_and_replies_and_skips_placeholders(self) -> None:
        aaron = _participant("Aaron")
        rook = _participant("Rook", ParticipantType.AGENT)
        first = _msg("venue is the sunroom", sender=aaron, at=0)
        lines = cs.render_lines(
            [
                first,
                _msg("noted", sender=rook, at=1, parent=first),
                _msg("rook, what's next", sender=aaron, at=2, metadata={"via": "voice"}),
                _msg("…", sender=rook, at=3),
                _msg("half", sender=rook, at=4, metadata={"stopped": True}),
            ]
        )
        self.assertEqual(
            lines,
            [
                "[09-21 12:00] Aaron: venue is the sunroom",
                "[09-21 12:00] Rook: ↳ reply to Aaron: noted",
                "[09-21 12:00] Aaron (voice): rook, what's next",
            ],
        )

    def test_render_lines_drops_oldest_when_the_block_overflows(self) -> None:
        aaron = _participant("Aaron")
        rows = [_msg(f"{i}:" + "x" * 1400, sender=aaron, at=i) for i in range(60)]
        lines = cs.render_lines(rows)
        self.assertLessEqual(sum(len(line) + 1 for line in lines), cs.MAX_DELTA_CHARS)
        self.assertTrue(lines[-1].startswith("[09-21 12:00] Aaron: 59:"))

    def test_prompt_carries_previous_summary_and_delta(self) -> None:
        messages = cs.build_summary_messages(
            room_name="build-in-public-live",
            previous="Earlier: venue = sunroom.",
            lines=["[09-21 12:00] Aaron: mic check"],
            max_chars=2400,
        )
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertIn("Earlier: venue = sunroom.", messages[1]["content"])
        self.assertIn("Aaron: mic check", messages[1]["content"])
        self.assertIn("at most 400 words", messages[0]["content"])
        none = cs.build_summary_messages(room_name="r", previous=None, lines=["l"], max_chars=600)
        self.assertIn("(none yet)", none[1]["content"])


class RequestSummaryAgainstFakeGateway(IsolatedAsyncioTestCase):
    async def test_posts_bearer_and_model_and_returns_text(self) -> None:
        gw = FakeGateway(reply="<think>…</think>\nAaron set the venue to the sunroom.")
        cfg = cs.summary_config(_settings())
        async with gw.client() as http:
            text = await cs.request_summary(cfg, [{"role": "user", "content": "x"}], http=http)
        self.assertEqual(text, "Aaron set the venue to the sunroom.")
        self.assertEqual(gw.headers[0]["authorization"], f"Bearer {FAKE_KEY}")
        self.assertEqual(gw.requests[0]["model"], "qwen3.6-35b-long-batch")
        self.assertTrue(gw.urls[0].endswith("/v1/chat/completions"))

    async def test_http_error_and_empty_completion_raise(self) -> None:
        cfg = cs.summary_config(_settings())
        async with FakeGateway(status=502).client() as http:
            with self.assertRaises(cs.SummaryError) as ctx:
                await cs.request_summary(cfg, [], http=http)
        self.assertIn("HTTP 502", str(ctx.exception))
        self.assertNotIn(FAKE_KEY, str(ctx.exception))
        async with FakeGateway(reply="<think>only thoughts</think>").client() as http:
            with self.assertRaises(cs.SummaryError):
                await cs.request_summary(cfg, [], http=http)

    async def test_transport_failure_is_a_summary_error_without_the_url(self) -> None:
        def boom(request):
            raise httpx.ConnectError("refused", request=request)

        cfg = cs.summary_config(_settings())
        async with httpx.AsyncClient(transport=httpx.MockTransport(boom), base_url="http://fake-gateway/v1") as http:
            with self.assertRaises(cs.SummaryError) as ctx:
                await cs.request_summary(cfg, [], http=http)
        self.assertNotIn("fake-gateway", str(ctx.exception))


def _session_factory(*sessions):
    """A session_factory whose successive ``async with`` blocks yield the
    given mock sessions in order."""
    factory = MagicMock()
    ctxs = []
    for db in sessions:
        ctx = MagicMock()
        ctx.__aenter__ = AsyncMock(return_value=db)
        ctx.__aexit__ = AsyncMock(return_value=False)
        ctxs.append(ctx)
    factory.side_effect = ctxs
    return factory


class SummarizeRoom(IsolatedAsyncioTestCase):
    async def test_writes_text_watermark_and_updated_at_from_the_delta(self) -> None:
        aaron = _participant("Aaron")
        room_id = uuid.uuid4()
        prev = {
            "text": "Earlier: venue = sunroom.",
            "watermark": str(uuid.uuid4()),
            "watermark_ts": (T0 - timedelta(hours=1)).isoformat(),
        }
        room_read = SimpleNamespace(id=room_id, name="build-in-public-live", metadata_={"context_summary": prev})
        delta = [_msg(f"line {i}", sender=aaron, at=i) for i in range(3)]
        db1 = AsyncMock()
        db1.execute = AsyncMock(side_effect=[_result(room_read), _result(list(reversed(delta)))])
        room_write = SimpleNamespace(id=room_id, name="build-in-public-live", metadata_={"context_summary": prev, "other": 1})
        db2 = AsyncMock()
        db2.execute = AsyncMock(side_effect=[_result(room_write)])
        gw = FakeGateway(reply="Venue = sunroom; then three lines happened.")

        async with gw.client() as http:
            out = await cs.summarize_room(_session_factory(db1, db2), _settings(), room_id, http=http, force=True)

        self.assertEqual(out["text"], "Venue = sunroom; then three lines happened.")
        self.assertEqual(out["watermark"], str(delta[-1].id))
        self.assertEqual(out["watermark_ts"], delta[-1].created_at.isoformat())
        self.assertEqual(out["message_count"], 3)
        self.assertIn("updated_at", out)
        stored = room_write.metadata_["context_summary"]
        self.assertEqual(stored, out)
        self.assertEqual(room_write.metadata_["other"], 1)  # other metadata kept
        db2.commit.assert_awaited_once()
        # The prompt carried the previous summary and the delta lines.
        prompt = gw.requests[0]["messages"][1]["content"]
        self.assertIn("Earlier: venue = sunroom.", prompt)
        self.assertIn("Aaron: line 0", prompt)
        self.assertIn("Aaron: line 2", prompt)
        # The delta query started after the previous watermark: one room
        # read + one delta read in the first session.
        self.assertEqual(db1.execute.await_count, 2)

    async def test_nothing_new_leaves_the_summary_unchanged(self) -> None:
        room_id = uuid.uuid4()
        prev = {"text": "old", "watermark": "w", "watermark_ts": T0.isoformat()}
        db1 = AsyncMock()
        db1.execute = AsyncMock(side_effect=[_result(SimpleNamespace(id=room_id, name="r", metadata_={"context_summary": prev})), _result([])])
        gw = FakeGateway()
        async with gw.client() as http:
            out = await cs.summarize_room(_session_factory(db1), _settings(), room_id, http=http, force=True)
        self.assertTrue(out["unchanged"])
        self.assertEqual(out["text"], "old")
        self.assertEqual(gw.requests, [])

    async def test_below_threshold_without_force_does_not_call_the_model(self) -> None:
        aaron = _participant("Aaron")
        room_id = uuid.uuid4()
        db1 = AsyncMock()
        db1.execute = AsyncMock(side_effect=[_result(SimpleNamespace(id=room_id, name="r", metadata_={})), _result([_msg("one", sender=aaron)])])
        gw = FakeGateway()
        async with gw.client() as http:
            out = await cs.summarize_room(_session_factory(db1), _settings(), room_id, http=http)
        self.assertTrue(out["unchanged"])
        self.assertEqual(gw.requests, [])

    async def test_disabled_raises_before_touching_the_database(self) -> None:
        factory = MagicMock()
        with self.assertRaises(cs.SummaryError) as ctx:
            await cs.summarize_room(factory, _settings(context_summary_enabled=False), uuid.uuid4())
        self.assertIn("CONTEXT_SUMMARY_ENABLED", str(ctx.exception))
        factory.assert_not_called()

    async def test_lease_held_elsewhere_returns_none_and_release_only_when_held(self) -> None:
        redis = AsyncMock()
        redis.set = AsyncMock(return_value=False)
        factory = MagicMock()
        out = await cs.summarize_room(factory, _settings(), uuid.uuid4(), redis=redis, force=True)
        self.assertIsNone(out)
        factory.assert_not_called()
        redis.delete.assert_not_awaited()

    async def test_lease_is_taken_nx_and_released_after_the_run(self) -> None:
        room_id = uuid.uuid4()
        redis = AsyncMock()
        redis.set = AsyncMock(return_value=True)
        db1 = AsyncMock()
        db1.execute = AsyncMock(side_effect=[_result(SimpleNamespace(id=room_id, name="r", metadata_={})), _result([])])
        out = await cs.summarize_room(_session_factory(db1), _settings(), room_id, redis=redis, force=True)
        self.assertTrue(out["unchanged"])
        self.assertEqual(redis.set.await_args.kwargs.get("nx"), True)
        self.assertEqual(redis.set.await_args.args[0], f"{cs.LEASE_PREFIX}{room_id}")
        redis.delete.assert_awaited_once_with(f"{cs.LEASE_PREFIX}{room_id}")

    async def test_gateway_failure_surfaces_as_summary_error_and_writes_nothing(self) -> None:
        aaron = _participant("Aaron")
        room_id = uuid.uuid4()
        room = SimpleNamespace(id=room_id, name="r", metadata_={})
        db1 = AsyncMock()
        db1.execute = AsyncMock(side_effect=[_result(room), _result([_msg("x", sender=aaron)])])
        db2 = AsyncMock()
        async with FakeGateway(status=500).client() as http:
            with self.assertRaises(cs.SummaryError):
                await cs.summarize_room(_session_factory(db1, db2), _settings(), room_id, http=http, force=True)
        db2.commit.assert_not_awaited()
        self.assertEqual(room.metadata_, {})


class FindDueRooms(IsolatedAsyncioTestCase):
    async def test_threshold_since_watermark(self) -> None:
        never = uuid.uuid4()   # no summary yet, 60 in lookback -> due
        quiet = uuid.uuid4()   # summary + 12 since -> not due
        busy = uuid.uuid4()    # summary + 51 since -> due
        wm = (T0 - timedelta(days=1)).isoformat()
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[
                _result(None, rows=[(never, 60), (quiet, 70), (busy, 80)]),
                _result({}),                                      # never: metadata
                _result({"context_summary": {"text": "s", "watermark_ts": wm}}),  # quiet
                _result(12),                                      # quiet: count since
                _result({"context_summary": {"text": "s", "watermark_ts": wm}}),  # busy
                _result(51),                                      # busy: count since
            ]
        )
        due = await cs.find_due_rooms(db, threshold=50, lookback_days=30)
        self.assertEqual(due, [never, busy])


class Worker(IsolatedAsyncioTestCase):
    async def test_idles_out_immediately_when_disabled(self) -> None:
        factory = MagicMock()
        await asyncio.wait_for(
            cs.run_context_summary_worker(factory, _settings(context_summary_enabled=False)), timeout=2
        )
        factory.assert_not_called()

    async def test_one_sweep_summarizes_each_due_room(self) -> None:
        room_a, room_b = uuid.uuid4(), uuid.uuid4()
        db = AsyncMock()
        with patch.object(cs, "find_due_rooms", new=AsyncMock(return_value=[room_a, room_b])), patch.object(
            cs, "summarize_room", new=AsyncMock(side_effect=[{"text": "a"}, cs.SummaryError("boom")])
        ) as summarize, patch.object(cs.asyncio, "sleep", new=AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await cs.run_context_summary_worker(_session_factory(db), _settings(), redis=None)
        self.assertEqual([c.args[2] for c in summarize.await_args_list], [room_a, room_b])
