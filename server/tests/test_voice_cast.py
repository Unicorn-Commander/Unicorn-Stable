"""Voice cast + pedal target, server side (E04, 2026-09-01).

The relay reads LiveKit room metadata and in-room frames, never the database.
So the whole server job here is carriage: the cast map must survive the DB
→ LiveKit sync and the relay dispatch as a JSON STRING (LiveKit metadata
carries strings), the owner endpoint must store it, and the talk-gate frame
must carry the pedal's target.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from app.api.gateway import TalkGateBody, set_talk_gate
from app.api.rooms import RoomVoiceSettingsBody, update_voice_settings
from app.api.webhooks import (
    _VOICE_META_KEYS,
    _ensure_voice_relay,
    _relay_voices_json,
    _sync_voice_metadata,
)
from app.auth.gateway_auth import GatewayPrincipal
from app.models.room import MemberRole

ROOK = "agent-claude-code"
CAST = {"agent-grok": "am_onyx", "agent-flow": "bm_lewis"}


def _room(metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        livekit_room_name="stable-bip",
        name="bip",
        metadata_=metadata,
    )


def _livekit(identities: list[str]) -> AsyncMock:
    lk = AsyncMock()
    lk.get_room = AsyncMock(
        return_value={
            "participants": [SimpleNamespace(identity=i) for i in identities]
        }
    )
    lk.dispatch_agent = AsyncMock()
    return lk


class VoicesJsonTests(TestCase):
    def test_a_dict_becomes_a_sorted_json_string(self) -> None:
        self.assertEqual(
            _relay_voices_json({"b": "x", "a": "y"}), '{"a": "y", "b": "x"}'
        )

    def test_a_json_string_is_accepted_and_normalised(self) -> None:
        self.assertEqual(_relay_voices_json('{"b":"x","a":"y"}'), '{"a": "y", "b": "x"}')

    def test_junk_is_none(self) -> None:
        for junk in (None, "", "  ", "not json", 7, [], {}, {"": "x"}, {"a": " "}):
            self.assertIsNone(_relay_voices_json(junk), junk)

    def test_the_key_is_in_the_synced_set(self) -> None:
        self.assertIn("voice_relay_voices", _VOICE_META_KEYS)


class MetadataSyncTests(IsolatedAsyncioTestCase):
    async def test_the_cast_dict_reaches_livekit_as_a_string(self) -> None:
        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(return_value={})
        await _sync_voice_metadata(
            lk, _room({"voice_relay_source": ROOK, "voice_relay_voices": CAST})
        )
        merged = json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertIsInstance(merged["voice_relay_voices"], str)
        self.assertEqual(json.loads(merged["voice_relay_voices"]), CAST)

    async def test_an_already_synced_cast_writes_nothing(self) -> None:
        """Dict on the row, string in LiveKit: the comparison must see them as
        equal, or every webhook rewrites the room metadata."""
        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(
            return_value={
                "voice_relay_source": ROOK,
                "voice_relay_voices": json.dumps(CAST, sort_keys=True),
            }
        )
        await _sync_voice_metadata(
            lk, _room({"voice_relay_source": ROOK, "voice_relay_voices": CAST})
        )
        lk.update_room_metadata.assert_not_awaited()


class DispatchCarriesCastTests(IsolatedAsyncioTestCase):
    async def test_the_cast_rides_the_relay_dispatch(self) -> None:
        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(
            lk, _room({"voice_relay_source": ROOK, "voice_relay_voices": CAST})
        )
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertEqual(json.loads(meta["voice_relay_voices"]), CAST)

    async def test_no_cast_means_no_key(self) -> None:
        """Absent stays absent — the worker's no-key path is the old behaviour."""
        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertNotIn("voice_relay_voices", meta)


class TalkGateBodyTests(TestCase):
    def test_target_is_optional_and_shape_checked(self) -> None:
        self.assertIsNone(TalkGateBody(room="bip", open=True).target)
        self.assertEqual(
            TalkGateBody(room="bip", open=True, target="agent-grok").target, "agent-grok"
        )
        for junk in ("a", "x" * 65, "grok bot", "@agent-grok"):
            with self.assertRaises(ValidationError, msg=junk):
                TalkGateBody(room="bip", open=True, target=junk)


class TalkGateEndpointTests(IsolatedAsyncioTestCase):
    def _principal(self) -> GatewayPrincipal:
        return GatewayPrincipal(
            auth_kind="key",
            agent_id="pedal",
            allowed_rooms=["*"],
            rate_key="k",
            rate_limit_rpm=60,
            human_sub=None,
        )

    async def _call(self, body: TalkGateBody):
        db = AsyncMock()
        res = MagicMock()
        res.scalar_one_or_none.return_value = _room({"voice_relay_source": ROOK})
        db.execute = AsyncMock(return_value=res)
        livekit = AsyncMock()
        with patch("app.api.gateway._gateway_rate_limit", new=AsyncMock()):
            result = await set_talk_gate(
                body=body,
                principal=self._principal(),
                db=db,
                livekit=livekit,
                redis=AsyncMock(),
            )
        return result, livekit.send_data.await_args.args[1]

    async def test_the_frame_carries_the_target(self) -> None:
        result, frame = await self._call(
            TalkGateBody(room="bip", open=True, target="agent-grok")
        )
        self.assertEqual(
            frame, {"type": "talk_gate", "open": True, "by": "pedal", "target": "agent-grok"}
        )
        self.assertEqual(result["target"], "agent-grok")
        self.assertTrue(result["delivered"])

    async def test_no_target_is_the_old_frame(self) -> None:
        _, frame = await self._call(TalkGateBody(room="bip", open=False))
        self.assertEqual(frame, {"type": "talk_gate", "open": False, "by": "pedal"})


class VoiceSettingsCastTests(IsolatedAsyncioTestCase):
    async def _call(self, body: RoomVoiceSettingsBody, metadata: dict | None = None):
        db = AsyncMock()
        room = _room(metadata if metadata is not None else {"voice_relay_source": ROOK})
        rows = []
        for value in (room, SimpleNamespace(role=MemberRole.OWNER)):
            res = MagicMock()
            res.scalar_one_or_none.return_value = value
            rows.append(res)
        db.execute = AsyncMock(side_effect=rows)
        db.commit = AsyncMock()
        livekit = AsyncMock()
        result = await update_voice_settings(
            room_id=room.id,
            body=body,
            user={"participant_id": uuid.uuid4()},
            db=db,
            livekit=livekit,
        )
        return result, room, livekit

    async def test_the_cast_is_stored_and_pushed_live(self) -> None:
        result, room, livekit = await self._call(
            RoomVoiceSettingsBody(activation="ptt", voices=CAST)
        )
        self.assertEqual(room.metadata_["voice_relay_voices"], CAST)
        self.assertEqual(result["voices"], CAST)
        frame = livekit.send_data.await_args.args[1]
        self.assertEqual(frame["voices"], CAST)

    async def test_omitting_voices_leaves_the_cast_alone(self) -> None:
        result, room, livekit = await self._call(
            RoomVoiceSettingsBody(activation="ptt"),
            metadata={"voice_relay_source": ROOK, "voice_relay_voices": CAST},
        )
        self.assertEqual(room.metadata_["voice_relay_voices"], CAST)
        self.assertNotIn("voices", result)
        self.assertNotIn("voices", livekit.send_data.await_args.args[1])

    async def test_an_empty_map_clears_the_cast(self) -> None:
        _, room, livekit = await self._call(
            RoomVoiceSettingsBody(activation="ptt", voices={}),
            metadata={"voice_relay_source": ROOK, "voice_relay_voices": CAST},
        )
        self.assertNotIn("voice_relay_voices", room.metadata_)
        self.assertEqual(livekit.send_data.await_args.args[1]["voices"], {})

    async def test_values_are_trimmed_and_junk_is_a_422(self) -> None:
        _, room, _ = await self._call(
            RoomVoiceSettingsBody(activation="ptt", voices={" agent-grok ": " am_onyx "})
        )
        self.assertEqual(room.metadata_["voice_relay_voices"], {"agent-grok": "am_onyx"})
        for junk in ({"agent-grok": ""}, {"": "am_onyx"}, {"agent-grok": "v" * 33}):
            with self.assertRaises(HTTPException) as ctx:
                await self._call(RoomVoiceSettingsBody(activation="ptt", voices=junk))
            self.assertEqual(ctx.exception.status_code, 422, junk)
