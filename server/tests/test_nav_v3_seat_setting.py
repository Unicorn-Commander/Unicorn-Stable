"""Nav v3 C2 — ``metadata.seat`` through ``PATCH /rooms/{id}``.

Validated first (422), then allowed for the room OWNER or any human member
of a ``private`` room, refused with 409 when no runner-backed seat is in the
room. A PATCH that carries anything else keeps the owner/admin rule.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.models.participant import ParticipantType
from app.models.room import MemberRole, RoomType
from app.services.room_service import CLIENT_MUTABLE_METADATA_KEYS, RoomService


def _res(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _human(username="aaron"):
    return SimpleNamespace(
        id=uuid.uuid4(), username=username, participant_type=ParticipantType.HUMAN, metadata_={}
    )


def _seat(agent_id="persephone", owner="aaron"):
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=f"agent-{agent_id}",
        participant_type=ParticipantType.AGENT,
        metadata_={"backend": "runner", "crew": True, "owner": owner},
    )


def _brigade(agent_id="majik"):
    return SimpleNamespace(
        id=uuid.uuid4(), username=f"agent-{agent_id}", participant_type=ParticipantType.AGENT, metadata_={}
    )


def _member(participant, role=MemberRole.MEMBER):
    return SimpleNamespace(participant=participant, participant_id=participant.id, role=role, agent_mode=None)


def _room(members, room_type=RoomType.AGENT_HUB, metadata=None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        room_type=room_type,
        members=members,
        metadata_=dict(metadata or {"agent_hub": {"agent_id": "persephone"}}),
        parent_room_id=None,
        display_name="Persephone",
        description=None,
        is_archived=False,
    )


class SeatSettingPatch(IsolatedAsyncioTestCase):
    def _svc(self, *results):
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=list(results))
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        return RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock()), db

    async def test_seat_is_client_mutable(self) -> None:
        self.assertIn("seat", CLIENT_MUTABLE_METADATA_KEYS)

    async def test_owner_sets_the_seat_and_it_is_stored_normalised(self) -> None:
        aaron, seat = _human(), _seat()
        me = _member(aaron, MemberRole.OWNER)
        room = _room([me, _member(seat)])
        svc, db = self._svc(_res(me), _res(room))
        out = await svc.update_room(
            room.id, aaron.id, metadata={"seat": {"model": "claude-opus-5-5", "effort": "medium"}}
        )
        self.assertEqual(out.metadata_["seat"], {"model": "claude-opus-5-5", "effort": "medium"})
        # Server-owned keys survive the merge.
        self.assertEqual(out.metadata_["agent_hub"], {"agent_id": "persephone"})
        db.commit.assert_awaited_once()
        # A seat-only PATCH looks the membership up (any role), not the
        # owner/admin ladder — two queries: membership, room.
        self.assertEqual(db.execute.await_count, 2)

    async def test_null_seat_means_back_to_defaults(self) -> None:
        aaron, seat = _human(), _seat()
        me = _member(aaron, MemberRole.OWNER)
        room = _room([me, _member(seat)], metadata={"seat": {"model": "claude-opus-5-5", "effort": "max"}})
        svc, _db = self._svc(_res(me), _res(room))
        out = await svc.update_room(room.id, aaron.id, metadata={"seat": None})
        self.assertEqual(out.metadata_["seat"], {"model": None, "effort": None})

    async def test_bad_effort_is_422_before_any_query(self) -> None:
        aaron = _human()
        svc, db = self._svc()
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(uuid.uuid4(), aaron.id, metadata={"seat": {"effort": "ultra"}})
        self.assertEqual(ctx.exception.status_code, 422)
        db.execute.assert_not_awaited()

    async def test_bad_model_is_422(self) -> None:
        aaron = _human()
        svc, db = self._svc()
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(uuid.uuid4(), aaron.id, metadata={"seat": {"model": "Claude Opus"}})
        self.assertEqual(ctx.exception.status_code, 422)
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(uuid.uuid4(), aaron.id, metadata={"seat": "claude-opus-5-5"})
        self.assertEqual(ctx.exception.status_code, 422)
        db.execute.assert_not_awaited()

    async def test_non_owner_human_in_a_shared_room_is_403(self) -> None:
        aaron, shafen, seat = _human("aaron"), _human("shafen"), _seat()
        me = _member(shafen, MemberRole.MEMBER)
        room = _room([_member(aaron, MemberRole.OWNER), me, _member(seat)], room_type=RoomType.GROUP_DM)
        svc, db = self._svc(_res(me), _res(room))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, shafen.id, metadata={"seat": {"effort": "low"}})
        self.assertEqual(ctx.exception.status_code, 403)
        db.commit.assert_not_awaited()

    async def test_non_owner_human_in_a_private_room_may_set_it(self) -> None:
        # A thread where Aaron is a plain member (the creator owns it) but he
        # is the only human and the seat is his → private → allowed.
        aaron, seat = _human(), _seat()
        me = _member(aaron, MemberRole.MEMBER)
        room = _room([me, _member(seat)])
        svc, db = self._svc(_res(me), _res(room))
        out = await svc.update_room(room.id, aaron.id, metadata={"seat": {"effort": "max"}})
        self.assertEqual(out.metadata_["seat"], {"model": None, "effort": "max"})
        db.commit.assert_awaited_once()

    async def test_someone_elses_seat_makes_it_shared_so_a_member_is_403(self) -> None:
        aaron = _human()
        me = _member(aaron, MemberRole.MEMBER)
        room = _room([me, _member(_seat("flow", owner="shafen"))])
        svc, _db = self._svc(_res(me), _res(room))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, aaron.id, metadata={"seat": {"effort": "max"}})
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_no_runner_seat_is_409_even_for_the_owner(self) -> None:
        aaron = _human()
        me = _member(aaron, MemberRole.OWNER)
        room = _room([me, _member(_brigade())])
        svc, db = self._svc(_res(me), _res(room))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, aaron.id, metadata={"seat": {"effort": "high"}})
        self.assertEqual(ctx.exception.status_code, 409)
        db.commit.assert_not_awaited()

    async def test_non_member_is_403(self) -> None:
        svc, _db = self._svc(_res(None))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(uuid.uuid4(), uuid.uuid4(), metadata={"seat": {"effort": "high"}})
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_seat_with_other_fields_keeps_the_owner_admin_rule(self) -> None:
        aaron, seat = _human(), _seat()
        me = _member(aaron, MemberRole.MEMBER)
        room = _room([me, _member(seat)])
        svc, db = self._svc(_res(me))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(
                room.id, aaron.id, display_name="Renamed", metadata={"seat": {"effort": "low"}}
            )
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("Requires one of roles", ctx.exception.detail)
        db.commit.assert_not_awaited()

    async def test_other_metadata_keys_are_still_dropped_and_need_owner_admin(self) -> None:
        aaron, seat = _human(), _seat()
        me = _member(aaron, MemberRole.OWNER)
        room = _room([me, _member(seat)])
        svc, _db = self._svc(_res(me), _res(room))
        out = await svc.update_room(
            room.id,
            aaron.id,
            metadata={"seat": {"model": "claude-fable-5-1"}, "brigade_agent_id": "evil", "auto_titled": True},
        )
        self.assertEqual(out.metadata_["seat"], {"model": "claude-fable-5-1", "effort": None})
        self.assertNotIn("brigade_agent_id", out.metadata_)
        self.assertTrue(out.metadata_["auto_titled"])
