"""Tests for the archived-rooms listing filter and the RoomUpdate metadata
allowlist.

- list_rooms_for_user(is_archived=...) selects the shelf: default False keeps
  the live sidebar exactly as before (archived excluded); True returns ONLY
  the caller's archived rooms. Same membership scope either way.
- PATCH /rooms/{id} metadata is MERGED into room.metadata_ and restricted to
  CLIENT_MUTABLE_METADATA_KEYS so a client can persist `auto_titled` without
  being able to stomp server-owned wiring (brigade_agent_id, conference).
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock

from sqlalchemy.dialects import postgresql

from app.schemas.room import RoomUpdate
from app.services.room_service import (
    CLIENT_MUTABLE_METADATA_KEYS,
    RoomService,
)


def _compiled(query):
    return query.compile(dialect=postgresql.dialect())


class ListRoomsArchivedFilterTests(IsolatedAsyncioTestCase):
    def _service(self) -> tuple[RoomService, AsyncMock]:
        db = AsyncMock()
        rooms_result = MagicMock()
        rooms_result.scalars.return_value.all.return_value = []
        count_result = MagicMock()
        count_result.scalar.return_value = 0
        db.execute.side_effect = [rooms_result, count_result]
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        return svc, db

    async def test_default_excludes_archived(self) -> None:
        svc, db = self._service()
        out = await svc.list_rooms_for_user(participant_id=uuid.uuid4())
        self.assertEqual(out["rooms"], [])
        # Bool comparisons render as inline literals in the pg dialect.
        sql = str(_compiled(db.execute.call_args_list[0].args[0]))
        self.assertIn("is_archived = false", sql)
        self.assertNotIn("is_archived = true", sql)

    async def test_is_archived_true_selects_only_archived(self) -> None:
        svc, db = self._service()
        await svc.list_rooms_for_user(
            participant_id=uuid.uuid4(), is_archived=True
        )
        sql = str(_compiled(db.execute.call_args_list[0].args[0]))
        self.assertIn("is_archived = true", sql)
        self.assertNotIn("is_archived = false", sql)

    async def test_count_matches_the_same_shelf(self) -> None:
        svc, db = self._service()
        await svc.list_rooms_for_user(
            participant_id=uuid.uuid4(), is_archived=True
        )
        count_sql = str(_compiled(db.execute.call_args_list[1].args[0]))
        self.assertIn("count", count_sql.lower())
        self.assertIn("is_archived = true", count_sql)

    async def test_membership_scope_applies_to_both_shelves(self) -> None:
        # is_archived=true must still be the CALLER's rooms only.
        for flag in (False, True):
            svc, db = self._service()
            await svc.list_rooms_for_user(
                participant_id=uuid.uuid4(), is_archived=flag
            )
            sql = str(_compiled(db.execute.call_args_list[0].args[0]))
            self.assertIn("room_members", sql)
            self.assertIn("participant_id", sql)


class RoomUpdateMetadataAllowlistTests(IsolatedAsyncioTestCase):
    def _service_with_room(self, metadata: dict | None) -> tuple[RoomService, SimpleNamespace]:
        db = AsyncMock()
        room = SimpleNamespace(
            id=uuid.uuid4(),
            display_name="Chat with Majik",
            description=None,
            is_archived=False,
            metadata_=metadata,
        )
        room_result = MagicMock()
        room_result.scalar_one_or_none.return_value = room
        db.execute.return_value = room_result
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        svc._require_role = AsyncMock()  # membership/role is not under test here
        return svc, room

    async def test_allowlisted_key_is_merged_not_replaced(self) -> None:
        svc, room = self._service_with_room(
            {"brigade_agent_id": "majik", "conference": False}
        )
        await svc.update_room(
            room_id=room.id,
            participant_id=uuid.uuid4(),
            display_name="Fix the deploy pipeline",
            metadata={"auto_titled": True},
        )
        self.assertEqual(
            room.metadata_,
            {
                "brigade_agent_id": "majik",
                "conference": False,
                "auto_titled": True,
            },
        )
        self.assertEqual(room.display_name, "Fix the deploy pipeline")

    async def test_server_owned_keys_cannot_be_stomped(self) -> None:
        svc, room = self._service_with_room({"brigade_agent_id": "majik"})
        await svc.update_room(
            room_id=room.id,
            participant_id=uuid.uuid4(),
            metadata={
                "auto_titled": True,
                "brigade_agent_id": "EVIL",
                "conference": True,
                "dm_pair": "x:y",
            },
        )
        self.assertEqual(
            room.metadata_,
            {"brigade_agent_id": "majik", "auto_titled": True},
        )

    async def test_only_disallowed_keys_leaves_metadata_untouched(self) -> None:
        original = {"brigade_agent_id": "majik"}
        svc, room = self._service_with_room(original)
        await svc.update_room(
            room_id=room.id,
            participant_id=uuid.uuid4(),
            metadata={"brigade_agent_id": "EVIL"},
        )
        self.assertIs(room.metadata_, original)  # not even reassigned

    async def test_none_metadata_on_room_starts_fresh_dict(self) -> None:
        svc, room = self._service_with_room(None)
        await svc.update_room(
            room_id=room.id,
            participant_id=uuid.uuid4(),
            metadata={"auto_titled": True},
        )
        self.assertEqual(room.metadata_, {"auto_titled": True})

    async def test_omitted_metadata_keeps_existing_behavior(self) -> None:
        original = {"brigade_agent_id": "majik"}
        svc, room = self._service_with_room(original)
        await svc.update_room(
            room_id=room.id,
            participant_id=uuid.uuid4(),
            display_name="Renamed",
        )
        self.assertIs(room.metadata_, original)


class RoomUpdateSchemaTests(TestCase):
    def test_metadata_optional_and_accepted(self) -> None:
        self.assertIsNone(RoomUpdate().metadata)
        body = RoomUpdate(metadata={"auto_titled": True})
        self.assertEqual(body.metadata, {"auto_titled": True})

    def test_allowlist_contains_auto_titled_and_seat_only(self) -> None:
        # The allowlist is deliberately tiny; growing it is a conscious,
        # reviewed act — this test is the tripwire. ``seat`` joined it with
        # Nav v3 C2 (2026-09-28): the conversation's {model, effort}, which
        # update_room validates and authorises separately (see
        # tests/test_nav_v3_seat_setting.py) rather than merging raw.
        self.assertEqual(CLIENT_MUTABLE_METADATA_KEYS, frozenset({"auto_titled", "seat"}))
