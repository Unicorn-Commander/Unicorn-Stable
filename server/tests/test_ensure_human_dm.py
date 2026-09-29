"""Tests for idempotent ensureHumanDm (RoomService + pure helpers)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.models.participant import ParticipantType
from app.models.room import RoomType
from app.services.room_service import (
    RoomService,
    dm_pair_key,
    dm_room_slug,
)


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class DmPairHelpersTests(IsolatedAsyncioTestCase):
    def test_pair_key_is_order_independent(self) -> None:
        a, b = _uuid(), _uuid()
        self.assertEqual(dm_pair_key(a, b), dm_pair_key(b, a))
        left, right = sorted((str(a), str(b)))
        self.assertEqual(dm_pair_key(a, b), f"{left}:{right}")

    def test_slug_is_stable_and_under_name_limit(self) -> None:
        a = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        b = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        key = dm_pair_key(a, b)
        slug = dm_room_slug(key)
        self.assertTrue(slug.startswith("dm-"))
        self.assertLessEqual(len(slug), 100)
        self.assertEqual(slug, dm_room_slug(dm_pair_key(b, a)))


class EnsureHumanDmServiceTests(IsolatedAsyncioTestCase):
    def _service(self) -> tuple[RoomService, AsyncMock, AsyncMock]:
        db = AsyncMock()
        livekit = AsyncMock()
        presence = AsyncMock()
        svc = RoomService(db=db, livekit=livekit, presence=presence)
        return svc, db, livekit

    def _target(
        self,
        pid: uuid.UUID,
        *,
        ptype: ParticipantType = ParticipantType.HUMAN,
        name: str = "bob",
    ) -> SimpleNamespace:
        return SimpleNamespace(
            id=pid,
            participant_type=ptype,
            display_name=name.title(),
            username=name,
        )

    def _room(
        self,
        room_id: uuid.UUID,
        *,
        pair_key: str | None = None,
        name: str | None = None,
        brigade_agent_id: str | None = None,
    ) -> SimpleNamespace:
        meta: dict = {}
        if pair_key:
            meta["dm_pair"] = pair_key
        if brigade_agent_id:
            meta["brigade_agent_id"] = brigade_agent_id
        return SimpleNamespace(
            id=room_id,
            name=name or "dm-existing",
            display_name="DM with Bob",
            description=None,
            room_type=RoomType.DM,
            livekit_room_name="stable-dm-existing",
            livekit_sid="LK_1",
            max_participants=2,
            metadata_=meta,
            is_archived=False,
            created_by=None,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
            org_id=None,
        )

    async def test_rejects_self(self) -> None:
        svc, _db, _lk = self._service()
        me = _uuid()
        with self.assertRaises(HTTPException) as ctx:
            await svc.ensure_human_dm(caller_id=me, target_id=me)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("yourself", ctx.exception.detail)

    async def test_rejects_missing_user(self) -> None:
        svc, db, _lk = self._service()
        # target lookup → None
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(return_value=result)

        with self.assertRaises(HTTPException) as ctx:
            await svc.ensure_human_dm(caller_id=_uuid(), target_id=_uuid())
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_rejects_agent_target(self) -> None:
        svc, db, _lk = self._service()
        agent_id = _uuid()
        result = MagicMock()
        result.scalar_one_or_none.return_value = self._target(
            agent_id, ptype=ParticipantType.AGENT, name="majik"
        )
        db.execute = AsyncMock(return_value=result)

        with self.assertRaises(HTTPException) as ctx:
            await svc.ensure_human_dm(caller_id=_uuid(), target_id=agent_id)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("human", ctx.exception.detail.lower())

    async def test_returns_existing_room_without_create(self) -> None:
        svc, db, livekit = self._service()
        caller, target = _uuid(), _uuid()
        pair = dm_pair_key(caller, target)
        existing_id = _uuid()
        existing = self._room(existing_id, pair_key=pair, name=dm_room_slug(pair))

        target_row = MagicMock()
        target_row.scalar_one_or_none.return_value = self._target(target)

        lock_row = MagicMock()
        find_row = MagicMock()
        find_row.scalar_one_or_none.return_value = existing
        members_row = MagicMock()
        members_row.all.return_value = [
            (SimpleNamespace(participant_id=caller), SimpleNamespace(id=caller, participant_type=ParticipantType.HUMAN, username="me")),
            (SimpleNamespace(participant_id=target), SimpleNamespace(id=target, participant_type=ParticipantType.HUMAN, username="bob")),
        ]

        # execute order: target select, advisory lock, _find (by_pair hit),
        # canonical membership verification
        db.execute = AsyncMock(side_effect=[target_row, lock_row, find_row, members_row])
        # backfill short-circuits when pair already set
        db.commit = AsyncMock()

        room, created = await svc.ensure_human_dm(
            caller_id=caller, target_id=target
        )
        self.assertFalse(created)
        self.assertEqual(room.id, existing_id)
        livekit.create_room.assert_not_awaited()
        db.add.assert_not_called()

    async def test_creates_when_missing(self) -> None:
        svc, db, livekit = self._service()
        caller, target = _uuid(), _uuid()
        pair = dm_pair_key(caller, target)
        slug = dm_room_slug(pair)

        target_row = MagicMock()
        target_row.scalar_one_or_none.return_value = self._target(target)

        lock_row = MagicMock()
        # _find_human_dm: by_pair, by_name, legacy — all miss
        miss = MagicMock()
        miss.scalar_one_or_none.return_value = None

        db.execute = AsyncMock(
            side_effect=[
                target_row,
                lock_row,
                miss,  # by_pair
                miss,  # by_name
                miss,  # legacy
            ]
        )
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        db.add = MagicMock()

        livekit.create_room = AsyncMock(
            return_value=SimpleNamespace(sid="LK_NEW")
        )

        # Capture the Room object added so we can verify fields.
        added: list[object] = []

        def _add(obj: object) -> None:
            added.append(obj)
            # Simulate ORM assigning a primary key on flush for Room-like objs.
            if hasattr(obj, "name") and getattr(obj, "id", None) is None:
                obj.id = _uuid()  # type: ignore[attr-defined]

        db.add = MagicMock(side_effect=_add)

        room, created = await svc.ensure_human_dm(
            caller_id=caller, target_id=target, org_id=None
        )
        self.assertTrue(created)
        self.assertEqual(room.name, slug)
        self.assertEqual(room.room_type, RoomType.DM)
        self.assertEqual((room.metadata_ or {}).get("dm_pair"), pair)
        livekit.create_room.assert_awaited_once()
        # Room + caller membership + target membership
        self.assertEqual(len(added), 3)
        db.commit.assert_awaited()

    async def test_sequential_double_ensure_returns_same_room(self) -> None:
        """Second call hits find path — same room id, created=False."""
        svc, db, livekit = self._service()
        caller, target = _uuid(), _uuid()
        pair = dm_pair_key(caller, target)
        room_id = _uuid()
        stored = self._room(room_id, pair_key=pair, name=dm_room_slug(pair))

        # First call: miss then create
        target_row = MagicMock()
        target_row.scalar_one_or_none.return_value = self._target(target)
        miss = MagicMock()
        miss.scalar_one_or_none.return_value = None
        lock_row = MagicMock()
        hit = MagicMock()
        hit.scalar_one_or_none.return_value = stored

        # Call 1 executes: target, lock, 3× find miss, then create path
        # Call 2 executes: target, lock, find hit
        members_row = MagicMock()
        members_row.all.return_value = [
            (SimpleNamespace(participant_id=caller), SimpleNamespace(id=caller, participant_type=ParticipantType.HUMAN, username="me")),
            (SimpleNamespace(participant_id=target), SimpleNamespace(id=target, participant_type=ParticipantType.HUMAN, username="bob")),
        ]
        call1 = [target_row, lock_row, miss, miss, miss]
        call2 = [target_row, lock_row, hit, members_row]
        db.execute = AsyncMock(side_effect=call1 + call2)
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()

        def _add(obj: object) -> None:
            if hasattr(obj, "name") and getattr(obj, "id", None) is None:
                obj.id = room_id  # type: ignore[attr-defined]
                obj.metadata_ = {"dm_pair": pair}  # type: ignore[attr-defined]

        db.add = MagicMock(side_effect=_add)
        livekit.create_room = AsyncMock(
            return_value=SimpleNamespace(sid="LK")
        )

        room1, created1 = await svc.ensure_human_dm(caller, target)
        room2, created2 = await svc.ensure_human_dm(caller, target)

        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertEqual(room1.id, room2.id)
        self.assertEqual(livekit.create_room.await_count, 1)


class ReclaimCanonicalDmTests(IsolatedAsyncioTestCase):
    """The 2026-08-27 wedge: a room holding the canonical pair key/slug was
    agent-tainted (bridge wrote the membership straight into the DB), _find
    refused to return it, creation conflicted on the unique name, and every
    "Message" click 409'd. Reclaim repairs the room in place instead."""

    def _service(self) -> tuple[RoomService, AsyncMock]:
        db = AsyncMock()
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        return svc, db

    @staticmethod
    def _member_row(pid: uuid.UUID, ptype: ParticipantType, name: str):
        member = SimpleNamespace(participant_id=pid, room_id=None)
        participant = SimpleNamespace(
            id=pid, participant_type=ptype, username=name
        )
        return member, participant

    def _tainted_room(
        self, pair: str, slug: str, *, archived: bool = False
    ) -> SimpleNamespace:
        return SimpleNamespace(
            id=_uuid(),
            name=slug,
            room_type=RoomType.DM,
            is_archived=archived,
            metadata_={"dm_pair": pair, "brigade_agent_id": "claude-code"},
        )

    async def test_ensure_returns_reclaimed_tainted_room(self) -> None:
        """Agent member + agent bind on the canonical DM → healed, returned."""
        svc, db = self._service()
        caller, target = _uuid(), _uuid()
        pair = dm_pair_key(caller, target)
        slug = dm_room_slug(pair)
        room = self._tainted_room(pair, slug)

        target_row = MagicMock()
        target_row.scalar_one_or_none.return_value = SimpleNamespace(
            id=target,
            participant_type=ParticipantType.HUMAN,
            display_name="Bob",
            username="bob",
        )
        lock_row = MagicMock()
        by_pair_hit = MagicMock()
        by_pair_hit.scalar_one_or_none.return_value = room

        agent_member, agent_p = self._member_row(
            _uuid(), ParticipantType.AGENT, "agent-claude-code"
        )
        members_res = MagicMock()
        members_res.all.return_value = [
            self._member_row(caller, ParticipantType.HUMAN, "aaron"),
            self._member_row(target, ParticipantType.HUMAN, "bob"),
            (agent_member, agent_p),
        ]

        # target select, advisory lock, by_pair, reclaim member rows
        db.execute = AsyncMock(
            # + the class_floor stamp (Nav v3 R2: a membership removal floors
            # the room's class) that the reclaim's agent-row deletes trigger.
            side_effect=[target_row, lock_row, by_pair_hit, members_res, MagicMock()]
        )
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        db.delete = AsyncMock()

        got, created = await svc.ensure_human_dm(caller_id=caller, target_id=target)

        self.assertFalse(created)
        self.assertIs(got, room)
        db.delete.assert_awaited_once_with(agent_member)
        self.assertNotIn("brigade_agent_id", room.metadata_)
        self.assertEqual(room.metadata_.get("dm_pair"), pair)
        self.assertFalse(room.is_archived)

    async def test_ensure_strips_member_only_taint(self) -> None:
        """The live-fire gap: agent member row, CLEAN metadata. The metadata
        gate alone accepted such a room and left the agent inside — membership
        must be verified (and healed) on every canonical hit."""
        svc, db = self._service()
        caller, target = _uuid(), _uuid()
        pair = dm_pair_key(caller, target)
        room = SimpleNamespace(
            id=_uuid(),
            name=dm_room_slug(pair),
            room_type=RoomType.DM,
            is_archived=False,
            metadata_={"dm_pair": pair},
        )
        target_row = MagicMock()
        target_row.scalar_one_or_none.return_value = SimpleNamespace(
            id=target,
            participant_type=ParticipantType.HUMAN,
            display_name="Bob",
            username="bob",
        )
        lock_row = MagicMock()
        by_pair_hit = MagicMock()
        by_pair_hit.scalar_one_or_none.return_value = room
        agent_member, agent_p = self._member_row(
            _uuid(), ParticipantType.AGENT, "agent-claude-code"
        )
        members_res = MagicMock()
        members_res.all.return_value = [
            self._member_row(caller, ParticipantType.HUMAN, "aaron"),
            self._member_row(target, ParticipantType.HUMAN, "bob"),
            (agent_member, agent_p),
        ]
        db.execute = AsyncMock(
            # + the class_floor stamp (Nav v3 R2: a membership removal floors
            # the room's class) that the reclaim's agent-row deletes trigger.
            side_effect=[target_row, lock_row, by_pair_hit, members_res, MagicMock()]
        )
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        db.delete = AsyncMock()

        got, created = await svc.ensure_human_dm(caller_id=caller, target_id=target)

        self.assertFalse(created)
        self.assertIs(got, room)
        db.delete.assert_awaited_once_with(agent_member)
        db.commit.assert_awaited()

    async def test_reclaim_unarchives_clean_archived_dm(self) -> None:
        """Opening a DM with someone reopens the archived room, not a 409."""
        svc, db = self._service()
        caller, target = _uuid(), _uuid()
        pair = dm_pair_key(caller, target)
        room = SimpleNamespace(
            id=_uuid(),
            name=dm_room_slug(pair),
            room_type=RoomType.DM,
            is_archived=True,
            metadata_={"dm_pair": pair},
        )
        members_res = MagicMock()
        members_res.all.return_value = [
            self._member_row(caller, ParticipantType.HUMAN, "aaron"),
            self._member_row(target, ParticipantType.HUMAN, "bob"),
        ]
        db.execute = AsyncMock(return_value=members_res)
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        db.delete = AsyncMock()

        got = await svc._verify_or_reclaim_canonical_dm(room, caller, target)

        self.assertIs(got, room)
        self.assertFalse(room.is_archived)
        db.delete.assert_not_awaited()

    async def test_reclaim_refuses_promoted_group(self) -> None:
        """A dm promoted to group_dm is not this pair's DM — never touched."""
        svc, db = self._service()
        room = SimpleNamespace(
            id=_uuid(),
            room_type=RoomType.GROUP_DM,
            is_archived=False,
            metadata_={},
        )
        db.execute = AsyncMock()
        got = await svc._verify_or_reclaim_canonical_dm(room, _uuid(), _uuid())
        self.assertIsNone(got)
        db.execute.assert_not_awaited()

    async def test_reclaim_refuses_mismatched_humans(self) -> None:
        """Humans other than the pair in the slug room → hands off entirely."""
        svc, db = self._service()
        caller, target = _uuid(), _uuid()
        room = SimpleNamespace(
            id=_uuid(),
            room_type=RoomType.DM,
            is_archived=False,
            metadata_={"brigade_agent_id": "perry"},
        )
        members_res = MagicMock()
        members_res.all.return_value = [
            self._member_row(caller, ParticipantType.HUMAN, "aaron"),
            self._member_row(_uuid(), ParticipantType.HUMAN, "someone-else"),
        ]
        db.execute = AsyncMock(return_value=members_res)
        db.delete = AsyncMock()
        db.commit = AsyncMock()

        got = await svc._verify_or_reclaim_canonical_dm(room, caller, target)

        self.assertIsNone(got)
        db.delete.assert_not_awaited()
        db.commit.assert_not_awaited()
        self.assertEqual(room.metadata_.get("brigade_agent_id"), "perry")


class EnsureHumanDmSchemaTests(IsolatedAsyncioTestCase):
    def test_ensure_body_requires_participant_id(self) -> None:
        from app.schemas.room import EnsureHumanDmBody

        pid = _uuid()
        body = EnsureHumanDmBody(participant_id=pid)
        self.assertEqual(body.participant_id, pid)

    def test_ensure_response_includes_created_flag(self) -> None:
        from app.schemas.room import EnsureHumanDmResponse

        now = datetime.now(timezone.utc)
        resp = EnsureHumanDmResponse(
            id=_uuid(),
            name="dm-a-b",
            display_name="DM with Bob",
            description=None,
            room_type="dm",
            livekit_room_name="stable-dm-a-b",
            livekit_sid=None,
            max_participants=2,
            is_archived=False,
            created_by=None,
            created_at=now,
            updated_at=now,
            member_count=2,
            created=True,
        )
        self.assertTrue(resp.created)
        self.assertEqual(resp.room_type, "dm")


class PureHumanDmRoomTests(IsolatedAsyncioTestCase):
    def test_rejects_brigade_agent_metadata(self) -> None:
        room = SimpleNamespace(
            room_type=RoomType.DM,
            is_archived=False,
            metadata_={"brigade_agent_id": "perry", "dm_pair": "a:b"},
        )
        self.assertFalse(RoomService._is_pure_human_dm_room(room))  # type: ignore[arg-type]

    def test_rejects_multi_agent_residency_list(self) -> None:
        room = SimpleNamespace(
            room_type=RoomType.DM,
            is_archived=False,
            metadata_={"brigade_agent_ids": ["perry", "majik"], "dm_pair": "a:b"},
        )
        self.assertFalse(RoomService._is_pure_human_dm_room(room))  # type: ignore[arg-type]

    def test_accepts_clean_human_dm(self) -> None:
        room = SimpleNamespace(
            room_type=RoomType.DM,
            is_archived=False,
            metadata_={"dm_pair": "a:b"},
        )
        self.assertTrue(RoomService._is_pure_human_dm_room(room))  # type: ignore[arg-type]

    def test_accepts_empty_metadata(self) -> None:
        room = SimpleNamespace(
            room_type=RoomType.DM,
            is_archived=False,
            metadata_={},
        )
        self.assertTrue(RoomService._is_pure_human_dm_room(room))  # type: ignore[arg-type]
