"""The generic invite route refuses 1:1 DMs — the silent in-place dm→group_dm
promotion is gone. Bringing more people in is the explicit start-group flow,
which creates a NEW room and leaves the DM untouched."""

from __future__ import annotations

import inspect
import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.api.rooms import InviteMemberBody, invite_member
from app.models.room import RoomType


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _row(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


class InviteDmGuardTests(IsolatedAsyncioTestCase):
    async def _invite(self, room_type: RoomType, execute_tail: list) -> None:
        db = AsyncMock()
        caller_membership = _row(SimpleNamespace(id=_uuid()))
        room_row = _row(
            SimpleNamespace(id=_uuid(), room_type=room_type)
        )
        db.execute = AsyncMock(
            side_effect=[caller_membership, room_row, *execute_tail]
        )
        await invite_member(
            room_id=_uuid(),
            body=InviteMemberBody(participant_id=_uuid()),
            user={"participant_id": _uuid()},
            db=db,
            livekit=AsyncMock(),
            presence=AsyncMock(),
        )

    async def test_invite_into_dm_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._invite(RoomType.DM, [])
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("Start a group", ctx.exception.detail)

    async def test_invite_into_group_dm_passes_the_guard(self) -> None:
        # Target lookup then returns None → 404, which proves control flowed
        # PAST the DM guard for a non-DM room.
        with self.assertRaises(HTTPException) as ctx:
            await self._invite(RoomType.GROUP_DM, [_row(None)])
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.detail, "User not found")

    async def test_invite_into_channel_passes_the_guard(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._invite(RoomType.CHANNEL, [_row(None)])
        self.assertEqual(ctx.exception.status_code, 404)

    def test_silent_promotion_is_gone_from_the_source(self) -> None:
        source = inspect.getsource(invite_member)
        self.assertNotIn("Auto-promote", source)
        self.assertNotIn("GROUP_DM", source.replace("RoomType.DM", ""))
        self.assertIn("start-group", source)
