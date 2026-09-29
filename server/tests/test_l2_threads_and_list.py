"""L2 — threads on ANY room + the rooms list (design §3, L2 item 2).

House style: unittest + mocks, no live DB. What is pinned here:

* ``create_thread`` works for all four parent types (dm, group_dm,
  agent_hub, channel incl. project channels) and the thread inherits the
  parent's room_type / visibility / project_number;
* ``seed_message_id`` is quoted as the thread's first SYSTEM entry with
  ``metadata.seed_message_id`` linking back, the parent gets the system line
  "<name> started a thread: <title>", agents keep their agent_mode, humans
  @-mentioned in title/seed (and in the parent) are seeded, others are not;
* GET /rooms default is FLAT — a room the 022 backfill parented is still
  an ordinary row, no ``parent_room_id IS NULL`` filter; ``?view=nested``
  filters the top level and hangs threads under parents with
  ``latest_thread_id``;
* ``join_room`` lets a parent member self-join a (private / hub) thread.
"""

from __future__ import annotations

import typing
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.models.message import ContentType, Message
from app.models.participant import ParticipantType
from app.models.room import MemberRole, RoomMember, RoomType
from app.services.room_service import NESTED_THREADS_PER_PARENT, RoomService, ThreadCreation

NOW = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)


def _res(*, scalar=None, rows=None, scalars=None, scalar_value=None):
    res = MagicMock()
    res.scalar_one_or_none.return_value = scalar
    res.all.return_value = list(rows or [])
    res.scalars.return_value.all.return_value = list(scalars or [])
    res.scalars.return_value.first.return_value = (scalars or [None])[0]
    res.scalar.return_value = scalar_value
    return res


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect())).replace("\n", " ")


def _parent(room_type: RoomType, *, visibility: str = "public", project_number: str | None = None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        name=f"{room_type.value}-room",
        display_name="Parent",
        room_type=room_type,
        visibility=visibility,
        project_number=project_number,
        parent_room_id=None,
        is_archived=False,
        org_id=None,
        max_participants=50,
        metadata_={"brigade_agent_id": "majik", "voice_relay_source": "aaron", "dm_pair": "x:y"},
        recording_policy="on_request",
        recording_kind="audio",
        updated_at=NOW,
    )


def _made_room(parent) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        name=f"{parent.name}-t-abc12345",
        display_name="(set by create_room)",
        room_type=parent.room_type,
        metadata_={},
    )


class CreateThreadOnAnyRoom(IsolatedAsyncioTestCase):
    def _svc(self, parent, *, seed=None, members=(), creator=None):
        db = AsyncMock()
        db.add = MagicMock()
        creator = creator or SimpleNamespace(id=uuid.uuid4(), display_name="Alice", username="alice")
        results = [
            _res(scalar=parent),  # parent
            _res(scalar=SimpleNamespace(role=MemberRole.MEMBER)),  # creator membership
        ]
        if seed is not None:
            results.append(_res(scalar=seed))
        # (Nav v3 fix lane 4: the creator's row is no longer read — the
        # parent's line carries the creator's id, not a name.)
        results.append(_res(rows=list(members)))  # parent roster
        db.execute = AsyncMock(side_effect=results)
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        svc.create_room = AsyncMock(return_value=_made_room(parent))
        return svc, db, creator

    async def test_thread_inherits_type_visibility_and_project_on_all_four_parent_types(self) -> None:
        cases = [
            (RoomType.DM, "public", None),
            (RoomType.GROUP_DM, "public", None),
            (RoomType.AGENT_HUB, "public", None),
            (RoomType.CHANNEL, "private", "P-00115"),
        ]
        for room_type, visibility, project in cases:
            with self.subTest(parent=room_type.value):
                parent = _parent(room_type, visibility=visibility, project_number=project)
                svc, db, creator = self._svc(parent)
                made = await svc.create_thread(parent_id=parent.id, creator_id=creator.id, title="Plan")
                self.assertIsInstance(made, ThreadCreation)
                kwargs = svc.create_room.call_args.kwargs
                self.assertEqual(kwargs["room_type"], room_type.value)
                self.assertEqual(kwargs["display_name"], "Plan")
                self.assertTrue(kwargs["name"].startswith(parent.name + "-t-"))
                # Identity facts stay with the parent; conversation settings inherit.
                self.assertEqual(kwargs["metadata"]["brigade_agent_id"], "majik")
                self.assertEqual(kwargs["metadata"]["voice_relay_source"], "aaron")
                self.assertNotIn("dm_pair", kwargs["metadata"])
                self.assertEqual(kwargs["metadata"]["thread"]["parent_room_id"], str(parent.id))
                self.assertEqual(made.room.parent_room_id, parent.id)
                self.assertEqual(made.room.visibility, visibility)
                self.assertEqual(made.room.project_number, project)
                self.assertEqual(made.room.recording_policy, "on_request")
                db.commit.assert_awaited()

    async def test_seed_is_quoted_first_and_parent_gets_the_system_line(self) -> None:
        parent = _parent(RoomType.CHANNEL)
        seed = SimpleNamespace(
            id=uuid.uuid4(),
            content="@bob can you look at the encoder starvation graph?",
            sender_id=uuid.uuid4(),
            sender=SimpleNamespace(display_name="Aaron", username="aaron"),
            created_at=NOW - timedelta(hours=1),
        )
        svc, db, creator = self._svc(parent, seed=seed)
        made = await svc.create_thread(parent_id=parent.id, creator_id=creator.id, seed_message_id=seed.id)

        added_messages = [a.args[0] for a in db.add.call_args_list if isinstance(a.args[0], Message)]
        self.assertEqual(len(added_messages), 2)
        quote, system_line = added_messages
        # The quote: system-styled, in the THREAD, linking back to the seed.
        self.assertEqual(quote.room_id, made.room.id)
        self.assertEqual(quote.content_type, ContentType.SYSTEM)
        self.assertEqual(quote.content, seed.content)
        self.assertEqual(quote.metadata_["seed_message_id"], str(seed.id))
        self.assertEqual(quote.metadata_["seed_room_id"], str(parent.id))
        self.assertEqual(quote.metadata_["seed_sender_name"], "Aaron")
        self.assertEqual(quote.metadata_["kind"], "thread_seed")
        self.assertIs(made.seed_message, quote)
        # The parent's system line is server-worded (Nav v3 fix lane 4,
        # REVIEW-4 P2-8): the starter and the title ride in metadata.
        self.assertEqual(system_line.room_id, parent.id)
        self.assertEqual(system_line.content_type, ContentType.SYSTEM)
        self.assertEqual(system_line.content, "Channel thread started")
        self.assertEqual(system_line.sender_id, creator.id)
        self.assertEqual(system_line.metadata_["created_by"], str(creator.id))
        self.assertEqual(system_line.metadata_["thread_room_id"], str(made.room.id))
        self.assertEqual(system_line.metadata_["kind"], "thread_started")
        self.assertIs(made.system_message, system_line)
        # No title → titled from the seed (60 chars, ellipsised).
        title = svc.create_room.call_args.kwargs["display_name"]
        self.assertEqual(title, RoomService.thread_title_from_seed(seed.content))
        self.assertLessEqual(len(title), RoomService.THREAD_TITLE_FROM_SEED_CHARS)
        self.assertEqual(system_line.metadata_["thread_title"], title)
        self.assertNotIn(title, system_line.content)
        # The seed_message_id recorded on the thread points at the seed.
        self.assertEqual(svc.create_room.call_args.kwargs["metadata"]["thread"]["seed_message_id"], str(seed.id))

    async def test_agents_keep_their_mode_and_only_mentioned_humans_are_seeded(self) -> None:
        parent = _parent(RoomType.CHANNEL)
        creator = SimpleNamespace(id=uuid.uuid4(), display_name="Alice", username="alice")
        agent = SimpleNamespace(id=uuid.uuid4(), participant_type=ParticipantType.AGENT, username="agent-majik")
        bob = SimpleNamespace(id=uuid.uuid4(), participant_type=ParticipantType.HUMAN, username="bob")
        carol = SimpleNamespace(id=uuid.uuid4(), participant_type=ParticipantType.HUMAN, username="carol")
        members = [
            (SimpleNamespace(agent_mode="when_named"), agent),
            (SimpleNamespace(agent_mode=None), bob),
            (SimpleNamespace(agent_mode=None), carol),
            (SimpleNamespace(agent_mode=None), creator),
        ]
        svc, db, creator = self._svc(parent, members=members, creator=creator)
        made = await svc.create_thread(parent_id=parent.id, creator_id=creator.id, title="@Bob, encoder plan")

        added = [a.args[0] for a in db.add.call_args_list if isinstance(a.args[0], RoomMember)]
        by_pid = {m.participant_id: m for m in added}
        self.assertIn(agent.id, by_pid)
        self.assertEqual(by_pid[agent.id].agent_mode, "when_named")
        self.assertIn(bob.id, by_pid)  # mentioned in the title
        self.assertNotIn(carol.id, by_pid)  # not mentioned
        self.assertNotIn(creator.id, by_pid)  # create_room already made them OWNER
        self.assertEqual(set(made.member_ids), {creator.id, agent.id, bob.id})
        # A new thread is activity on the parent: it floats in the sidebar.
        self.assertGreater(parent.updated_at, NOW)

    async def test_seed_must_live_in_the_parent(self) -> None:
        parent = _parent(RoomType.AGENT_HUB)
        svc, db, creator = self._svc(parent, seed=None)
        db.execute = AsyncMock(side_effect=[
            _res(scalar=parent),
            _res(scalar=SimpleNamespace(role=MemberRole.OWNER)),
            _res(scalar=None),  # seed lookup scoped to parent.id finds nothing
        ])
        with self.assertRaises(HTTPException) as ctx:
            await svc.create_thread(parent_id=parent.id, creator_id=creator.id, seed_message_id=uuid.uuid4())
        self.assertEqual(ctx.exception.status_code, 404)
        seed_sql = _sql(db.execute.call_args_list[2].args[0])
        self.assertIn("messages.room_id = ", seed_sql)
        self.assertIn("messages.is_deleted = false", seed_sql)

    async def test_non_member_and_nested_and_archived_parents_are_refused(self) -> None:
        parent = _parent(RoomType.GROUP_DM)
        svc, db, creator = self._svc(parent)
        db.execute = AsyncMock(side_effect=[_res(scalar=parent), _res(scalar=None)])
        with self.assertRaises(HTTPException) as ctx:
            await svc.create_thread(parent_id=parent.id, creator_id=creator.id, title="x")
        self.assertEqual(ctx.exception.status_code, 403)

        nested = _parent(RoomType.CHANNEL)
        nested.parent_room_id = uuid.uuid4()
        db.execute = AsyncMock(side_effect=[_res(scalar=nested), _res(scalar=SimpleNamespace())])
        with self.assertRaises(HTTPException) as ctx:
            await svc.create_thread(parent_id=nested.id, creator_id=creator.id, title="x")
        self.assertEqual(ctx.exception.status_code, 409)

        archived = _parent(RoomType.DM)
        archived.is_archived = True
        db.execute = AsyncMock(side_effect=[_res(scalar=archived), _res(scalar=SimpleNamespace())])
        with self.assertRaises(HTTPException) as ctx:
            await svc.create_thread(parent_id=archived.id, creator_id=creator.id, title="x")
        self.assertEqual(ctx.exception.status_code, 403)

    def test_thread_title_from_seed_is_bounded(self) -> None:
        self.assertEqual(RoomService.thread_title_from_seed("  short   title "), "short title")
        long = "word " * 40
        title = RoomService.thread_title_from_seed(long)
        self.assertEqual(len(title), RoomService.THREAD_TITLE_FROM_SEED_CHARS)
        self.assertTrue(title.endswith("…"))


# ---------------------------------------------------------------------------
# GET /rooms: flat by default, nested on request
# ---------------------------------------------------------------------------


def _room_row(**over):
    base = dict(
        id=uuid.uuid4(),
        parent_room_id=None,
        room_type=RoomType.DM,
        created_by=None,
        updated_at=NOW,
        created_at=NOW - timedelta(days=1),
        members=[],
    )
    base.update(over)
    return SimpleNamespace(**base)


class RoomsListFlatByDefault(IsolatedAsyncioTestCase):
    def _svc(self, results):
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=results)
        presence = AsyncMock()
        presence.get_online_in_room = AsyncMock(return_value=set())
        return RoomService(db=db, livekit=AsyncMock(), presence=presence), db

    async def test_default_view_has_no_parent_filter_and_the_same_two_queries(self) -> None:
        svc, db = self._svc([_res(scalars=[]), _res(scalar_value=0)])
        out = await svc.list_rooms_for_user(participant_id=uuid.uuid4())
        self.assertEqual(out["rooms"], [])
        self.assertEqual(db.execute.await_count, 2)
        page_sql = _sql(db.execute.call_args_list[0].args[0])
        count_sql = _sql(db.execute.call_args_list[1].args[0])
        self.assertNotIn("parent_room_id IS NULL", page_sql)
        self.assertNotIn("parent_room_id IS NULL", count_sql)

    async def test_nested_view_filters_the_top_level(self) -> None:
        svc, db = self._svc([_res(scalars=[]), _res(scalar_value=0)])
        await svc.list_rooms_for_user(participant_id=uuid.uuid4(), nested=True)
        self.assertEqual(db.execute.await_count, 2)
        self.assertIn("parent_room_id IS NULL", _sql(db.execute.call_args_list[0].args[0]))
        self.assertIn("parent_room_id IS NULL", _sql(db.execute.call_args_list[1].args[0]))

    async def test_a_backfilled_agent_chat_is_still_listed_by_default(self) -> None:
        """022 parents every old 'Chat with Majik' room under a hub. The
        default list must keep showing it as an ordinary row (with
        parent_room_id set) so today's web client loses nothing."""
        me = uuid.uuid4()
        hub_id = uuid.uuid4()
        old_chat = _room_row(parent_room_id=hub_id, room_type=RoomType.DM)
        svc, db = self._svc([
            _res(scalars=[old_chat]),          # page
            _res(scalar_value=1),              # count
            _res(scalars=[]),                  # latest message batch
            _res(rows=[]),                     # unread batch
            _res(rows=[(old_chat.id, 0, False)]),  # caller's memberships
            _res(rows=[]),                     # extras: thread counts
            _res(rows=[]),                     # extras: members
            _res(scalar_value=1),              # member count
        ])
        out = await svc.list_rooms_for_user(participant_id=me)
        self.assertEqual(len(out["rooms"]), 1)
        entry = out["rooms"][0]
        self.assertIs(entry["room"], old_chat)
        self.assertEqual(entry["room"].parent_room_id, hub_id)
        # Additive fields only, at their neutral defaults.
        self.assertEqual(entry["threads"], [])
        self.assertIsNone(entry["latest_thread_id"])
        self.assertTrue(entry["is_member"])
        self.assertEqual(out["total"], 1)
        # Exactly today's query set — page, count, three batches, two extras,
        # one member count. The nested view's thread fetch never ran.
        self.assertEqual(db.execute.await_count, 8)
        for call in db.execute.call_args_list:
            sql = _sql(call.args[0])
            self.assertFalse("rooms.parent_room_id IN" in sql and "ORDER BY rooms.updated_at" in sql, sql)

    async def test_nested_view_hangs_threads_under_parents_with_latest_first(self) -> None:
        me = uuid.uuid4()
        hub = _room_row(room_type=RoomType.AGENT_HUB)
        older = _room_row(parent_room_id=hub.id, room_type=RoomType.AGENT_HUB, updated_at=NOW - timedelta(days=3))
        newer = _room_row(parent_room_id=hub.id, room_type=RoomType.AGENT_HUB, updated_at=NOW - timedelta(days=2))
        foreign = _room_row(parent_room_id=hub.id, room_type=RoomType.AGENT_HUB, updated_at=NOW - timedelta(days=9))
        last_msg = SimpleNamespace(room_id=older.id, created_at=NOW - timedelta(hours=1))
        svc, db = self._svc([
            _res(scalars=[hub]),                                  # page (parents only)
            _res(scalar_value=1),                                 # count
            _res(scalars=[newer, older, foreign]),                # threads under the page
            _res(scalars=[last_msg]),                             # latest message batch
            _res(rows=[(older.id, 4)]),                           # unread batch
            _res(rows=[(hub.id, 0, False), (older.id, 1, True), (newer.id, 0, False)]),  # memberships
            _res(rows=[(hub.id, 3)]),                             # extras: thread counts
            _res(rows=[]),                                        # extras: members
            _res(scalar_value=2),                                 # member count (hub)
        ])
        out = await svc.list_rooms_for_user(participant_id=me, nested=True)
        entry = out["rooms"][0]
        self.assertIs(entry["room"], hub)
        self.assertEqual(entry["thread_count"], 3)
        nested_ids = [t["room"].id for t in entry["threads"]]
        # Activity order: older has the newest MESSAGE, so it leads.
        self.assertEqual(nested_ids, [older.id, newer.id, foreign.id])
        self.assertEqual(entry["latest_thread_id"], older.id)
        by_id = {t["room"].id: t for t in entry["threads"]}
        self.assertEqual(by_id[older.id]["unread_count"], 4)
        self.assertTrue(by_id[older.id]["has_unread_mention"])
        self.assertTrue(by_id[older.id]["is_member"])
        self.assertFalse(by_id[foreign.id]["is_member"])  # someone else's thread
        self.assertEqual(by_id[foreign.id]["unread_count"], 0)
        self.assertIs(by_id[older.id]["last_message"], last_msg)
        thread_sql = _sql(db.execute.call_args_list[2].args[0])
        self.assertIn("rooms.parent_room_id IN", thread_sql)
        self.assertIn("rooms.is_archived = false", thread_sql)

    def test_nested_cap_is_bounded(self) -> None:
        self.assertGreaterEqual(NESTED_THREADS_PER_PARENT, 10)
        self.assertLessEqual(NESTED_THREADS_PER_PARENT, 100)


class RoomsListRouteShape(unittest.TestCase):
    def test_view_param_defaults_to_flat(self) -> None:
        from app.api.rooms import list_rooms

        hints = typing.get_type_hints(list_rooms, include_extras=True)
        self.assertEqual(typing.get_args(hints["view"]), ("flat", "nested"))
        import inspect

        self.assertEqual(inspect.signature(list_rooms).parameters["view"].default.default, "flat")

    def test_room_response_has_additive_nesting_fields(self) -> None:
        from app.schemas.room import RoomResponse

        fields = RoomResponse.model_fields
        self.assertIn("threads", fields)
        self.assertIn("latest_thread_id", fields)
        self.assertIn("is_member", fields)
        self.assertEqual(fields["is_member"].default, True)
        self.assertIsNone(fields["latest_thread_id"].default)

    def test_entry_serializer_nests_recursively(self) -> None:
        from app.api.rooms import _room_entry_to_response

        def room(**over):
            base = dict(
                id=uuid.uuid4(), name="r", display_name="R", description=None,
                room_type=RoomType.CHANNEL, livekit_room_name="stable-r", livekit_sid=None,
                max_participants=50, metadata_={}, is_archived=False, created_by=None,
                created_at=NOW, updated_at=NOW, parent_room_id=None, visibility="public",
                project_number=None, recording_policy="off", recording_kind="audio",
            )
            base.update(over)
            return SimpleNamespace(**base)

        parent = room()
        thread = room(parent_room_id=parent.id, name="r-t-1")
        out = _room_entry_to_response({
            "room": parent, "member_count": 2, "online_count": 0,
            "threads": [{"room": thread, "member_count": 1, "is_member": False}],
            "latest_thread_id": thread.id, "thread_count": 1,
        })
        self.assertEqual(out.latest_thread_id, thread.id)
        self.assertEqual(len(out.threads), 1)
        self.assertEqual(out.threads[0].parent_room_id, parent.id)
        self.assertFalse(out.threads[0].is_member)
        self.assertTrue(out.is_member)


# ---------------------------------------------------------------------------
# Opening a thread: a parent member may self-join it
# ---------------------------------------------------------------------------


class JoinThreadAsParentMember(IsolatedAsyncioTestCase):
    def _thread(self, room_type: RoomType, visibility: str):
        return SimpleNamespace(
            id=uuid.uuid4(),
            room_type=room_type,
            visibility=visibility,
            parent_room_id=uuid.uuid4(),
            is_archived=False,
            org_id=None,
            max_participants=50,
        )

    async def test_parent_member_joins_a_private_or_hub_thread(self) -> None:
        for room_type, visibility in ((RoomType.CHANNEL, "private"), (RoomType.AGENT_HUB, "public"), (RoomType.DM, "public")):
            with self.subTest(room_type=room_type.value, visibility=visibility):
                thread = self._thread(room_type, visibility)
                db = AsyncMock()
                db.add = MagicMock()
                db.execute = AsyncMock(side_effect=[
                    _res(scalar=thread),                      # room
                    _res(scalar=SimpleNamespace(role=MemberRole.MEMBER)),  # parent membership
                    _res(scalar=None),                        # not already a member
                    _res(scalar_value=2),                     # capacity
                ])
                svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
                membership = await svc.join_room(room_id=thread.id, participant_id=uuid.uuid4(), self_join=True)
                self.assertIsNotNone(membership)
                db.add.assert_called_once()

    async def test_non_member_of_the_parent_gets_the_uniform_403(self) -> None:
        thread = self._thread(RoomType.CHANNEL, "private")
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=thread), _res(scalar=None)])
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        with self.assertRaises(HTTPException) as ctx:
            await svc.join_room(room_id=thread.id, participant_id=uuid.uuid4(), self_join=True)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(ctx.exception.detail, "This room is invite-only")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
