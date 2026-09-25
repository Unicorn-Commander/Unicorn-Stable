"""Cast-alias validation holes from the 2026-09-25 review.

Numbers, control characters and stop-words must be 422. Duplicates are
collapsed before the limit of eight. An empty seat leaves the map, and
clearing aliases writes "{}" into LiveKit so a merge-only update actually
drops the old spellings.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.api.rooms import _clean_cast_aliases, RoomVoiceSettingsBody, update_voice_settings
from app.api.webhooks import _sync_voice_metadata
from app.models.room import MemberRole

ROOK = "agent-claude-code"
ALIAS_KEY = "voice_relay_cast_aliases"
CAST = {
    ROOK: "am_echo",
    "agent-grok": "am_onyx",
    "agent-shox": "am_michael",
    "agent-majik": "am_puck",
    "agent-zen": "bf_emma",
}


def _row(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _room(metadata):
    return SimpleNamespace(
        id=uuid.uuid4(),
        livekit_room_name="stable-build-in-public-live",
        metadata_=metadata,
        room_type="channel",
    )


def _show(**extra):
    return {
        "voice_relay_source": ROOK,
        "voice_primary_agent_id": "zen",
        "voice_relay_voices": dict(CAST),
        **extra,
    }


class AliasShapeTests(TestCase):
    def test_non_strings_control_chars_and_stop_words_are_422(self) -> None:
        rejected = (
            {"agent-shox": [123, True, {"a": 1}, ["x", "y"]]},
            {"agent-shox": ["sh\nocks"]},
            {"agent-shox": ["\u200bshocks"]},
            {"agent-shox": ["so"]},
            {"agent-shox": ["ok"]},
            {"agent-shox": ["the"]},
            {"agent-shox": ["OK"]},
            {"agent-shox": ["yes"]},
            {"agent-shox": ["a"]},
        )
        for raw in rejected:
            with self.subTest(raw=raw):
                with self.assertRaises(HTTPException) as ctx:
                    _clean_cast_aliases(raw)
                self.assertEqual(ctx.exception.status_code, 422)

    def test_duplicates_collapse_before_the_limit_and_whitespace_folds(self) -> None:
        self.assertEqual(
            _clean_cast_aliases({"agent-shox": ["Shocks", "shocks", "SHOCKS "]}),
            {"agent-shox": ["shocks"]},
        )
        self.assertEqual(
            _clean_cast_aliases({"agent-shox": ["shocks"] * 9}),
            {"agent-shox": ["shocks"]},
        )
        self.assertEqual(
            _clean_cast_aliases({"agent-shox": ["shocks   x", "ｓｈｏｃｋｓ"]}),
            {"agent-shox": ["shocks", "shocks x"]},
        )
        with self.assertRaises(HTTPException) as ctx:
            _clean_cast_aliases({"agent-shox": [f"alias{i:02d}" for i in range(9)]})
        self.assertEqual(ctx.exception.status_code, 422)

    def test_an_empty_seat_is_removed_from_the_map(self) -> None:
        self.assertEqual(_clean_cast_aliases({"agent-shox": []}), {})
        self.assertEqual(
            _clean_cast_aliases({"agent-shox": [], "agent-grok": ["grock"]}),
            {"agent-grok": ["grock"]},
        )


class AliasCollisionAndClearTests(IsolatedAsyncioTestCase):
    async def _patch(self, body, metadata, *, names=(), livekit_meta=None):
        db = AsyncMock()
        room = _room(metadata)
        people = MagicMock()
        people.all.return_value = list(names)
        db.execute = AsyncMock(
            side_effect=[
                _row(room),
                _row(SimpleNamespace(role=MemberRole.OWNER)),
                people,
            ]
        )
        db.commit = AsyncMock()
        livekit = AsyncMock()
        livekit.get_room_metadata = AsyncMock(return_value=livekit_meta or {})
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
        return result, room, livekit

    async def test_an_alias_of_another_seat_is_422(self) -> None:
        names = (("agent-grok", "Narrator"), ("agent-majik", "Majik Mane"))
        rejected = (
            {"agent-shox": ["grok"]},
            {"agent-shox": ["agent-grok"]},
            {"agent-shox": ["am_onyx"]},
            {"agent-shox": ["Narrator"]},
            {"agent-shox": ["majik mane"]},
        )
        for raw in rejected:
            with self.subTest(raw=raw):
                with self.assertRaises(HTTPException) as ctx:
                    await self._patch(
                        RoomVoiceSettingsBody(cast_aliases=raw),
                        _show(),
                        names=names,
                    )
                self.assertEqual(ctx.exception.status_code, 422)

        # A seat may keep its own display name.
        _result, room, _lk = await self._patch(
            RoomVoiceSettingsBody(cast_aliases={"agent-majik": ["Majik Mane"]}),
            _show(),
            names=names,
        )
        self.assertEqual(room.metadata_[ALIAS_KEY]["agent-majik"], ["majik mane"])

    async def test_clearing_a_seat_or_every_alias_writes_an_empty_object(self) -> None:
        stale = {
            "voice_relay_source": ROOK,
            "voice_relay_max_spoken_chars": "900",
            ALIAS_KEY: json.dumps({"agent-shox": ["show"]}),
        }
        for raw in ({"agent-shox": []}, {}):
            _result, room, livekit = await self._patch(
                RoomVoiceSettingsBody(cast_aliases=raw),
                _show(**{ALIAS_KEY: {"agent-shox": ["show"]}}),
                livekit_meta=dict(stale),
            )
            self.assertNotIn(ALIAS_KEY, room.metadata_)
            merged = json.loads(livekit.update_room_metadata.await_args.args[1])
            self.assertEqual(merged[ALIAS_KEY], "{}")

    async def test_a_stored_empty_seat_still_clears_livekit(self) -> None:
        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(
            return_value={
                "voice_relay_source": ROOK,
                "voice_relay_max_spoken_chars": "900",
                ALIAS_KEY: json.dumps({"agent-shox": ["show"]}),
            }
        )
        await _sync_voice_metadata(
            lk,
            _room(
                {
                    "voice_relay_source": ROOK,
                    ALIAS_KEY: {"agent-shox": []},
                }
            ),
        )
        merged = json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertEqual(merged[ALIAS_KEY], "{}")
