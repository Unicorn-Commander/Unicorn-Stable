"""PATCH /rooms/{id}/voice-settings — the owner-facing voice control.

The setting existed before this endpoint, but only as SQL against room
metadata — an incantation, not a setting. The endpoint's contract is what the
web Settings UI builds against, so the shape is pinned here.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.api.rooms import RoomVoiceSettingsBody, update_voice_settings
from app.models.room import MemberRole


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _row(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _room(metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=_uuid(),
        livekit_room_name="stable-rook-aaron",
        metadata_=metadata,
    )


class VoiceSettingsTests(IsolatedAsyncioTestCase):
    async def _call(
        self,
        *,
        role: MemberRole | None = MemberRole.OWNER,
        activation: str = "ptt",
        metadata: dict | None = None,
        send_data: AsyncMock | None = None,
    ):
        db = AsyncMock()
        room = _room(
            metadata
            if metadata is not None
            else {"voice_relay_source": "agent-claude-code"}
        )
        membership = SimpleNamespace(role=role) if role is not None else None
        db.execute = AsyncMock(side_effect=[_row(room), _row(membership)])
        db.commit = AsyncMock()
        livekit = AsyncMock()
        if send_data is not None:
            livekit.send_data = send_data
        result = await update_voice_settings(
            room_id=room.id,
            body=RoomVoiceSettingsBody(activation=activation),
            user={"participant_id": _uuid()},
            db=db,
            livekit=livekit,
        )
        return result, room, db, livekit

    async def test_owner_sets_the_mode_and_it_reaches_the_live_call(self) -> None:
        result, room, db, livekit = await self._call(activation="ptt")
        self.assertEqual(result, {"activation": "ptt", "live": True})
        self.assertEqual(room.metadata_["voice_relay_activation"], "ptt")
        db.commit.assert_awaited()
        frame = livekit.send_data.await_args.args[1]
        self.assertEqual(frame["type"], "relay_config")
        self.assertEqual(frame["activation"], "ptt")

    async def test_admin_may_change_it_too(self) -> None:
        result, *_ = await self._call(role=MemberRole.ADMIN, activation="off")
        self.assertEqual(result["activation"], "off")

    async def test_member_and_guest_are_refused(self) -> None:
        for role in (MemberRole.MEMBER, MemberRole.GUEST):
            with self.assertRaises(HTTPException) as ctx:
                await self._call(role=role)
            self.assertEqual(ctx.exception.status_code, 403, role)

    async def test_a_non_member_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._call(role=None)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_an_unknown_mode_is_rejected_before_any_lookup(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._call(activation="banana")
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_every_supported_mode_is_accepted(self) -> None:
        for mode in ("name", "window", "always", "ptt", "off"):
            result, *_ = await self._call(activation=mode)
            self.assertEqual(result["activation"], mode)

    async def test_a_room_with_no_voice_agent_is_a_409_not_a_silent_write(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._call(metadata={"brigade_agent_id": "majik"})
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_no_live_call_still_saves_and_says_live_false(self) -> None:
        """The standing setting is the durable thing; the live push is a
        courtesy. A room with no call must not fail the save."""
        failing = AsyncMock(side_effect=RuntimeError("no session"))
        result, room, db, _ = await self._call(send_data=failing)
        self.assertEqual(result, {"activation": "ptt", "live": False})
        self.assertEqual(room.metadata_["voice_relay_activation"], "ptt")
        db.commit.assert_awaited()

    async def test_metadata_is_reassigned_not_mutated(self) -> None:
        """JSONB change detection only sees a NEW dict on the attribute."""
        original = {"voice_relay_source": "agent-claude-code"}
        _, room, *_ = await self._call(metadata=original)
        self.assertIsNot(room.metadata_, original)
        self.assertNotIn("voice_relay_activation", original)
