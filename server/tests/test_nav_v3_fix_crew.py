"""Nav v3 fix lane — the crew (REVIEW.md P1-3/R7, P1-4/R8, P1-5/R10, P2 crew
items): the caller's own hub, presence from the gateway / roster, the R1
house allowlist, migration 024, the picker fallback, role lines with a
budget. Every test here FAILED on 3111bfe.
"""

from __future__ import annotations

import asyncio
import importlib.util
import pathlib
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from app.api import gateway as G
from app.auth import gateway_auth as GA
from app.models.participant import ParticipantType
from app.models.room import MemberRole, RoomType
from app.services import crew as C
from app.services import room_class as RC

NOW = datetime(2026, 9, 28, 22, 0, tzinfo=timezone.utc)
AGENT_HUB = RoomType.AGENT_HUB


# ---------------------------------------------------------------------------
# Realistic row shapes
# ---------------------------------------------------------------------------


def _human(username="aaron"):
    return SimpleNamespace(
        id=uuid.uuid4(), username=username, participant_type=ParticipantType.HUMAN, metadata_={}
    )


def _guest():
    return SimpleNamespace(
        id=uuid.uuid4(), username="guest-7f3a", participant_type=ParticipantType.GUEST, metadata_={}
    )


def _seat(agent_id="persephone", owner="aaron", **extra):
    meta = {"backend": "runner", "crew": True}
    if owner is not None:
        meta["owner"] = owner
    meta.update(extra)
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=f"agent-{agent_id}",
        keycloak_sub=f"brigade:{agent_id}",
        display_name=agent_id.replace("-", " ").title(),
        participant_type=ParticipantType.AGENT,
        metadata_=meta,
        avatar_url=None,
    )


def _brigade(agent_id="majik", metadata=None):
    """A real Brigade persona row: ``brigade:<id>``, NULL metadata, no key."""
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=f"agent-{agent_id}",
        keycloak_sub=f"brigade:{agent_id}",
        display_name=agent_id.title(),
        participant_type=ParticipantType.AGENT,
        metadata_=metadata,
        avatar_url=None,
    )


def _webhook(room_name="hub-fa65c5631810", metadata=None):
    """Exactly what webhooks.py writes: ``webhook:<room>``, metadata NULL."""
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=f"webhook-{room_name}"[:60],
        keycloak_sub=f"webhook:{room_name}",
        display_name="Forgejo CI",
        participant_type=ParticipantType.AGENT,
        metadata_=metadata,
        avatar_url=None,
    )


def _projectops(room_name="p-00115"):
    return SimpleNamespace(
        id=uuid.uuid4(),
        username="projectops-" + "a" * 32,
        keycloak_sub=f"projectops:{room_name}",
        display_name="Project-Ops",
        participant_type=ParticipantType.AGENT,
        metadata_=None,
        avatar_url=None,
    )


def _members(*participants):
    return [SimpleNamespace(participant=p, participant_id=getattr(p, "id", None), agent_mode=None) for p in participants]


AARON = _human("aaron")
SHAFEN = _human("shafenkhan")
MALLORY = _human("mallory")
PERSEPHONE = _seat("persephone", "aaron")
ROOK = _seat("claude-code", "aaron")
FLOW = _seat("flow", ["shafen", "shafenkhan"])
MAJIK = _brigade("majik")


def _facts(*participants, asking=PERSEPHONE, room_type=AGENT_HUB, keys=(), **kw):
    return RC.room_class_facts(room_type, _members(*participants), key_agent_ids=keys, asking_seat=asking, **kw)


class _Result:
    """A fake SQLAlchemy result supporting every access pattern the code uses."""

    def __init__(self, *, scalar=None, scalars=None, rows=None, rowcount=1):
        self._scalar = scalar
        self._scalars = list(scalars or [])
        self._rows = list(rows or [])
        self.rowcount = rowcount

    def scalar_one_or_none(self):
        return self._scalar

    def scalar(self):
        return self._scalar

    def scalars(self):
        return SimpleNamespace(all=lambda: list(self._scalars))

    def all(self):
        return list(self._rows)


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect())).lower()


# ---------------------------------------------------------------------------
# P1-3 / R7 — the hub is the caller's own top-level hub
# ---------------------------------------------------------------------------


def _crew(*, rows=(), seats=(), all_keys=None, live=None, caller="aaron", caller_id=None, fresh=None, roster=None, events=(), messages=()):
    live = set(live if live is not None else ["persephone", "claude-code", "flow", "grok"])
    return C.rank_crew(
        C.assemble_crew(
            now=NOW, caller_id=caller_id, caller_username=caller, runner_seats=list(seats),
            all_key_agent_ids=set(all_keys if all_keys is not None else live), live_key_agent_ids=live,
            shared_rows=list(rows), last_messages={str(m.sender_id): m for m in messages}, unread_by_room={},
            events=list(events), gateway_fresh=fresh, roster_status=roster,
        ),
        NOW,
    )


def _row(participant, room, mode="answers_all"):
    return (participant, SimpleNamespace(agent_mode=mode), room)


def _hub(human_id, parent=None):
    return SimpleNamespace(id=uuid.uuid4(), room_type=AGENT_HUB, parent_room_id=parent, metadata_={"agent_hub": {"human_id": str(human_id), "agent_id": "persephone"}})


class P1_3_HubIsTheCallersOwn(TestCase):
    def test_threads_and_other_peoples_hubs_are_not_the_hub(self) -> None:
        me = uuid.uuid4()
        mine = _hub(me)
        thread = _hub(me, parent=mine.id)
        mallorys = _hub(uuid.uuid4())
        crew = _crew(rows=[_row(PERSEPHONE, thread), _row(PERSEPHONE, mallorys), _row(PERSEPHONE, mine)], seats=[PERSEPHONE], caller_id=me)
        self.assertEqual(crew[0].hub_room_id, str(mine.id))
        only_thread = _crew(rows=[_row(PERSEPHONE, thread)], seats=[PERSEPHONE], caller_id=me)
        self.assertIsNone(only_thread[0].hub_room_id)
        self.assertTrue(C.is_caller_hub(mine, me))
        self.assertFalse(C.is_caller_hub(thread, me))
        self.assertFalse(C.is_caller_hub(mallorys, me))

    def test_house_agents_need_the_r1_allowlist(self) -> None:
        me = uuid.uuid4()
        hub = _hub(me)
        crew = _crew(rows=[_row(MAJIK, hub), _row(_webhook(), hub), _row(_projectops(), hub), _row(_brigade("gunny", {"backend": "odd"}), hub)], caller_id=me)
        self.assertEqual([(e.agent_id, e.group) for e in crew], [("majik", "house")])
        # A key-holder wearing a brigade sub is not house.
        crew = _crew(rows=[_row(MAJIK, hub)], caller_id=me, all_keys={"majik"}, live=set())
        self.assertEqual(crew, [])


# ---------------------------------------------------------------------------
# P1-4 / R8 — presence
# ---------------------------------------------------------------------------


class P1_4_Presence(TestCase):
    def test_a_seat_is_online_only_while_its_bridge_calls_the_gateway(self) -> None:
        rook = _seat("claude-code")
        crew = _crew(seats=[PERSEPHONE, rook], fresh={"persephone"})
        by_id = {e.agent_id: e for e in crew}
        self.assertEqual(by_id["persephone"].presence, "online")
        self.assertEqual(by_id["claude-code"].presence, "offline")
        self.assertEqual(by_id["claude-code"].status, "offline")
        # No Redis → nobody is claimed online.
        self.assertEqual({e.presence for e in _crew(seats=[PERSEPHONE, rook])}, {"offline"})

    def test_a_house_agent_follows_the_roster_or_a_fresh_heartbeat(self) -> None:
        me = uuid.uuid4()
        hub = _hub(me)
        gunny = _brigade("gunny")
        heartbeat = SimpleNamespace(agent_identity="brigade:gunny", event_type="worker_heartbeat", event_data={}, occurred_at=NOW - timedelta(minutes=2))
        crew = _crew(rows=[_row(MAJIK, hub), _row(gunny, hub)], caller_id=me, roster={"majik": "active", "gunny": "inactive"}, events=[heartbeat])
        by_id = {e.agent_id: e for e in crew}
        self.assertEqual(by_id["majik"].presence, "online")   # registered + enabled
        self.assertEqual(by_id["gunny"].presence, "online")   # heartbeat wins over 'inactive'
        crew = _crew(rows=[_row(MAJIK, hub), _row(gunny, hub)], caller_id=me, roster={"majik": "disabled", "gunny": "active"})
        by_id = {e.agent_id: e for e in crew}
        self.assertEqual((by_id["majik"].presence, by_id["gunny"].presence), ("offline", "online"))
        # Roster unknown and no heartbeat → offline, never a guess.
        self.assertEqual({e.presence for e in _crew(rows=[_row(MAJIK, hub)], caller_id=me)}, {"offline"})


# ---------------------------------------------------------------------------
# P1-5 / R10 — the data migration and the picker fallback
# ---------------------------------------------------------------------------


def _load_migration(name: str):
    root = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, root)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


class P1_5_DataMigration024(TestCase):
    def test_chain_and_id_length(self) -> None:
        mod = _load_migration("024_crew_seat_flags")
        self.assertEqual(mod.revision, "024_crew_seat_flags")
        self.assertLessEqual(len(mod.revision), 32)
        self.assertEqual(mod.down_revision, "023_recording_policy")

    def test_upgrade_is_a_merge_and_names_every_seat_and_integration(self) -> None:
        mod = _load_migration("024_crew_seat_flags")
        conn = MagicMock()
        with patch.object(mod.op, "get_bind", return_value=conn), patch.object(mod.op, "execute"):
            mod.upgrade()
        calls = [(str(c.args[0]), c.args[1] if len(c.args) > 1 else {}) for c in conn.execute.call_args_list]
        seat_calls = [(sql, params) for sql, params in calls
                      if "brigade:" in str(params.get("sub", "")) and '"owner"' in params.get("patch", "")]
        self.assertEqual(len(seat_calls), len(mod.SEAT_OWNERS))
        self.assertEqual(len(mod.SEAT_OWNERS), 31)   # Persephone's list (2026-09-29) without perry (REVIEW-4 P2-7)
        crew_subs = {p["sub"] for _s, p in seat_calls if '"crew": true' in p["patch"]}
        self.assertEqual(crew_subs, {f"brigade:{a}" for a in mod.CREW_SEATS})
        for sql, params in seat_calls:
            self.assertIn("|| cast(:patch as jsonb)", sql.lower())
            self.assertIn("coalesce(metadata, jsonb_build_object('metadata_null_before_024', true))", sql.lower())
        by_sub = {p["sub"]: p["patch"] for _s, p in seat_calls}
        self.assertIn('"owner": "aaron"', by_sub["brigade:persephone"])
        self.assertIn('"crew": true', by_sub["brigade:persephone"])
        self.assertIn('["shafen", "shafenkhan"]', by_sub["brigade:shox"])
        role_subs = {p["sub"] for _s, p in calls if "role_line" in p.get("patch", "")}
        self.assertEqual(role_subs, {"brigade:claude-code", "brigade:persephone"})
        joined = "\n".join(sql for sql, _p in calls).lower()
        self.assertIn("display_name = 'rook'", joined)
        self.assertIn("keycloak_sub like 'webhook:%'", joined)
        self.assertIn("'brigade:texts-relay'", joined)
        self.assertIn("seed_sender_id", joined)
        self.assertNotIn("set metadata = '", joined)  # never a whole-column rewrite

    def test_downgrade_removes_only_what_upgrade_set(self) -> None:
        mod = _load_migration("024_crew_seat_flags")
        conn = MagicMock()
        with patch.object(mod.op, "get_bind", return_value=conn), patch.object(mod.op, "execute"):
            mod.downgrade()
        joined = "\n".join(str(c.args[0]) for c in conn.execute.call_args_list).lower()
        # REVIEW-4 P2-7: each key goes back to what its marker says, on
        # exactly the rows upgrade marked — so a hand-set value is restored,
        # never removed.
        for key in ("owner", "crew", "backend", "kind", "role_line"):
            self.assertIn(f"where metadata ? '{key}_before_024'", joined)
            self.assertIn(f"(metadata - '{key}') - '{key}_before_024'", joined)
        self.assertNotIn("metadata - 'crew' - 'owner'", joined)
        self.assertIn("display_name = 'rook'", joined)
        self.assertIn("display_name_by_024", joined)               # only the marked rename

class P1_5_PickerFallback(IsolatedAsyncioTestCase):
    async def test_no_flagged_seat_anywhere_keeps_the_two_entry_fallback(self) -> None:
        from app.api import brigade as B

        with patch.object(B, "crew_flagged_runner_seats", new=AsyncMock(return_value=[])), \
             patch.object(B, "live_key_agent_ids", new=AsyncMock(return_value={"persephone", "claude-code", "reddit-scout"})), \
             patch.object(B, "crew_runner_seats_for", new=AsyncMock()) as crew:
            agents = await B._fetch_bridge_crew_agents(AsyncMock(), {"participant_id": uuid.uuid4()})
        self.assertEqual([(a.id, a.name) for a in agents], [("claude-code", "Rook"), ("persephone", "Persephone")])
        crew.assert_not_awaited()

    async def test_a_flagged_seat_switches_the_picker_to_the_crew(self) -> None:
        from app.api import brigade as B

        entry = C.CrewEntry(agent_id="persephone", participant_id="p", display_name="Persephone", avatar_url=None, role_line=None,
                            backend="runner", kind="seat", owner="aaron", group="own_seat", presence="online", hub_room_id=None,
                            seat_capabilities=None, last_line=None, last_at=None, unread=0, status="online", agent_mode=None,
                            current_task=None, since=None)
        with patch.object(B, "crew_flagged_runner_seats", new=AsyncMock(return_value=[PERSEPHONE])), \
             patch.object(B, "crew_runner_seats_for", new=AsyncMock(return_value=[entry])):
            agents = await B._fetch_bridge_crew_agents(AsyncMock(), {"participant_id": uuid.uuid4()})
        self.assertEqual([a.id for a in agents], ["persephone"])

    async def test_picker_rows_are_deduplicated_brigade_first(self) -> None:
        from app.api import brigade as B

        seat = B.BrigadeAgent(id="persephone", name="Persephone")
        with patch.object(B, "_fetch_bridge_crew_agents", new=AsyncMock(return_value=[seat, seat])), \
             patch.object(B, "_fetch_brigade_agents", new=AsyncMock(return_value=[B.BrigadeAgent(id="majik", name="Majik"), B.BrigadeAgent(id="persephone", name="Persephone (brigade)")])):
            agents = await B._fetch_invitable_agents(AsyncMock(), None)
        self.assertEqual([(a.id, a.name) for a in agents], [("majik", "Majik"), ("persephone", "Persephone (brigade)")])


class P2_CrewFlagSqlIsCaseInsensitive(IsolatedAsyncioTestCase):
    async def test_query_lowercases_the_flag(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(rows=[]))
        await C.crew_flagged_runner_seats(db)
        stmt = db.execute.await_args.args[0]
        sql = _sql(stmt)
        self.assertIn("lower((participants.metadata ->>", sql)
        self.assertIn("crew", [v for v in stmt.compile(dialect=postgresql.dialect()).params.values() if isinstance(v, str)])
        # Column select: no eager relationship rides along.
        self.assertNotIn("room_members", sql)
        self.assertNotIn("agent_configs", sql)


class P2_RoleLinesLoadAlongsideWithABudget(IsolatedAsyncioTestCase):
    async def test_redis_down_and_slow_brigade_fall_back_within_the_budget(self) -> None:
        async def slow():
            await asyncio.sleep(5)
            return {"majik": "late"}

        redis = AsyncMock()
        redis.get = AsyncMock(side_effect=RuntimeError("redis down"))
        C._ROLES_MEMO.update(at=0.0, roles={"majik": "House DJ — stale copy"})
        started = asyncio.get_running_loop().time()
        with patch.object(C, "_fetch_brigade_role_lines", new=slow), patch.object(C, "ROLES_FETCH_BUDGET_S", 0.05):
            roles = await C.load_brigade_role_lines(redis)
        self.assertLess(asyncio.get_running_loop().time() - started, 1.0)
        self.assertEqual(roles, {"majik": "House DJ — stale copy"})  # the in-process copy, not a 5 s wait

    async def test_role_lines_overlay_house_entries_only(self) -> None:
        seat = C.CrewEntry(agent_id="persephone", participant_id="p", display_name="P", avatar_url=None, role_line="mine", backend="runner", kind="seat", owner="aaron", group="own_seat", presence="offline", hub_room_id=None, seat_capabilities=None, last_line=None, last_at=None, unread=0, status="offline", agent_mode=None, current_task=None, since=None)
        house = C.CrewEntry(agent_id="majik", participant_id="m", display_name="Majik", avatar_url=None, role_line=None, backend="brigade", kind="brigade", owner=None, group="house", presence="offline", hub_room_id=None, seat_capabilities=None, last_line=None, last_at=None, unread=0, status="offline", agent_mode=None, current_task=None, since=None)
        C.apply_role_lines([seat, house], {"persephone": "nope", "majik": "House DJ"})
        self.assertEqual((seat.role_line, house.role_line), ("mine", "House DJ"))
