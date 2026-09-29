"""Nav v3 fix lane 2 — the class and its floor (REVIEW-2.md P1-A, P1-B, P1-C,
P2-1, P2-2, P2-10, P2-11, P2-17; R2 as amended).

Floors are a CACHE of the viewer-independent history verdict: written only
when members + history + seed say shared with nobody asking, never on a
membership removal, never cleared. The asking seat's ownership shapes only
the class returned to it. A thread is judged on its own lines. Stable's own
NULL-sender recording notices are house. Every test here FAILED on 45bfb7f;
the three "mutation-blind" tests pin the query text the earlier tests never
looked at.

Amended in fix lane 3 (REVIEW-3.md P1-2, P2-1..3, P2-6): the floor verdict is
``history_shared`` (what was written; membership and the asker are no longer
inputs), the insert-time rule judges the AUTHOR alone, the history statement
is two index-friendly subplans, and 024 follows Persephone's mapping. The
tests below were updated to that contract; ``test_nav_v3_fix3.py`` holds the
tests that fail on 5ee32e9.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.dialects import postgresql

from app.api import gateway as G
from app.models.participant import ParticipantType
from app.models.room import MemberRole, RoomType
from app.services import room_class as RC

NOW = datetime(2026, 9, 28, 23, 0, tzinfo=timezone.utc)
HUB = RoomType.AGENT_HUB


def _human(username="aaron"):
    return SimpleNamespace(id=uuid.uuid4(), username=username, display_name=username.title(),
                           participant_type=ParticipantType.HUMAN, metadata_={}, avatar_url=None)


async def _stamp_created(obj):
    obj.created_at = NOW


def _seat(agent_id="persephone", owner="aaron", **extra):
    meta = {"backend": "runner", "crew": True}
    if owner is not None:
        meta["owner"] = owner
    meta.update(extra)
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=meta, avatar_url=None)


def _brigade(agent_id="majik", metadata=None):
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=metadata, avatar_url=None)


def _webhook(room_name="hub-fa65c5631810"):
    return SimpleNamespace(id=uuid.uuid4(), username=f"webhook-{room_name}", keycloak_sub=f"webhook:{room_name}",
                           display_name="Forgejo CI", participant_type=ParticipantType.AGENT, metadata_=None, avatar_url=None)


def _members(*participants):
    return [SimpleNamespace(participant=p, participant_id=getattr(p, "id", None), agent_mode=None) for p in participants]


AARON, SHAFEN, PERSEPHONE, FLOW, MAJIK = _human("aaron"), _human("shafenkhan"), _seat(), _seat("flow", ["shafen", "shafenkhan"]), _brigade()


class _Result:
    def __init__(self, *, scalar=None, scalars=None, rows=None, rowcount=1):
        self._scalar, self._scalars, self._rows, self.rowcount = scalar, list(scalars or []), list(rows or []), rowcount

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return SimpleNamespace(all=lambda: list(self._scalars))

    def all(self):
        return list(self._rows)


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect())).lower()


def _floor_updates(db) -> list:
    out = []
    for call in db.execute.await_args_list:
        stmt = call.args[0]
        try:
            sql = _sql(stmt)
        except Exception:
            continue
        if "update rooms" in sql and "metadata" in sql:
            params = stmt.compile(dialect=postgresql.dialect()).params
            if any(v == {"class_floor": "shared"} for v in params.values()):
                out.append(stmt)
    return out


# ---------------------------------------------------------------------------
# P1-A — the floor is the viewer-independent verdict
# ---------------------------------------------------------------------------


class P1_A_FloorIsViewerIndependent(IsolatedAsyncioTestCase):
    def test_the_floor_verdict_leaves_the_asker_out(self) -> None:
        facts = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=FLOW)
        self.assertEqual(facts.room_class, "shared")      # Flow reads it shared (R3)
        self.assertFalse(facts.history_shared)            # nothing written says so
        stand_in = G._asking_seat(None, "ghost")
        facts = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=stand_in)
        self.assertEqual((facts.room_class, facts.history_shared), ("shared", False))
        # P2-17: the stand-in is not counted as an OTHER foreign seat.
        self.assertEqual((facts.own_seats, facts.foreign_seats), (1, 0))
        owner_view = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=PERSEPHONE)
        self.assertEqual((owner_view.room_class, owner_view.history_shared), ("private", False))

    async def test_a_foreign_asker_writes_no_floor(self) -> None:
        room = RC.RoomLite(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE))
        facts = RC.room_class_facts(HUB, room.members, asking_seat=FLOW)
        db = AsyncMock()
        stamped = await RC.apply_class_floors(db, [room], {str(room.id): facts})
        self.assertEqual(stamped, [])
        db.execute.assert_not_awaited()
        self.assertNotIn("class_floor", room.metadata_)

    async def test_classify_for_seat_by_a_stranger_leaves_the_hub_private(self) -> None:
        room = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE))
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalars=["persephone", "flow"]),                   # key agent ids
            _Result(rows=[(room.id, [AARON.id, PERSEPHONE.id], False)]),  # history
            _Result(rows=[]),                                          # no unknown senders
        ])
        db.commit = AsyncMock()
        facts = await G._classify_for_seat(db, room, FLOW, "flow")
        self.assertEqual(facts.room_class, "shared")
        self.assertFalse(facts.history_shared)
        db.commit.assert_not_awaited()
        self.assertEqual(_floor_updates(db), [])
        self.assertNotIn("class_floor", room.metadata_)

    async def test_a_genuinely_shared_history_still_floors(self) -> None:
        mallory = _human("mallory")
        room = RC.RoomLite(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE))
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalars=["persephone"]),
            _Result(rows=[(room.id, [AARON.id, PERSEPHONE.id, mallory.id], False)]),
            _Result(rows=[(mallory.id, mallory.participant_type, mallory.username, None, "Mallory", {}, None)]),
        ])
        facts = (await RC.compute_room_classes(db, [room], asking_seat=PERSEPHONE))[str(room.id)]
        self.assertEqual((facts.room_class, facts.history_shared), ("shared", True))
        self.assertEqual(facts.history_reasons, ("parties",))
        db.execute = AsyncMock(return_value=_Result())
        self.assertEqual(await RC.apply_class_floors(db, [room], {str(room.id): facts}), [room.id])
        self.assertEqual(room.metadata_["class_floor"], "shared")


# ---------------------------------------------------------------------------
# P1-B — removals never floor; no parent clause; recording notices are house
# ---------------------------------------------------------------------------


class P1_B_RemovalsNeverFloorAndThreadsStandAlone(IsolatedAsyncioTestCase):
    def test_a_thread_is_judged_on_its_own_lines(self) -> None:
        # No parent clause any more: the classifier has no such input.
        facts = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=PERSEPHONE)
        self.assertEqual(facts.room_class, "private")
        with self.assertRaises(TypeError):
            RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), parent_class="shared")  # type: ignore[call-arg]

    async def test_compute_never_loads_or_consults_a_parent(self) -> None:
        parent_id = uuid.uuid4()
        thread = RC.RoomLite(id=uuid.uuid4(), room_type=HUB, parent_room_id=parent_id,
                             metadata_={"thread": {"parent_room_id": str(parent_id), "seed_message_id": None}},
                             members=_members(AARON, PERSEPHONE))
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalars=["persephone"]),                             # key ids
            _Result(rows=[(thread.id, [AARON.id, PERSEPHONE.id], False)]),  # history: the thread only
        ])
        facts = (await RC.compute_room_classes(db, [thread], asking_seat=PERSEPHONE))[str(thread.id)]
        self.assertEqual(facts.room_class, "private")
        self.assertEqual(db.execute.await_count, 2)  # no parent load, no parent history
        for call in db.execute.await_args_list:
            params = call.args[0].compile(dialect=postgresql.dialect()).params
            self.assertNotIn(parent_id, list(params.values()) + [x for v in params.values() if isinstance(v, (list, tuple)) for x in v])

    async def test_leave_and_remove_do_not_floor(self) -> None:
        from app.services.room_service import RoomService

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=SimpleNamespace(id=uuid.uuid4()))])
        db.delete = AsyncMock()
        db.commit = AsyncMock()
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        await svc.leave_room(uuid.uuid4(), uuid.uuid4())
        self.assertEqual(_floor_updates(db), [])
        self.assertEqual(db.execute.await_count, 1)

        room_id, actor_id, target_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        actor = SimpleNamespace(role=MemberRole.OWNER, participant_id=actor_id)
        target = SimpleNamespace(role=MemberRole.MEMBER, participant_id=target_id)
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=actor), _Result(scalar=target),
            _Result(scalar=SimpleNamespace(id=room_id, livekit_room_name="stable-x")),
            _Result(scalar=SimpleNamespace(username="majik", id=target_id)),
        ])
        await svc.remove_member(room_id, actor_id, target_id)
        self.assertEqual(_floor_updates(db), [])

    async def test_gateway_leave_and_kick_do_not_floor(self) -> None:
        room = SimpleNamespace(id=uuid.uuid4(), name="crew", livekit_room_name="stable-crew")
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=SimpleNamespace(id=uuid.uuid4())), _Result()])
        db.commit = AsyncMock()
        principal = SimpleNamespace(agent_id="persephone", allowed_rooms=["crew"])
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch.object(G, "clear_relay_pending", new=AsyncMock()):
            await G.gateway_leave_room(room="crew", principal=principal, db=db, livekit=AsyncMock(), redis=AsyncMock())
        self.assertEqual(_floor_updates(db), [])
        db.execute = AsyncMock(side_effect=[_Result(scalar=SimpleNamespace(id=uuid.uuid4())), _Result()])
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch.object(G, "clear_relay_pending", new=AsyncMock()):
            await G.gateway_remove_brigade_agent(room="crew", brigade_agent_id="majik", principal=principal, db=db, livekit=AsyncMock(), redis=AsyncMock())
        self.assertEqual(_floor_updates(db), [])

    def test_recording_notices_are_house_other_null_senders_are_foreign(self) -> None:
        # The history query separates Stable's own SYSTEM notices from any
        # other NULL sender: only the latter is reported as foreign.
        sql = _sql(RC.history_statement([uuid.uuid4()]))
        self.assertIn("exists (select", sql)
        self.assertIn("not coalesce(", sql)               # NULL-safe (REVIEW-3 P2-1)
        self.assertIn("messages.sender_id is null", sql)
        self.assertIn("messages.content_type", sql)
        self.assertIn("messages.metadata ->>", sql)
        # And the classifier: a foreign NULL line is unattributed; none → private.
        self.assertEqual(RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=PERSEPHONE, historical=[None]).room_class, "shared")
        self.assertEqual(RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=PERSEPHONE, historical=[]).room_class, "private")

    async def test_history_rows_with_only_recording_notices_stay_private(self) -> None:
        room = RC.RoomLite(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE))
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalars=["persephone"]),
            _Result(rows=[(room.id, [AARON.id, PERSEPHONE.id], False)]),  # foreign_null False: only recording notices
        ])
        facts = (await RC.compute_room_classes(db, [room], asking_seat=PERSEPHONE))[str(room.id)]
        self.assertEqual(facts.room_class, "private")
        db.execute = AsyncMock(side_effect=[
            _Result(scalars=["persephone"]),
            _Result(rows=[(room.id, [AARON.id, PERSEPHONE.id], True)]),   # a NULL line that is NOT a notice
        ])
        facts = (await RC.compute_room_classes(db, [room], asking_seat=PERSEPHONE))[str(room.id)]
        self.assertEqual(facts.room_class, "shared")
        self.assertIn("unattributed_actor", facts.reasons)


# ---------------------------------------------------------------------------
# P1-C — stale dev-* rows and owned rows are never house
# ---------------------------------------------------------------------------


class P1_C_StaleJwtRowsAreNotHouse(TestCase):
    def test_the_exact_stale_row_shape_is_foreign(self) -> None:
        stale = SimpleNamespace(
            id=uuid.uuid4(), username="agent-dev-shafen-z13", keycloak_sub="brigade:dev-shafen-z13",
            participant_type=ParticipantType.AGENT,
            metadata_={"backend": "brigade", "owner": ["shafen", "shafenkhan"], "crew": True},
        )
        self.assertFalse(RC.is_house_agent(stale, set()))
        facts = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=PERSEPHONE, historical=[stale])
        self.assertEqual(facts.room_class, "shared")
        self.assertIn("foreign_agent", facts.reasons)

    def test_owner_or_dev_namespace_alone_is_enough(self) -> None:
        owned = _brigade("perry", {"backend": "brigade", "owner": "aaron"})
        self.assertFalse(RC.is_house_agent(owned, set()))
        dev = _brigade("dev-aaron", None)
        self.assertFalse(RC.is_house_agent(dev, set()))
        self.assertTrue(RC.is_house_agent(_brigade("majik", None), set()))
        self.assertTrue(RC.is_house_agent(_brigade("majik", {"backend": "brigade", "owner": None}), set()))

    def test_non_object_metadata_is_foreign(self) -> None:
        odd = _brigade("majik", '{"backend": "brigade"}')  # a JSON string, not an object (P2-10)
        self.assertFalse(RC.is_house_agent(odd, set()))
        self.assertFalse(RC.is_runner_seat(odd))
        self.assertEqual(RC.room_class_facts(HUB, _members(AARON, PERSEPHONE, odd), asking_seat=PERSEPHONE).room_class, "shared")

    def test_migration_024_never_stamps_backend_blindly(self) -> None:
        import importlib.util, pathlib

        root = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "024_crew_seat_flags.py"
        spec = importlib.util.spec_from_file_location("m024", root)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        conn = MagicMock()
        with patch.object(mod.op, "get_bind", return_value=conn), patch.object(mod.op, "execute") as op_exec:
            mod.upgrade()
        calls = [(str(c.args[0]), c.args[1] if len(c.args) > 1 else {}) for c in conn.execute.call_args_list]
        # REVIEW-3 P2-6: backend is no longer part of the blanket owner merge,
        # there is no dev-* sweep, and the stamp is guarded by a live key.
        seat_patches = [p["patch"] for s, p in calls if p.get("sub") == "brigade:persephone" and "patch" in p]
        self.assertTrue(seat_patches and all('"backend"' not in patch for patch in seat_patches))
        self.assertEqual([s for s, _p in calls if "brigade:dev-%" in s], [])
        stamps = [(s, p) for s, p in calls if "jsonb_build_object('backend', 'runner')" in s]
        self.assertIn("persephone", {p["agent_id"] for _s, p in stamps})
        self.assertTrue(all("k.revoked_at is null" in s.lower() for s, _p in stamps))
        # P2-13: role_line never overwrites a hand-set value; the rename is marked.
        role_calls = [s for s, p in calls if "role_line" in p.get("patch", "")]
        self.assertTrue(role_calls and all("? 'role_line'" in s for s in role_calls))
        rename = [s for s, _p in calls if "display_name = 'rook'" in s.lower()]
        self.assertTrue(rename and "display_name_by_024" in str([p for s, p in calls if "display_name = 'Rook'" in s]))
        # The history index rides along.
        index_sql = " ".join(str(c.args[0]) for c in op_exec.call_args_list).lower()
        self.assertIn("create index if not exists ix_messages_room_id_sender_id on messages (room_id, sender_id)", index_sql)
        conn.reset_mock()
        with patch.object(mod.op, "get_bind", return_value=conn), patch.object(mod.op, "execute") as op_exec:
            mod.downgrade()
        down = "\n".join(str(c.args[0]) for c in conn.execute.call_args_list)
        self.assertIn("metadata ->> 'display_name_by_024' = 'Rook'", down)
        self.assertIn("metadata ->> 'role_line' = :role", down)
        self.assertIn("drop index if exists ix_messages_room_id_sender_id", " ".join(str(c.args[0]) for c in op_exec.call_args_list).lower())


# ---------------------------------------------------------------------------
# P2-1 / P2-2 — poll ordering, insert-time floors, skipped aggregates
# ---------------------------------------------------------------------------


class P2_PollOrderAndCost(IsolatedAsyncioTestCase):
    async def test_the_poll_classifies_after_reading_the_page(self) -> None:
        room = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, parent_room_id=None, metadata_={})
        order: list[str] = []

        async def get_messages(**_kw):
            order.append("page")
            return {"messages": [], "cursor": None, "has_more": False}

        async def classify(*_a, **_kw):
            order.append("class")
            return RC.RoomClassFacts(room_class="private", humans=1, own_seats=0, foreign_seats=0, guests=0)

        svc = SimpleNamespace(get_messages=get_messages)
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch.object(G, "_seat_agent_mode", new=AsyncMock(return_value="answers_all")), \
             patch.object(G, "_find_seat_participant", new=AsyncMock(return_value=PERSEPHONE)), \
             patch.object(G, "_classify_for_seat", new=classify), \
             patch.object(G, "touch_bridge_seen", new=AsyncMock()), \
             patch.object(G, "clear_relay_pending", new=AsyncMock()), \
             patch.object(G, "_build_message_service", return_value=svc):
            out = await G.gateway_get_messages(room="hub", principal=SimpleNamespace(agent_id="persephone"), db=AsyncMock(), livekit=AsyncMock(), redis=AsyncMock(), cursor=None, limit=50)
        self.assertEqual(order, ["page", "class"])
        self.assertEqual(out.room_class, "private")

    async def test_channels_and_floored_rooms_skip_the_history_aggregate(self) -> None:
        channel = RC.RoomLite(id=uuid.uuid4(), room_type=RoomType.CHANNEL, metadata_={}, members=_members(AARON, SHAFEN, PERSEPHONE))
        floored = RC.RoomLite(id=uuid.uuid4(), room_type=HUB, metadata_={"class_floor": "shared"}, members=_members(AARON, PERSEPHONE))
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[])  # nothing to read: not even the key ids (REVIEW-3 P2-2)
        facts = await RC.compute_room_classes(db, [channel, floored], asking_seat=PERSEPHONE)
        self.assertEqual(db.execute.await_count, 0)
        self.assertEqual(facts[str(channel.id)].room_class, "channel")
        self.assertEqual(facts[str(floored.id)].room_class, "shared")
        self.assertIn("floor", facts[str(floored.id)].reasons)

    async def test_key_ids_are_loaded_once_per_batch(self) -> None:
        a = RC.RoomLite(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE))
        b = RC.RoomLite(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE))
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalars=["persephone"]),
            _Result(rows=[(a.id, [AARON.id], False), (b.id, [AARON.id], False)]),
        ])
        facts = await RC.compute_room_classes(db, [a, b], asking_seat=PERSEPHONE)
        self.assertEqual(db.execute.await_count, 2)
        self.assertEqual({f.room_class for f in facts.values()}, {"private"})

    def test_insert_time_rule(self) -> None:
        # The author alone decides, and only an author that is foreign BY
        # NATURE floors at insert. Two parties writing is the history
        # verdict's business, on the next read (REVIEW-3 P1-2).
        hook = _webhook()
        for author in (AARON, PERSEPHONE, MAJIK, SHAFEN, FLOW, _seat("new", owner=None)):
            self.assertFalse(RC.insert_floors_room(HUB, author), author.username)
        for author in (None, hook, _seat("relay", owner=None, kind="integration"), _seat("visitor", owner=None, kind="guest_agent")):
            self.assertTrue(RC.insert_floors_room(HUB, author), getattr(author, "username", None))
        self.assertFalse(RC.insert_floors_room(RoomType.CHANNEL, hook))
        self.assertFalse(RC.insert_floors_room(HUB, hook, floor="shared"))
        self.assertFalse(hasattr(RC, "insert_makes_room_shared"))

    async def test_a_foreign_line_floors_the_room_at_insert(self) -> None:
        from app.services.message_service import MessageService

        room_id = uuid.uuid4()
        mallory = _webhook()   # foreign by nature: an integration's line
        member_rows = [
            (SimpleNamespace(participant_id=AARON.id, mention_count=0, has_unread_mention=False), AARON),
            (SimpleNamespace(participant_id=PERSEPHONE.id, mention_count=0, has_unread_mention=False), PERSEPHONE),
            (SimpleNamespace(participant_id=mallory.id, mention_count=0, has_unread_mention=False), mallory),
        ]
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=SimpleNamespace(is_muted=False)),          # membership
            _Result(rows=member_rows),                                # members (mentions)
            _Result(scalar=mallory),                                  # sender
            SimpleNamespace(one_or_none=lambda: ("stable-hub", HUB, False, None, {})),  # room row (+metadata)
            _Result(rowcount=1),                                      # floor stamp
        ])
        db.add = MagicMock()
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock(side_effect=_stamp_created)
        svc = MessageService(db=db, livekit=AsyncMock())
        await svc.send_message(room_id=room_id, sender_id=mallory.id, content="hello", content_type="text")
        self.assertEqual(len(_floor_updates(db)), 1)

    async def test_the_owners_own_line_writes_no_floor(self) -> None:
        from app.services.message_service import MessageService

        room_id = uuid.uuid4()
        member_rows = [
            (SimpleNamespace(participant_id=AARON.id, mention_count=0, has_unread_mention=False), AARON),
            (SimpleNamespace(participant_id=PERSEPHONE.id, mention_count=0, has_unread_mention=False), PERSEPHONE),
        ]
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=SimpleNamespace(is_muted=False)),
            _Result(rows=member_rows),
            _Result(scalar=AARON),
            SimpleNamespace(one_or_none=lambda: ("stable-hub", HUB, False, None, {})),
        ])
        db.add = MagicMock()
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock(side_effect=_stamp_created)
        svc = MessageService(db=db, livekit=AsyncMock())
        await svc.send_message(room_id=room_id, sender_id=AARON.id, content="hello", content_type="text")
        self.assertEqual(_floor_updates(db), [])
        self.assertEqual(db.execute.await_count, 4)  # no fifth statement: nothing was stamped

    async def test_a_thread_seed_keeps_its_author_and_floors_only_for_a_foreign_nature(self) -> None:
        from app.services.room_service import RoomService

        parent = SimpleNamespace(id=uuid.uuid4(), name="crew", room_type=RoomType.GROUP_DM, parent_room_id=None,
                                 is_archived=False, metadata_={}, org_id=None, max_participants=50, visibility="public",
                                 recording_policy="off", recording_kind="audio", project_number=None, updated_at=NOW)
        seed = SimpleNamespace(id=uuid.uuid4(), sender_id=SHAFEN.id, sender=SHAFEN, content="ship it", created_at=NOW)
        thread = SimpleNamespace(id=uuid.uuid4(), name="crew-t-1", metadata_={}, parent_room_id=None)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=parent), _Result(scalar=SimpleNamespace()), _Result(scalar=seed),
            _Result(rows=[(SimpleNamespace(agent_mode="answers_all"), PERSEPHONE)]),
        ])
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        svc.create_room = AsyncMock(return_value=thread)
        await svc.create_thread(parent_id=parent.id, creator_id=AARON.id, seed_message_id=seed.id)
        meta = svc.create_room.await_args.kwargs["metadata"]
        # Another human's line: the author is kept, the class is judged on
        # read, and nothing is cached at birth (REVIEW-3 P1-2).
        self.assertNotIn("class_floor", meta)
        self.assertEqual(meta["thread"]["seed_sender_id"], str(SHAFEN.id))
        live = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=PERSEPHONE, has_seed=True, seed_sender=SHAFEN)
        self.assertEqual((live.room_class, live.history_shared), ("shared", False))
        written = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=PERSEPHONE, historical=[AARON],
                                      has_seed=True, seed_sender=SHAFEN)
        self.assertEqual((written.room_class, written.history_shared), ("shared", True))
        # An integration's line as the seed: floored at birth.
        hook = _webhook()
        seed_hook = SimpleNamespace(id=uuid.uuid4(), sender_id=hook.id, sender=hook, content="build failed", created_at=NOW)
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=parent), _Result(scalar=SimpleNamespace()), _Result(scalar=seed_hook),
            _Result(rows=[(SimpleNamespace(agent_mode="answers_all"), PERSEPHONE)]),
        ])
        svc.create_room = AsyncMock(return_value=thread)
        await svc.create_thread(parent_id=parent.id, creator_id=AARON.id, seed_message_id=seed_hook.id)
        self.assertEqual(svc.create_room.await_args.kwargs["metadata"].get("class_floor"), "shared")
        # The owner's own line as the seed: no floor at birth.
        seed_mine = SimpleNamespace(id=uuid.uuid4(), sender_id=AARON.id, sender=AARON, content="mine", created_at=NOW)
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=parent), _Result(scalar=SimpleNamespace()), _Result(scalar=seed_mine),
            _Result(rows=[(SimpleNamespace(agent_mode="answers_all"), PERSEPHONE)]),
        ])
        svc.create_room = AsyncMock(return_value=thread)
        await svc.create_thread(parent_id=parent.id, creator_id=AARON.id, seed_message_id=seed_mine.id)
        self.assertNotIn("class_floor", svc.create_room.await_args.kwargs["metadata"])


# ---------------------------------------------------------------------------
# P2-11 — the floor mirror never schedules an ORM write
# ---------------------------------------------------------------------------


class P2_11_FloorMirrorIsCommittedValue(IsolatedAsyncioTestCase):
    async def test_orm_room_gets_set_committed_value_not_an_assignment(self) -> None:
        from app.models.room import Room

        room = Room(name="hub-x", display_name="x", room_type=HUB, livekit_room_name="stable-hub-x", metadata_={"seats": {"persephone": {"model": None, "effort": "max"}}})
        room.id = uuid.uuid4()
        facts = RC.RoomClassFacts(room_class="shared", humans=2, own_seats=0, foreign_seats=0, guests=0, history_shared=True)
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result())
        from sqlalchemy import inspect as sa_inspect

        state = sa_inspect(room)
        state.committed_state.clear()  # pretend the row was just loaded
        await RC.apply_class_floors(db, [room], {str(room.id): facts})
        self.assertEqual(room.metadata_["class_floor"], "shared")
        self.assertEqual(room.metadata_["seats"]["persephone"]["effort"], "max")
        # No pending ORM change for metadata_: a flush would not rewrite the column.
        self.assertNotIn("metadata_", sa_inspect(room).committed_state)


# ---------------------------------------------------------------------------
# Mutation-blind areas from REVIEW-2 — pinned as query-text tests
# ---------------------------------------------------------------------------


class QueryTextIsPinned(IsolatedAsyncioTestCase):
    def test_history_includes_deleted_lines_and_null_senders(self) -> None:
        sql = _sql(RC.history_statement([uuid.uuid4()]))
        self.assertNotIn("is_deleted", sql)
        self.assertIn("array_agg(distinct messages.sender_id)", sql)
        self.assertIn("messages.sender_id is not null", sql)
        self.assertIn("messages.sender_id is null and not coalesce(", sql)
        self.assertNotIn("group by", sql)                 # per-room subplans, not one big aggregate

    async def test_key_ids_include_revoked_keys(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalars=["persephone"]))
        await RC.load_key_agent_ids(db)
        sql = _sql(db.execute.await_args.args[0])
        self.assertNotIn("revoked_at", sql)
        self.assertIn("distinct agent_gateway_keys.agent_id", sql)

    async def test_owner_present_queries_filter_on_human_participants(self) -> None:
        from app.auth import gateway_auth as GA

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=None))
        await GA.owner_is_room_member(db, ["aaron"], uuid.uuid4())
        sql = _sql(db.execute.await_args.args[0])
        self.assertIn("participants.participant_type = ", sql)
        params = db.execute.await_args.args[0].compile(dialect=postgresql.dialect()).params
        self.assertIn(ParticipantType.HUMAN, list(params.values()))
        self.assertIn("lower(participants.username) in", sql)
        db.execute = AsyncMock(return_value=_Result(scalars=[]))
        await G._rooms_with_owner_present(db, [uuid.uuid4()], ["aaron"])
        sql = _sql(db.execute.await_args.args[0])
        self.assertIn("participants.participant_type = ", sql)
        params = db.execute.await_args.args[0].compile(dialect=postgresql.dialect()).params
        self.assertIn(ParticipantType.HUMAN, list(params.values()))
