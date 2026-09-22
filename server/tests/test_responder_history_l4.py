"""L4 — the Brigade responder reads the room through the context builder.

Role assignment is unchanged (assistant iff the sender is the agent); what
changed is the window: the builder's budgeted stream instead of the last ten
top-level messages, so replies, voice lines and a rolling summary reach the
agent. The trigger line stays verbatim because ``_call_brigade`` ships it as
the ``message`` wire field."""

from __future__ import annotations

import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from app.services import agent_chat_responder as responder

T0 = datetime(2026, 9, 21, tzinfo=timezone.utc)
AGENT = uuid.uuid4()
AARON = uuid.uuid4()
SHAFEN = uuid.uuid4()


def _entry(text, *, sender_id, name, kind="message", at=0, sender_kind="human", mid=None):
    return {
        "id": mid or uuid.uuid4(),
        "ts": T0 + timedelta(seconds=at),
        "sender": {"id": sender_id, "name": name, "kind": sender_kind},
        "kind": kind,
        "text": text,
        "parent_id": None,
    }


def _ctx(entries, summary=None):
    return {
        "room_id": uuid.uuid4(),
        "budget_tokens": 6000,
        "used_tokens": 10,
        "truncated": False,
        "watermark": entries[-1]["id"] if entries else None,
        "summary": summary,
        "entries": entries,
    }


class HistoryMapping(unittest.TestCase):
    def test_assistant_iff_sender_is_the_agent_and_dm_stays_bare(self) -> None:
        trigger = uuid.uuid4()
        entries = [
            _entry("hello", sender_id=AARON, name="Aaron", at=0),
            _entry("hi Aaron", sender_id=AGENT, name="Rook", sender_kind="agent", at=1),
            _entry("@rook plan?", sender_id=AARON, name="Aaron", at=2, mid=trigger),
        ]
        out = responder.history_from_context(
            _ctx(entries), agent_participant_id=AGENT, trigger_message_id=trigger
        )
        self.assertEqual(
            out,
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hi Aaron"},
                {"role": "user", "content": "@rook plan?"},
            ],
        )

    def test_multi_party_window_attributes_the_others_but_not_the_trigger(self) -> None:
        trigger = uuid.uuid4()
        entries = [
            _entry("venue is the sunroom", sender_id=AARON, name="Aaron", at=0),
            _entry("I can bring the mic", sender_id=SHAFEN, name="Shafen", at=1),
            _entry("noted", sender_id=AGENT, name="Rook", sender_kind="agent", at=2),
            _entry("@rook where?", sender_id=AARON, name="Aaron", at=3, mid=trigger),
        ]
        out = responder.history_from_context(
            _ctx(entries), agent_participant_id=AGENT, trigger_message_id=trigger
        )
        self.assertEqual(out[0], {"role": "user", "content": "Aaron: venue is the sunroom"})
        self.assertEqual(out[1], {"role": "user", "content": "Shafen: I can bring the mic"})
        self.assertEqual(out[2], {"role": "assistant", "content": "noted"})
        # Verbatim: this is what _call_brigade sends as ``message``.
        self.assertEqual(out[3], {"role": "user", "content": "@rook where?"})

    def test_voice_and_system_lines_are_marked(self) -> None:
        entries = [
            _entry("Aaron started a call", sender_id=None, name="system", kind="system", sender_kind="system"),
            _entry("rook what's next", sender_id=AARON, name="Aaron", kind="voice", at=1),
        ]
        out = responder.history_from_context(_ctx(entries), agent_participant_id=AGENT)
        self.assertEqual(out[0], {"role": "user", "content": "[system] Aaron started a call"})
        self.assertEqual(out[1], {"role": "user", "content": "(voice) rook what's next"})

    def test_reply_entries_keep_their_thread_prefix(self) -> None:
        entries = [_entry("↳ reply to Aaron: yes", sender_id=SHAFEN, name="Shafen", kind="reply")]
        out = responder.history_from_context(_ctx(entries), agent_participant_id=AGENT)
        self.assertEqual(out, [{"role": "user", "content": "↳ reply to Aaron: yes"}])

    def test_summary_leads_as_a_system_turn(self) -> None:
        entries = [_entry("m", sender_id=AARON, name="Aaron")]
        out = responder.history_from_context(
            _ctx(entries, summary="Earlier: the venue is the sunroom."), agent_participant_id=AGENT
        )
        self.assertEqual(out[0]["role"], "system")
        self.assertIn("the venue is the sunroom", out[0]["content"])
        self.assertEqual(out[1], {"role": "user", "content": "m"})

    def test_blank_entries_are_skipped(self) -> None:
        entries = [_entry("  ", sender_id=AARON, name="Aaron")]
        self.assertEqual(responder.history_from_context(_ctx(entries), agent_participant_id=AGENT), [])


class BuildHistoryUsesTheBuilder(IsolatedAsyncioTestCase):
    async def test_build_history_calls_build_context_for_the_agent(self) -> None:
        room_id = uuid.uuid4()
        trigger = uuid.uuid4()
        fake = AsyncMock(
            return_value=_ctx([_entry("@rook hi", sender_id=AARON, name="Aaron", mid=trigger)])
        )
        with patch("app.services.context_builder.build_context", new=fake):
            out = await responder._build_history(
                db=AsyncMock(),
                room_id=room_id,
                agent_participant_id=AGENT,
                trigger_message_id=trigger,
                budget_tokens=1234,
            )
        fake.assert_awaited_once()
        kwargs = fake.await_args.kwargs
        self.assertEqual(kwargs["room_id"], room_id)
        self.assertEqual(kwargs["for_participant_id"], AGENT)
        self.assertEqual(kwargs["budget_tokens"], 1234)
        self.assertEqual(out, [{"role": "user", "content": "@rook hi"}])

    async def test_default_budget_when_settings_have_none(self) -> None:
        from app.services.context_builder import DEFAULT_BUDGET_TOKENS

        fake = AsyncMock(return_value=_ctx([]))
        with patch("app.services.context_builder.build_context", new=fake):
            await responder._build_history(db=AsyncMock(), room_id=uuid.uuid4(), agent_participant_id=AGENT)
        self.assertEqual(fake.await_args.kwargs["budget_tokens"], DEFAULT_BUDGET_TOKENS)

    def test_the_old_ten_message_window_is_gone(self) -> None:
        self.assertFalse(hasattr(responder, "_HISTORY_LIMIT"))


class WireShapeUnchanged(IsolatedAsyncioTestCase):
    async def test_call_brigade_still_sends_message_plus_history(self) -> None:
        """The Brigade wire shape: the trailing user turn as ``message``, prior
        turns (summary system line included) as ``history``."""
        import httpx

        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(200, json={"content": "the sunroom"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        settings = SimpleNamespace(brigade_api_base_url="http://test", brigade_api_key="fixture")
        room = SimpleNamespace(id=uuid.uuid4(), livekit_room_name="fixture", metadata_={})
        messages = [
            {"role": "system", "content": "Earlier in this room (rolling summary):\nvenue = sunroom"},
            {"role": "user", "content": "Aaron: venue is the sunroom"},
            {"role": "assistant", "content": "noted"},
            {"role": "user", "content": "@rook where?"},
        ]
        with patch.object(responder.httpx, "AsyncClient", return_value=client):
            text, _ = await responder._call_brigade(
                settings=settings, brigade_agent_id="rook", user_id="aaron", messages=messages, room=room
            )
        self.assertEqual(text, "the sunroom")
        self.assertEqual(seen["message"], "@rook where?")
        self.assertEqual(seen["history"], messages[:-1])
