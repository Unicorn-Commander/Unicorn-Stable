"""Per-seat STT aliases, carried the same three ways as the cast bench.

Aaron sets them on the voice-settings PATCH. The relay reads them from the
dispatch metadata, the LiveKit room metadata, and the live relay_config frame.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.api.rooms import RoomVoiceSettingsBody, update_voice_settings
from app.api.webhooks import (
    _cast_aliases_json,
    _ensure_voice_relay,
    _stage_voices_json,
    _sync_voice_metadata,
    relay_cast_aliases,
)
from app.models.room import MemberRole

ROOK = "agent-claude-code"
CAST = {
    ROOK: "am_echo",
    "agent-grok": "am_onyx",
    "agent-shox": "am_michael",
    "agent-majik": "am_puck",
    "agent-zen": "bf_emma",
}
ALIAS_KEY = "voice_relay_cast_aliases"


def _row(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _room(metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        livekit_room_name="stable-build-in-public-live",
        metadata_=metadata,
        room_type="channel",
    )


def _show(**extra) -> dict:
    return {
        "voice_relay_source": ROOK,
        "voice_primary_agent_id": "zen",
        "voice_relay_voices": dict(CAST),
        **extra,
    }


class CastAliasEndpointTests(IsolatedAsyncioTestCase):
    async def _patch(self, body: RoomVoiceSettingsBody, metadata: dict):
        db = AsyncMock()
        room = _room(metadata)
        db.execute = AsyncMock(
            side_effect=[
                _row(room),
                _row(SimpleNamespace(role=MemberRole.OWNER)),
                MagicMock(all=MagicMock(return_value=[])),
            ]
        )
        db.commit = AsyncMock()
        livekit = AsyncMock()
        livekit.get_room_metadata = AsyncMock(return_value={})
        livekit.get_room = AsyncMock(
            return_value={"participants": [SimpleNamespace(identity="aaron_1111")]}
        )
        result = await update_voice_settings(
            room_id=room.id,
            body=body,
            user={"participant_id": uuid.uuid4()},
            db=db,
            livekit=livekit,
        )
        return result, room, db, livekit

    async def test_aliases_are_stored_lowercase_and_pushed_live(self) -> None:
        result, room, db, livekit = await self._patch(
            RoomVoiceSettingsBody(
                cast_aliases={
                    " agent-shox ": [" Shocks ", "SHOCKS", "shoxx"],
                    "agent-majik": ["Magic", "magic mane"],
                }
            ),
            _show(),
        )
        stored = room.metadata_[ALIAS_KEY]
        self.assertEqual(stored["agent-shox"], ["shocks", "shoxx"])
        self.assertEqual(stored["agent-majik"], ["magic", "magic mane"])
        self.assertEqual(result["cast_aliases"], stored)
        db.commit.assert_awaited()
        frame = livekit.send_data.await_args.args[1]
        self.assertEqual(frame["type"], "relay_config")
        self.assertEqual(frame["cast_aliases"], stored)
        # Dispatch metadata and the LiveKit room copy carry the same map.
        dispatched = json.loads(
            livekit.dispatch_agent.await_args.kwargs["metadata"][ALIAS_KEY]
        )
        self.assertEqual(dispatched["agent-shox"], ["shocks", "shoxx"])
        synced = json.loads(livekit.update_room_metadata.await_args.args[1])
        self.assertEqual(json.loads(synced[ALIAS_KEY]), stored)

    async def test_an_empty_map_clears_room_aliases(self) -> None:
        result, room, _, livekit = await self._patch(
            RoomVoiceSettingsBody(cast_aliases={}),
            _show(**{ALIAS_KEY: {"agent-shox": ["shocks"]}}),
        )
        self.assertNotIn(ALIAS_KEY, room.metadata_)
        self.assertEqual(result["cast_aliases"], {})
        self.assertEqual(livekit.send_data.await_args.args[1]["cast_aliases"], {})

    async def test_omitting_the_field_leaves_aliases_alone(self) -> None:
        result, room, _, livekit = await self._patch(
            RoomVoiceSettingsBody(activation="window"),
            _show(**{ALIAS_KEY: {"agent-shox": ["shocks"]}}),
        )
        self.assertEqual(room.metadata_[ALIAS_KEY], {"agent-shox": ["shocks"]})
        self.assertNotIn("cast_aliases", result)
        self.assertNotIn("cast_aliases", livekit.send_data.await_args.args[1])

    async def test_a_name_outside_the_cast_is_a_422_and_nothing_is_saved(self) -> None:
        db = AsyncMock()
        room = _room(_show())
        db.execute = AsyncMock(
            side_effect=[
                _row(room),
                _row(SimpleNamespace(role=MemberRole.OWNER)),
                MagicMock(all=MagicMock(return_value=[])),
            ]
        )
        db.commit = AsyncMock()
        livekit = AsyncMock()
        with self.assertRaises(HTTPException) as ctx:
            await update_voice_settings(
                room_id=room.id,
                body=RoomVoiceSettingsBody(cast_aliases={"agent-nobody": ["nobody"]}),
                user={"participant_id": uuid.uuid4()},
                db=db,
                livekit=livekit,
            )
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("agent-nobody", ctx.exception.detail)
        db.commit.assert_not_awaited()
        livekit.send_data.assert_not_awaited()
        self.assertNotIn(ALIAS_KEY, room.metadata_)

    async def test_too_many_or_the_wrong_length_is_a_422(self) -> None:
        for bad in (
            {"agent-shox": [f"alias-{i}" for i in range(9)]},
            {"agent-shox": ["a"]},
            {"agent-shox": ["x" * 41]},
            {"agent-shox": "shocks"},
            {"": ["shocks"]},
        ):
            with self.assertRaises(HTTPException) as ctx:
                await self._patch(RoomVoiceSettingsBody(cast_aliases=bad), _show())
            self.assertEqual(ctx.exception.status_code, 422, bad)

    async def test_a_new_cast_forgets_aliases_it_no_longer_names(self) -> None:
        _, room, _, livekit = await self._patch(
            RoomVoiceSettingsBody(voices={ROOK: "am_echo", "agent-grok": "am_onyx"}),
            _show(**{ALIAS_KEY: {"agent-shox": ["shocks"], "agent-grok": ["grock"]}}),
        )
        self.assertEqual(room.metadata_[ALIAS_KEY], {"agent-grok": ["grock"]})
        self.assertEqual(
            livekit.send_data.await_args.args[1]["cast_aliases"],
            {"agent-grok": ["grock"]},
        )


class CastAliasReachesTheWorkerTests(IsolatedAsyncioTestCase):
    async def test_dispatch_carries_the_alias_map(self) -> None:
        lk = AsyncMock()
        lk.get_room = AsyncMock(
            return_value={"participants": [SimpleNamespace(identity="aaron_1111")]}
        )
        lk.dispatch_agent = AsyncMock(return_value={"dispatched": True})
        await _ensure_voice_relay(
            lk, _room(_show(**{ALIAS_KEY: {"agent-shox": ["shocks"]}}))
        )
        raw = lk.dispatch_agent.await_args.kwargs["metadata"][ALIAS_KEY]
        self.assertEqual(json.loads(raw), {"agent-shox": ["shocks"]})

    async def test_no_aliases_means_no_dispatch_key(self) -> None:
        lk = AsyncMock()
        lk.get_room = AsyncMock(
            return_value={"participants": [SimpleNamespace(identity="aaron_1111")]}
        )
        lk.dispatch_agent = AsyncMock(return_value={"dispatched": True})
        await _ensure_voice_relay(lk, _room(_show()))
        self.assertNotIn(ALIAS_KEY, lk.dispatch_agent.await_args.kwargs["metadata"])

    async def test_sync_carries_the_json_string(self) -> None:
        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(return_value={})
        await _sync_voice_metadata(
            lk, _room(_show(**{ALIAS_KEY: {"agent-majik": ["magic", "magic mane"]}}))
        )
        merged = json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertEqual(
            json.loads(merged[ALIAS_KEY]),
            {"agent-majik": ["magic", "magic mane"]},
        )

    async def test_an_already_synced_map_writes_nothing(self) -> None:
        stored = {"agent-shox": ["shocks"]}
        meta = _show(**{ALIAS_KEY: stored})
        encoded = _cast_aliases_json(stored)
        self.assertIsNotNone(encoded)
        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(
            return_value={
                "voice_relay_source": ROOK,
                "voice_primary_agent_id": "zen",
                ALIAS_KEY: encoded,
                "voice_relay_voices": _stage_voices_json(meta),
                "voice_relay_max_spoken_chars": "900",
            }
        )
        await _sync_voice_metadata(lk, _room(meta))
        lk.update_room_metadata.assert_not_awaited()

    async def test_a_deleted_map_clears_the_stale_livekit_copy(self) -> None:
        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(
            return_value={
                "voice_relay_source": ROOK,
                ALIAS_KEY: json.dumps({"agent-shox": ["shocks"]}),
                "voice_relay_max_spoken_chars": "900",
            }
        )
        await _sync_voice_metadata(lk, _room({"voice_relay_source": ROOK}))
        merged = json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertEqual(merged[ALIAS_KEY], "{}")


class CastAliasShapeTests(TestCase):
    def test_junk_shapes_are_ignored_on_the_read_path(self) -> None:
        self.assertIsNone(relay_cast_aliases(None))
        self.assertIsNone(relay_cast_aliases("not json"))
        self.assertIsNone(relay_cast_aliases({"agent-shox": "shocks"}))
        self.assertEqual(
            relay_cast_aliases({"agent-shox": [" Shocks ", "shocks"]}),
            {"agent-shox": ["shocks"]},
        )
