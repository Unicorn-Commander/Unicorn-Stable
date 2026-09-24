"""The cast bench (2026-09-24): seats that keep their voice but sit out a call.

Aaron, on Shafen's eight seats in the show cast: "maybe we have the option of
bringing them in or not?" Before this the only lever was rewriting the whole
``voices`` map through the API, which throws the voice assignment away. The
bench keeps the roster intact and hands the relay the roster MINUS the bench on
every path it reads a cast from: the dispatch, the room's LiveKit metadata and
the live ``relay_config`` frame.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.api.rooms import RoomVoiceSettingsBody, get_voice_cast, update_voice_settings
from app.api.webhooks import (
    VOICE_BENCH_KEY,
    _ensure_voice_relay,
    _sync_voice_metadata,
    relay_bench,
    stage_voices,
)
from app.models.room import MemberRole

ROOK = "agent-claude-code"
CAST = {
    ROOK: "am_echo",
    "agent-grok": "am_onyx",
    "agent-zen": "bf_emma",
    "agent-okapi-grok": "am_michael",
    "agent-shafen-claude-code": "bm_lewis",
}


def _row(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _room(metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        livekit_room_name="stable-build-in-public-live",
        metadata_=metadata,
    )


def _show(**extra) -> dict:
    return {
        "voice_relay_source": ROOK,
        "voice_primary_agent_id": "zen",
        "voice_relay_multi": True,
        "voice_relay_voices": dict(CAST),
        **extra,
    }


class BenchEndpointTests(IsolatedAsyncioTestCase):
    async def _patch(self, body: RoomVoiceSettingsBody, metadata: dict):
        db = AsyncMock()
        room = _room(metadata)
        db.execute = AsyncMock(
            side_effect=[_row(room), _row(SimpleNamespace(role=MemberRole.OWNER))]
        )
        db.commit = AsyncMock()
        livekit = AsyncMock()
        result = await update_voice_settings(
            room_id=room.id,
            body=body,
            user={"participant_id": uuid.uuid4()},
            db=db,
            livekit=livekit,
        )
        return result, room, db, livekit

    async def test_benching_keeps_the_roster_and_takes_the_seat_off_the_live_stage(self) -> None:
        result, room, db, livekit = await self._patch(
            RoomVoiceSettingsBody(
                bench=["agent-shafen-claude-code", " agent-okapi-grok ", "agent-okapi-grok"]
            ),
            _show(),
        )
        # The roster is untouched: bringing a seat back needs no voice id.
        self.assertEqual(room.metadata_["voice_relay_voices"], CAST)
        self.assertEqual(
            room.metadata_[VOICE_BENCH_KEY], ["agent-okapi-grok", "agent-shafen-claude-code"]
        )
        self.assertEqual(result["bench"], ["agent-okapi-grok", "agent-shafen-claude-code"])
        db.commit.assert_awaited()
        frame = livekit.send_data.await_args.args[1]
        self.assertEqual(frame["type"], "relay_config")
        self.assertEqual(
            frame["voices"],
            {ROOK: "am_echo", "agent-grok": "am_onyx", "agent-zen": "bf_emma"},
        )
        self.assertEqual(frame["bench"], ["agent-okapi-grok", "agent-shafen-claude-code"])

    async def test_an_empty_bench_brings_everyone_back(self) -> None:
        result, room, _, livekit = await self._patch(
            RoomVoiceSettingsBody(bench=[]),
            _show(**{VOICE_BENCH_KEY: ["agent-okapi-grok"]}),
        )
        self.assertNotIn(VOICE_BENCH_KEY, room.metadata_)
        self.assertEqual(result["bench"], [])
        self.assertEqual(livekit.send_data.await_args.args[1]["voices"], CAST)

    async def test_a_name_outside_the_cast_is_a_422_and_nothing_is_saved(self) -> None:
        db = AsyncMock()
        room = _room(_show())
        db.execute = AsyncMock(
            side_effect=[_row(room), _row(SimpleNamespace(role=MemberRole.OWNER))]
        )
        db.commit = AsyncMock()
        livekit = AsyncMock()
        with self.assertRaises(HTTPException) as ctx:
            await update_voice_settings(
                room_id=room.id,
                body=RoomVoiceSettingsBody(bench=["agent-nobody"]),
                user={"participant_id": uuid.uuid4()},
                db=db,
                livekit=livekit,
            )
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("agent-nobody", ctx.exception.detail)
        db.commit.assert_not_awaited()
        livekit.send_data.assert_not_awaited()
        self.assertNotIn(VOICE_BENCH_KEY, room.metadata_)

    async def test_the_rooms_own_voice_agent_cannot_be_benched(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._patch(RoomVoiceSettingsBody(bench=[ROOK]), _show())
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("voice agent", ctx.exception.detail)

    async def test_the_co_host_cannot_be_benched(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._patch(RoomVoiceSettingsBody(bench=["agent-zen"]), _show())
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("co-host", ctx.exception.detail)

    async def test_the_co_host_can_be_benched_once_the_co_host_moves_in_the_same_call(self) -> None:
        _, room, *_ = await self._patch(
            RoomVoiceSettingsBody(primary_agent_id="grok", bench=["agent-zen"]), _show()
        )
        self.assertEqual(room.metadata_[VOICE_BENCH_KEY], ["agent-zen"])

    async def test_a_new_cast_forgets_bench_entries_it_no_longer_names(self) -> None:
        _, room, _, livekit = await self._patch(
            RoomVoiceSettingsBody(voices={ROOK: "am_echo", "agent-grok": "am_onyx"}),
            _show(**{VOICE_BENCH_KEY: ["agent-grok", "agent-okapi-grok"]}),
        )
        self.assertEqual(room.metadata_[VOICE_BENCH_KEY], ["agent-grok"])
        self.assertEqual(livekit.send_data.await_args.args[1]["voices"], {ROOK: "am_echo"})

    async def test_a_patch_that_does_not_name_the_bench_leaves_it_alone(self) -> None:
        result, room, _, livekit = await self._patch(
            RoomVoiceSettingsBody(activation="window"),
            _show(**{VOICE_BENCH_KEY: ["agent-okapi-grok"]}),
        )
        self.assertEqual(room.metadata_[VOICE_BENCH_KEY], ["agent-okapi-grok"])
        self.assertNotIn("bench", result)
        self.assertNotIn("voices", livekit.send_data.await_args.args[1])


class StageCastTests(TestCase):
    def test_no_cast_means_none_so_the_worker_behaves_as_before(self) -> None:
        self.assertIsNone(stage_voices({"voice_relay_source": ROOK}))
        self.assertIsNone(stage_voices(None))

    def test_everyone_benched_is_an_empty_stage_not_none(self) -> None:
        meta = {"voice_relay_voices": {"agent-grok": "am_onyx"}, VOICE_BENCH_KEY: ["agent-grok"]}
        self.assertEqual(stage_voices(meta), {})

    def test_string_forms_from_a_hand_edit_are_read(self) -> None:
        meta = {
            "voice_relay_voices": json.dumps(CAST),
            VOICE_BENCH_KEY: json.dumps(["agent-grok"]),
        }
        self.assertNotIn("agent-grok", stage_voices(meta))
        self.assertEqual(relay_bench(meta), ["agent-grok"])

    def test_junk_bench_values_are_ignored(self) -> None:
        self.assertEqual(relay_bench({VOICE_BENCH_KEY: "not json"}), [])
        self.assertEqual(relay_bench({VOICE_BENCH_KEY: {"a": 1}}), [])


class BenchReachesTheWorkerTests(IsolatedAsyncioTestCase):
    async def test_dispatch_carries_the_stage_cast(self) -> None:
        lk = AsyncMock()
        lk.get_room = AsyncMock(
            return_value={"participants": [SimpleNamespace(identity="aaron_1111")]}
        )
        lk.dispatch_agent = AsyncMock(return_value={"dispatched": True})
        await _ensure_voice_relay(
            lk, _room(_show(**{VOICE_BENCH_KEY: ["agent-okapi-grok", "agent-shafen-claude-code"]}))
        )
        voices = json.loads(lk.dispatch_agent.await_args.kwargs["metadata"]["voice_relay_voices"])
        self.assertEqual(set(voices), {ROOK, "agent-grok", "agent-zen"})

    async def test_sync_carries_the_stage_cast_and_an_empty_one_explicitly(self) -> None:
        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(
            return_value={"voice_relay_voices": json.dumps({"agent-grok": "am_onyx"})}
        )
        await _sync_voice_metadata(
            lk,
            _room(
                {
                    "voice_relay_source": ROOK,
                    "voice_relay_voices": {"agent-grok": "am_onyx"},
                    VOICE_BENCH_KEY: ["agent-grok"],
                }
            ),
        )
        merged = json.loads(lk.update_room_metadata.await_args.args[1])
        # "{}" — not a missing key, which merge-only metadata would read as
        # "keep Grok on stage".
        self.assertEqual(merged["voice_relay_voices"], "{}")


class VoiceCastReadTests(IsolatedAsyncioTestCase):
    async def _get(self, metadata: dict, names: list[tuple[str, str]]):
        db = AsyncMock()
        room = _room(metadata)
        people = MagicMock()
        people.all.return_value = names
        db.execute = AsyncMock(side_effect=[_row(room), people])
        return await get_voice_cast(room_id=room.id, _user={}, db=db)

    async def test_seats_carry_real_names_stage_state_and_locks(self) -> None:
        out = await self._get(
            _show(**{VOICE_BENCH_KEY: ["agent-okapi-grok", "agent-gone"]}),
            [(ROOK, "Rook"), ("agent-okapi-grok", "Okapi"), ("agent-zen", "Zen")],
        )
        seats = {s["username"]: s for s in out["seats"]}
        self.assertEqual(seats[ROOK]["locked"], "voice_agent")
        self.assertEqual(seats["agent-zen"]["locked"], "co_host")
        self.assertFalse(seats["agent-okapi-grok"]["on_stage"])
        self.assertTrue(seats["agent-grok"]["on_stage"])
        # No participant row → the short id, never a crash.
        self.assertEqual(seats["agent-grok"]["display_name"], "grok")
        self.assertEqual(seats["agent-okapi-grok"]["display_name"], "Okapi")
        # A stale bench entry outside the cast is not reported.
        self.assertEqual(out["bench"], ["agent-okapi-grok"])
        # Locked seats first, then by name.
        self.assertEqual([s["locked"] is not None for s in out["seats"]][:2], [True, True])

    async def test_a_room_without_a_cast_has_no_seats(self) -> None:
        out = await self._get({"voice_relay_source": ROOK}, [])
        self.assertEqual(out, {"seats": [], "bench": []})
