"""Nav v3 C2 / R6 — ``metadata.seats`` through ``PATCH /rooms/{id}``.

Per seat, keyed by agent id: ``{"seats": {"<agent_id>": {model, effort}}}``.
Validated first (422), then each entry is allowed only for that seat's
OWNER (``participants.metadata.owner``) whoever owns the room; 409 when the
agent is not a runner seat in the room or the room is archived. A PATCH
that carries anything else keeps the owner/admin rule. The owner-vs-room-
owner cases are pinned in tests/test_nav_v3_fix_lane.py (R6).
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
        keycloak_sub=f"brigade:{agent_id}",
        participant_type=ParticipantType.AGENT,
        metadata_={"backend": "runner", "crew": True, "owner": owner},
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


class SeatsSettingPatch(IsolatedAsyncioTestCase):
    def _svc(self, *results):
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=list(results))
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        return RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock()), db

    async def test_seats_is_client_mutable_and_seat_is_not(self) -> None:
        self.assertIn("seats", CLIENT_MUTABLE_METADATA_KEYS)
        self.assertNotIn("seat", CLIENT_MUTABLE_METADATA_KEYS)

    async def test_owner_sets_the_seat_and_it_is_stored_normalised(self) -> None:
        aaron, seat = _human(), _seat()
        me = _member(aaron, MemberRole.OWNER)
        room = _room([me, _member(seat)])
        svc, db = self._svc(_res(me), _res(room))
        out = await svc.update_room(
            room.id, aaron.id, metadata={"seats": {"persephone": {"model": "claude-opus-5-5", "effort": "medium"}}}
        )
        self.assertEqual(out.metadata_["seats"], {"persephone": {"model": "claude-opus-5-5", "effort": "medium"}})
        # Server-owned keys survive the merge.
        self.assertEqual(out.metadata_["agent_hub"], {"agent_id": "persephone"})
        db.commit.assert_awaited_once()
        # A seats-only PATCH looks the membership up (any role), not the
        # owner/admin ladder — two queries: membership, room.
        self.assertEqual(db.execute.await_count, 2)

    async def test_null_entry_means_back_to_defaults(self) -> None:
        aaron, seat = _human(), _seat()
        me = _member(aaron, MemberRole.OWNER)
        room = _room([me, _member(seat)], metadata={"seats": {"persephone": {"model": "claude-opus-5-5", "effort": "max"}}})
        svc, _db = self._svc(_res(me), _res(room))
        out = await svc.update_room(room.id, aaron.id, metadata={"seats": {"persephone": None}})
        self.assertEqual(out.metadata_["seats"], {"persephone": {"model": None, "effort": None}})

    async def test_bad_effort_is_422_before_any_query(self) -> None:
        aaron = _human()
        svc, db = self._svc()
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(uuid.uuid4(), aaron.id, metadata={"seats": {"persephone": {"effort": "ultra"}}})
        self.assertEqual(ctx.exception.status_code, 422)
        db.execute.assert_not_awaited()

    async def test_bad_model_is_422(self) -> None:
        aaron = _human()
        svc, db = self._svc()
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(uuid.uuid4(), aaron.id, metadata={"seats": {"persephone": {"model": "Claude Opus"}}})
        self.assertEqual(ctx.exception.status_code, 422)
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(uuid.uuid4(), aaron.id, metadata={"seats": "claude-opus-5-5"})
        self.assertEqual(ctx.exception.status_code, 422)
        db.execute.assert_not_awaited()

    async def test_a_plain_member_who_owns_the_seat_may_set_it(self) -> None:
        # A thread where Aaron is a plain member (someone else created it):
        # the seat is his → allowed, whatever the room's class.
        aaron, shafen, seat = _human(), _human("shafenkhan"), _seat()
        me = _member(aaron, MemberRole.MEMBER)
        room = _room([_member(shafen, MemberRole.OWNER), me, _member(seat)], room_type=RoomType.GROUP_DM)
        svc, db = self._svc(_res(me), _res(room))
        out = await svc.update_room(room.id, aaron.id, metadata={"seats": {"persephone": {"effort": "max"}}})
        self.assertEqual(out.metadata_["seats"], {"persephone": {"model": None, "effort": "max"}})
        db.commit.assert_awaited_once()

    async def test_someone_elses_seat_is_403_even_for_the_room_owner(self) -> None:
        aaron = _human()
        me = _member(aaron, MemberRole.OWNER)
        room = _room([me, _member(_seat("flow", owner="shafen"))])
        svc, _db = self._svc(_res(me), _res(room))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, aaron.id, metadata={"seats": {"flow": {"effort": "max"}}})
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_no_such_runner_seat_is_409(self) -> None:
        aaron = _human()
        me = _member(aaron, MemberRole.OWNER)
        room = _room([me])
        svc, db = self._svc(_res(me), _res(room))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, aaron.id, metadata={"seats": {"persephone": {"effort": "high"}}})
        self.assertEqual(ctx.exception.status_code, 409)
        db.commit.assert_not_awaited()

    async def test_non_member_is_403(self) -> None:
        svc, _db = self._svc(_res(None))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(uuid.uuid4(), uuid.uuid4(), metadata={"seats": {"persephone": {"effort": "high"}}})
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_seats_with_other_fields_keeps_the_owner_admin_rule(self) -> None:
        aaron, seat = _human(), _seat()
        me = _member(aaron, MemberRole.MEMBER)
        room = _room([me, _member(seat)])
        svc, db = self._svc(_res(me))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(
                room.id, aaron.id, display_name="Renamed", metadata={"seats": {"persephone": {"effort": "low"}}}
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
            metadata={"seats": {"persephone": {"model": "claude-fable-5-1"}}, "brigade_agent_id": "evil", "auto_titled": True},
        )
        self.assertEqual(out.metadata_["seats"], {"persephone": {"model": "claude-fable-5-1", "effort": None}})
        self.assertNotIn("brigade_agent_id", out.metadata_)
        self.assertTrue(out.metadata_["auto_titled"])
