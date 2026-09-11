"""The human-1:1-DM agent-bind guard (the Shafen/Majik field bug).

Binding a resident agent (metadata.brigade_agent_id) onto a HUMAN pair DM
reclassifies the private conversation as an agent thread everywhere, so
invite-brigade-agent must refuse it (409, machine-readable detail) and push
the conversion to POST /rooms/{id}/start-group. Covers the pure predicate
and the route behavior: refusal for human DMs, while agent-DM birth
("New chat" first bind), rebinds of existing agent DMs, and group_dm /
channel invites keep working.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.api.brigade import (
    HUMAN_DM_AGENT_BIND_REFUSED,
    BrigadeAgent,
    InviteAgentRequest,
    _is_human_pair_dm,
    invite_brigade_agent,
)
from app.models.room import RoomType


class HumanPairDmPredicateTests(TestCase):
    def test_dm_with_pair_key_is_guarded(self) -> None:
        self.assertTrue(_is_human_pair_dm("dm", {"dm_pair": "a:b"}, 2))
        # dm_pair alone is decisive — a departed peer doesn't unlock binding.
        self.assertTrue(_is_human_pair_dm("dm", {"dm_pair": "a:b"}, 1))

    def test_legacy_dm_with_two_humans_is_guarded(self) -> None:
        self.assertTrue(_is_human_pair_dm("dm", {}, 2))
        self.assertTrue(_is_human_pair_dm("dm", None, 3))

    def test_agent_dm_birth_passes(self) -> None:
        # "New chat" creates a bare dm (no dm_pair, creator only) and binds
        # immediately — that first bind must keep working.
        self.assertFalse(_is_human_pair_dm("dm", {}, 1))
        self.assertFalse(_is_human_pair_dm("dm", None, 0))

    def test_existing_agent_dm_passes(self) -> None:
        self.assertFalse(
            _is_human_pair_dm("dm", {"brigade_agent_id": "majik"}, 2)
        )

    def test_non_dm_rooms_pass(self) -> None:
        self.assertFalse(_is_human_pair_dm("group_dm", {"dm_pair": "a:b"}, 2))
        self.assertFalse(_is_human_pair_dm("channel", {}, 50))


def _scalar(value) -> MagicMock:
    row = MagicMock()
    row.scalar_one_or_none.return_value = value
    return row


def _count(value: int) -> MagicMock:
    row = MagicMock()
    row.scalar_one.return_value = value
    return row


def _room(
    *,
    room_type: RoomType,
    metadata: dict | None,
    lk_name: str = "stable-room-x",
) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        room_type=room_type,
        metadata_=dict(metadata or {}),
        livekit_room_name=lk_name,
        name="room-x",
    )


ROSTER = [BrigadeAgent(id="majik", name="Majik", description="")]


class InviteBrigadeAgentGuardTests(IsolatedAsyncioTestCase):
    """Drive the route function directly (house mock style, no HTTP stack)."""

    def _user(self) -> dict:
        return {
            "participant_id": uuid.uuid4(),
            "display_name": "Aaron",
            "username": "aaron",
            "sub": "kc-aaron",
        }

    async def _call(self, room, db_results, *, dispatch: bool = False):
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=db_results)
        db.commit = AsyncMock()
        db.add = MagicMock()
        livekit = AsyncMock()
        body = InviteAgentRequest(brigade_agent_id="majik", dispatch=dispatch)
        with (
            patch("app.api.brigade.find_agent_participant", new=AsyncMock(return_value=None)),
            patch(
                "app.api.brigade._fetch_invitable_agents",
                new=AsyncMock(return_value=ROSTER),
            ),
            patch(
                "app.api.brigade.ensure_agent_access", new=AsyncMock()
            ),
            patch(
                "app.api.brigade._ensure_agent_member",
                new=AsyncMock(return_value="agent-pid"),
            ),
        ):
            return await invite_brigade_agent(
                room_name=room.livekit_room_name,
                body=body,
                user=self._user(),
                db=db,
                livekit=livekit,
                _rl=None,
            )

    async def test_human_pair_dm_bind_is_refused_409(self) -> None:
        room = _room(room_type=RoomType.DM, metadata={"dm_pair": "a:b"})
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                room,
                [
                    _scalar(room),        # room resolve
                    _scalar(MagicMock()), # caller membership
                    _count(2),            # human member count
                ],
            )
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertTrue(
            str(ctx.exception.detail).startswith(HUMAN_DM_AGENT_BIND_REFUSED)
        )

    async def test_legacy_human_dm_without_pair_key_also_refused(self) -> None:
        room = _room(room_type=RoomType.DM, metadata={})
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                room,
                [_scalar(room), _scalar(MagicMock()), _count(2)],
            )
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_agent_dm_birth_still_binds(self) -> None:
        # "New chat": bare dm, creator is the only human, no dm_pair.
        room = _room(room_type=RoomType.DM, metadata={})
        result = await self._call(
            room,
            [
                _scalar(room),         # room resolve
                _scalar(MagicMock()),  # caller membership
                _count(1),             # human member count → passes guard
                _scalar(room),         # metadata-persist room lookup
            ],
        )
        self.assertFalse(result.dispatched)
        self.assertEqual(result.reason, "dispatch_not_requested")
        # The binding this route exists to write actually landed.
        self.assertEqual(room.metadata_.get("brigade_agent_id"), "majik")

    async def test_existing_agent_dm_rebind_still_works(self) -> None:
        # An established agent DM re-invites on every call start
        # (VoiceProvider) — the guard must not run its count query nor block.
        room = _room(
            room_type=RoomType.DM, metadata={"brigade_agent_id": "majik"}
        )
        result = await self._call(
            room,
            [
                _scalar(room),         # room resolve
                _scalar(MagicMock()),  # caller membership
                _scalar(room),         # metadata-persist room lookup
            ],
        )
        self.assertEqual(result.reason, "dispatch_not_requested")
        self.assertEqual(room.metadata_.get("brigade_agent_id"), "majik")

    async def test_group_dm_invite_unaffected(self) -> None:
        room = _room(room_type=RoomType.GROUP_DM, metadata={})
        result = await self._call(
            room,
            [_scalar(room), _scalar(MagicMock()), _scalar(room)],
        )
        self.assertEqual(result.reason, "dispatch_not_requested")
        self.assertEqual(room.metadata_.get("brigade_agent_id"), "majik")

    async def test_channel_invite_unaffected(self) -> None:
        room = _room(room_type=RoomType.CHANNEL, metadata={})
        result = await self._call(
            room,
            [_scalar(room), _scalar(MagicMock()), _scalar(room)],
        )
        self.assertEqual(result.reason, "dispatch_not_requested")
        self.assertEqual(room.metadata_.get("brigade_agent_id"), "majik")
