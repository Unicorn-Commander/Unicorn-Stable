"""Nav v3 fix lane — the room class and what depends on it (REVIEW.md P0-1,
P0-2, R3, R6, R11; P2 kick / PUT /me / stable- prefix).

Realistic row shapes: a webhook row is ``keycloak_sub = "webhook:<room>"`` with
NULL metadata; Majik is ``brigade:majik`` with no key row; a guest who left; a
thread seeded from a stranger's line. Every test here FAILED on 3111bfe.
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
# P0-1 / R1 — house is an allowlist, never a default
# ---------------------------------------------------------------------------


class P0_1_HouseIsAnAllowlist(TestCase):
    def test_webhook_row_with_null_metadata_is_foreign(self) -> None:
        facts = _facts(AARON, PERSEPHONE, _webhook())
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual(facts.foreign_actors, 1)
        self.assertIn("foreign_agent", facts.reasons)

    def test_webhook_flagged_integration_is_foreign(self) -> None:
        facts = _facts(AARON, PERSEPHONE, _webhook(metadata={"kind": "integration"}))
        self.assertEqual(facts.room_class, "shared")
        self.assertIn("integration", facts.reasons)

    def test_projectops_sender_is_foreign(self) -> None:
        self.assertEqual(_facts(AARON, PERSEPHONE, _projectops()).room_class, "shared")

    def test_typoed_backend_is_foreign_not_house(self) -> None:
        odd = _seat("flow", "shafen")
        odd.metadata_["backend"] = "Runner"
        self.assertEqual(_facts(AARON, PERSEPHONE, odd).room_class, "shared")

    def test_realistic_majik_is_house(self) -> None:
        # brigade:majik, NULL metadata, no key row → the one shape that is house.
        facts = _facts(AARON, PERSEPHONE, MAJIK)
        self.assertEqual(facts.room_class, "private")
        self.assertEqual(facts.foreign_actors, 0)

    def test_a_key_holder_wearing_a_brigade_sub_is_foreign(self) -> None:
        facts = _facts(AARON, PERSEPHONE, MAJIK, keys={"majik"})
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual(facts.foreign_actors, 1)

    def test_explicit_brigade_backend_is_house_but_any_kind_is_not(self) -> None:
        self.assertTrue(RC.is_house_agent(_brigade("gunny", {"backend": "brigade"}), set()))
        self.assertFalse(RC.is_house_agent(_brigade("gunny", {"backend": "brigade", "kind": "probe"}), set()))
        self.assertFalse(RC.is_house_agent(_brigade("gunny", {"backend": "unknown"}), set()))
        self.assertFalse(RC.is_house_agent(_webhook(), set()))
        self.assertFalse(RC.is_house_agent(_projectops(), set()))
        self.assertFalse(RC.is_house_agent(_brigade("gunny"), {"gunny"}))

    def test_member_whose_participant_failed_to_load_is_foreign(self) -> None:
        members = _members(AARON, PERSEPHONE) + [SimpleNamespace(participant=None, participant_id=uuid.uuid4(), agent_mode=None)]
        facts = RC.room_class_facts(AGENT_HUB, members, asking_seat=PERSEPHONE)
        self.assertEqual(facts.room_class, "shared")
        self.assertIn("unattributed_actor", facts.reasons)

    def test_guest_agent_and_integration_kinds_are_always_foreign(self) -> None:
        visitor = _seat("visitor", "aaron", kind="guest_agent")  # even "owned"
        self.assertEqual(_facts(AARON, PERSEPHONE, visitor).room_class, "shared")
        relay = _seat("texts-relay", "aaron", kind="integration")
        self.assertEqual(_facts(AARON, PERSEPHONE, relay).room_class, "shared")

    def test_owner_may_be_a_list_of_usernames(self) -> None:
        self.assertEqual(RC.seat_owners(FLOW), frozenset({"shafen", "shafenkhan"}))
        self.assertEqual(_facts(SHAFEN, FLOW, asking=FLOW).room_class, "private")
        self.assertEqual(_facts(_human("shafen"), FLOW, asking=FLOW).room_class, "private")
        self.assertEqual(_facts(AARON, FLOW, asking=FLOW).room_class, "shared")


class P0_1_IntegrationsAreStamped(IsolatedAsyncioTestCase):
    async def test_webhook_sender_is_created_with_kind_integration(self) -> None:
        from app.api.webhooks import _get_or_create_webhook_sender

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=None))
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        created = await _get_or_create_webhook_sender(
            db, pseudo_sub="webhook:hub-fa65c5631810", username="webhook-hub-fa65c5631810", display_name="CI"
        )
        self.assertEqual(created.metadata_, {"kind": "integration"})
        self.assertEqual(created.keycloak_sub, "webhook:hub-fa65c5631810")
        db.add.assert_called_once()

    async def test_existing_webhook_row_without_the_stamp_is_repaired(self) -> None:
        from app.api.webhooks import _get_or_create_webhook_sender

        row = SimpleNamespace(display_name="CI", metadata_=None)
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=row))
        db.commit = AsyncMock()
        out = await _get_or_create_webhook_sender(db, pseudo_sub="webhook:x", username="webhook-x", display_name="CI")
        self.assertIs(out, row)
        self.assertEqual(row.metadata_, {"kind": "integration"})
        db.commit.assert_awaited_once()

    async def test_projectops_sender_is_created_with_kind_integration(self) -> None:
        from app.api.project_ops import _get_or_create_sender

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=None))
        db.add = MagicMock()
        db.flush = AsyncMock()

        class _Nested:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        db.begin_nested = MagicMock(return_value=_Nested())
        sender = await _get_or_create_sender(db, "p-00115")
        self.assertEqual(sender.metadata_, {"kind": "integration"})

    async def test_projectops_existing_sender_is_repaired(self) -> None:
        from app.api.project_ops import _get_or_create_sender

        row = SimpleNamespace(participant_type=ParticipantType.AGENT, metadata_={})
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=row))
        out = await _get_or_create_sender(db, "p-00115")
        self.assertIs(out, row)
        self.assertEqual(row.metadata_["kind"], "integration")

    async def test_jwt_path_agents_get_the_human_as_owner(self) -> None:
        principal = SimpleNamespace(auth_kind="jwt", human_sub="kc-aaron", agent_id="dev-aaron")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar="aaron"))
        self.assertEqual(await G._principal_owner_username(db, principal), "aaron")
        self.assertIsNone(await G._principal_owner_username(db, SimpleNamespace(auth_kind="key", human_sub=None, agent_id="persephone")))

        room = SimpleNamespace(id=uuid.uuid4())
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=None), _Result(scalar=None)])
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        created = await G._resolve_agent_participant(db, "dev-aaron", room, owner_username="aaron")
        self.assertEqual(created.metadata_, {"backend": "runner", "owner": "aaron"})


# ---------------------------------------------------------------------------
# P0-2 / R2 — the class covers the history, the seed and the parent; sticky floor
# ---------------------------------------------------------------------------


class P0_2_HistoryAndSeedsCount(TestCase):
    def test_a_departed_human_keeps_the_room_shared(self) -> None:
        facts = _facts(AARON, PERSEPHONE, historical=[MALLORY])
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual(facts.humans, 2)

    def test_a_departed_guest_keeps_the_room_shared(self) -> None:
        facts = _facts(AARON, PERSEPHONE, historical=[_guest()])
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual(facts.guests, 1)

    def test_a_null_sender_is_foreign(self) -> None:
        facts = _facts(AARON, PERSEPHONE, historical=[None])
        self.assertEqual(facts.room_class, "shared")
        self.assertIn("unattributed_actor", facts.reasons)

    def test_history_by_the_owner_his_seats_and_house_stays_private(self) -> None:
        facts = _facts(AARON, PERSEPHONE, historical=[AARON, ROOK, MAJIK, PERSEPHONE])
        self.assertEqual(facts.room_class, "private")

    def test_a_thread_seeded_from_a_strangers_line_is_shared(self) -> None:
        self.assertEqual(_facts(AARON, PERSEPHONE, has_seed=True, seed_sender=SHAFEN).room_class, "shared")
        self.assertEqual(_facts(AARON, PERSEPHONE, has_seed=True, seed_sender=_webhook()).room_class, "shared")
        # A seed with no recorded author (threads made before R2) is foreign.
        self.assertEqual(_facts(AARON, PERSEPHONE, has_seed=True, seed_sender=None).room_class, "shared")
        # The owner's own line as a seed is fine.
        self.assertEqual(_facts(AARON, PERSEPHONE, has_seed=True, seed_sender=AARON).room_class, "private")

    def test_the_floor_is_sticky(self) -> None:
        facts = _facts(AARON, PERSEPHONE, floor="shared")
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual(facts.floor, "shared")
        self.assertEqual(RC.class_floor_of({"class_floor": "shared"}), "shared")
        self.assertIsNone(RC.class_floor_of({"class_floor": "private"}))

    def test_thread_seed_facts_from_metadata(self) -> None:
        self.assertEqual(RC.thread_seed_of({"thread": {"seed_message_id": "m1", "seed_sender_id": "p1"}}), (True, "p1"))
        self.assertEqual(RC.thread_seed_of({"thread": {"seed_message_id": "m1"}}), (True, None))
        self.assertEqual(RC.thread_seed_of({"thread": {"seed_message_id": None}}), (False, None))
        self.assertEqual(RC.thread_seed_of(None), (False, None))


class P0_2_CreateThreadRecordsTheTrueAuthor(IsolatedAsyncioTestCase):
    async def test_seed_line_keeps_its_author_and_the_thread_records_it(self) -> None:
        from app.models.message import ContentType
        from app.services.room_service import RoomService

        aaron, shafen = _human("aaron"), _human("shafenkhan")
        parent = SimpleNamespace(
            id=uuid.uuid4(), name="crew", room_type=RoomType.GROUP_DM, parent_room_id=None,
            is_archived=False, metadata_={}, org_id=None, max_participants=50, visibility="public",
            recording_policy="off", recording_kind="audio", project_number=None, updated_at=NOW,
        )
        seed = SimpleNamespace(id=uuid.uuid4(), sender_id=shafen.id, sender=shafen, content="ship it tonight", created_at=NOW)
        thread = SimpleNamespace(id=uuid.uuid4(), name="crew-t-1", metadata_={}, parent_room_id=None)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=parent),                 # parent
            _Result(scalar=SimpleNamespace()),      # creator membership
            _Result(scalar=seed),                   # seed message
            _Result(scalar=aaron),                  # creator
            _Result(rows=[]),                       # parent members
        ])
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        svc.create_room = AsyncMock(return_value=thread)
        await svc.create_thread(parent_id=parent.id, creator_id=aaron.id, seed_message_id=seed.id)

        meta = svc.create_room.await_args.kwargs["metadata"]
        self.assertEqual(meta["thread"]["seed_sender_id"], str(shafen.id))
        seed_lines = [m for m in (c.args[0] for c in db.add.call_args_list) if getattr(m, "metadata_", {}) and m.metadata_.get("kind") == "thread_seed"]
        self.assertEqual(len(seed_lines), 1)
        self.assertEqual(seed_lines[0].sender_id, shafen.id)  # never the creator
        self.assertEqual(seed_lines[0].content_type, ContentType.SYSTEM)


class P0_2_FloorIsAnSqlMerge(IsolatedAsyncioTestCase):
    """What writes a floor is pinned in tests/test_nav_v3_fix2_class.py (the
    viewer-independent verdict and the insert path; never a removal). Here:
    HOW it is written."""

    async def test_stamp_is_an_sql_merge_not_a_rewrite(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(rowcount=1))
        await RC.stamp_class_floor_shared(db, [uuid.uuid4()])
        sql = _sql(db.execute.await_args.args[0])
        self.assertIn("update rooms", sql)
        self.assertIn("||", sql)
        self.assertIn("coalesce(rooms.metadata", sql)

    async def test_apply_class_floors_writes_once_and_never_on_channels(self) -> None:
        hub = RC.RoomLite(id=uuid.uuid4(), room_type=AGENT_HUB, metadata_={})
        chan = RC.RoomLite(id=uuid.uuid4(), room_type=RoomType.CHANNEL, metadata_={})
        floored = RC.RoomLite(id=uuid.uuid4(), room_type=AGENT_HUB, metadata_={"class_floor": "shared"})
        shared = RC.RoomClassFacts(room_class="shared", humans=2, own_seats=0, foreign_seats=0, guests=0, history_shared=True)
        facts = {str(hub.id): shared, str(chan.id): RC.RoomClassFacts("channel", 2, 0, 0, 0, history_shared=True), str(floored.id): shared}
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result())
        stamped = await RC.apply_class_floors(db, [hub, chan, floored], facts)
        self.assertEqual(stamped, [hub.id])
        self.assertEqual(hub.metadata_["class_floor"], "shared")
        db.execute.assert_awaited_once()

class P0_2_GatewayListJudgesTheHistory(IsolatedAsyncioTestCase):
    """The rooms list: a departed author (Mallory) stays in the history, so
    the room reads shared and the floor is written."""

    def _room_row(self, room_id, name="hub-fa65c5631810", room_type=AGENT_HUB, parent=None, metadata=None):
        return (room_id, name, f"stable-{name}", "Persephone", room_type, parent, metadata or {}, NOW, False, NOW)  # …, last_message_at

    def _member_row(self, room_id, p, mode=None):
        return (room_id, p.id, mode, p.id, p.participant_type, p.username, getattr(p, "keycloak_sub", None), getattr(p, "display_name", None), p.metadata_)

    def _actor_row(self, p):
        return (p.id, p.participant_type, p.username, getattr(p, "keycloak_sub", None), getattr(p, "display_name", None), p.metadata_, None)

    async def _list(self, *, history, principal_rooms=("@member",)):
        room_id = uuid.uuid4()
        db = AsyncMock()
        results = [
            _Result(scalar=PERSEPHONE),                                       # seat row
            _Result(rows=[self._room_row(room_id)]),                          # seat's rooms
            _Result(scalars=[room_id]),                                       # owner present (every key kind)
            _Result(rows=[self._member_row(room_id, AARON), self._member_row(room_id, PERSEPHONE, "answers_all")]),
            _Result(scalars=["persephone"]),                                  # key agent ids
            _Result(rows=[(room_id, history, False)]),                        # history
        ]
        if MALLORY.id in history:
            results.append(_Result(rows=[self._actor_row(MALLORY)]))          # the unknown sender
            results.append(_Result(rowcount=1))                               # floor stamp
        db.execute = AsyncMock(side_effect=results)
        db.commit = AsyncMock()
        principal = SimpleNamespace(agent_id="persephone", allowed_rooms=list(principal_rooms), auth_kind="key", human_sub=None)
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()) as rl:
            rows = await G.gateway_list_rooms(principal=principal, db=db, redis=AsyncMock())
        return rows, db, rl

    async def test_departed_author_makes_the_room_shared_and_floors_it(self) -> None:
        rows, db, rl = await self._list(history=[AARON.id, PERSEPHONE.id, MALLORY.id])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].room_class, "shared")
        self.assertEqual(rows[0].humans, 2)
        self.assertIn("humans_2", rows[0].class_reasons)
        self.assertEqual(rows[0].last_message_at, NOW)
        db.commit.assert_awaited_once()  # the floor was written
        self.assertEqual(rl.await_args.kwargs["bucket"], "gw_rooms")  # P2-3: its own bucket

    async def test_owner_only_history_stays_private_and_writes_nothing(self) -> None:
        room_id_holder = {}
        rows, db, _rl = await self._list(history=[AARON.id, PERSEPHONE.id])
        self.assertEqual(rows[0].room_class, "private")
        db.commit.assert_not_awaited()


class R11_MessagesEnvelopeCarriesClassAndSeat(IsolatedAsyncioTestCase):
    def test_envelope_shape(self) -> None:
        from app.schemas.message import MessageListResponse

        facts = RC.RoomClassFacts(room_class="shared", humans=2, own_seats=0, foreign_seats=1, guests=0, reasons=("foreign_seat",))
        env = G._room_envelope_facts(SimpleNamespace(id=uuid.uuid4(), room_type=AGENT_HUB, parent_room_id=None), "answers_all", facts, {"model": None, "effort": "max"})
        self.assertEqual(env["room_class"], "shared")
        self.assertEqual(env["class_reasons"], ["foreign_seat"])
        self.assertEqual(env["seat"], {"model": None, "effort": "max"})
        resp = MessageListResponse(messages=[], cursor=None, has_more=False, **env)
        self.assertEqual(resp.room_class, "shared")

    async def test_poll_carries_the_class(self) -> None:
        room = SimpleNamespace(id=uuid.uuid4(), room_type=AGENT_HUB, parent_room_id=None, metadata_={"seats": {"persephone": {"model": "claude-opus-5-5", "effort": "low"}}})
        facts = RC.RoomClassFacts(room_class="shared", humans=2, own_seats=0, foreign_seats=0, guests=0, reasons=("humans_2",))
        svc = SimpleNamespace(get_messages=AsyncMock(return_value={"messages": [], "cursor": None, "has_more": False}))
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch.object(G, "_seat_agent_mode", new=AsyncMock(return_value="answers_all")), \
             patch.object(G, "_find_seat_participant", new=AsyncMock(return_value=PERSEPHONE)), \
             patch.object(G, "_classify_for_seat", new=AsyncMock(return_value=facts)), \
             patch.object(G, "touch_bridge_seen", new=AsyncMock()), \
             patch.object(G, "clear_relay_pending", new=AsyncMock()), \
             patch.object(G, "_build_message_service", return_value=svc):
            out = await G.gateway_get_messages(room="hub", principal=SimpleNamespace(agent_id="persephone"), db=AsyncMock(), livekit=AsyncMock(), redis=AsyncMock(), cursor=None, limit=50)
        self.assertEqual(out.room_class, "shared")
        self.assertEqual(out.seat, {"model": "claude-opus-5-5", "effort": "low"})
        self.assertEqual(out.class_reasons, ["humans_2"])


# ---------------------------------------------------------------------------
# R3 — the asking seat always counts (P2-5)
# ---------------------------------------------------------------------------


class R3_TheAskingSeatAlwaysCounts(TestCase):
    def test_someone_elses_seat_reading_aarons_hub_sees_shared(self) -> None:
        facts = _facts(AARON, PERSEPHONE, asking=FLOW)  # Flow is not a member
        self.assertEqual(facts.room_class, "shared")
        self.assertIn("foreign_seat", facts.reasons)
        self.assertEqual(facts.own_seats, 1)  # Persephone, from Flow's view

    def test_a_seat_with_no_row_and_no_owner_reads_shared(self) -> None:
        facts = _facts(AARON, PERSEPHONE, asking=G._asking_seat(None, "ghost"))
        self.assertEqual(facts.room_class, "shared")

    def test_the_owners_own_seat_reads_private(self) -> None:
        self.assertEqual(_facts(AARON, PERSEPHONE, asking=PERSEPHONE).room_class, "private")
        self.assertEqual(_facts(AARON, PERSEPHONE, ROOK, asking=ROOK).room_class, "private")


# ---------------------------------------------------------------------------
# P2-7 / R6 — per-seat settings, set only by the seat's owner
# ---------------------------------------------------------------------------


class R6_SeatsAreKeyedByAgentAndOwned(IsolatedAsyncioTestCase):
    def _member(self, participant, role=MemberRole.MEMBER):
        return SimpleNamespace(participant=participant, participant_id=participant.id, role=role, agent_mode=None)

    def _room(self, members, archived=False, metadata=None):
        return SimpleNamespace(id=uuid.uuid4(), room_type=RoomType.GROUP_DM, members=members, metadata_=dict(metadata or {}), parent_room_id=None, is_archived=archived)

    def _svc(self, *results):
        from app.services.room_service import RoomService

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=list(results))
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        return RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock()), db

    async def test_the_seats_owner_sets_its_entry_even_when_someone_else_owns_the_room(self) -> None:
        aaron, shafen = _human("aaron"), _human("shafenkhan")
        me = self._member(aaron)  # Aaron is a plain member; Shafen owns the room
        room = self._room([self._member(shafen, MemberRole.OWNER), me, self._member(PERSEPHONE), self._member(FLOW)],
                          metadata={"seats": {"flow": {"model": None, "effort": "low"}}})
        svc, db = self._svc(_Result(scalar=me), _Result(scalar=room))
        out = await svc.update_room(room.id, aaron.id, metadata={"seats": {"persephone": {"model": "claude-opus-5-5", "effort": "medium"}}})
        self.assertEqual(out.metadata_["seats"], {
            "flow": {"model": None, "effort": "low"},
            "persephone": {"model": "claude-opus-5-5", "effort": "medium"},
        })
        db.commit.assert_awaited_once()

    async def test_the_room_owner_cannot_set_someone_elses_seat(self) -> None:
        aaron, shafen = _human("aaron"), _human("shafenkhan")
        me = self._member(shafen, MemberRole.OWNER)
        room = self._room([me, self._member(aaron), self._member(PERSEPHONE)])
        svc, db = self._svc(_Result(scalar=me), _Result(scalar=room))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, shafen.id, metadata={"seats": {"persephone": {"effort": "max"}}})
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("ask the seat's owner", ctx.exception.detail)
        db.commit.assert_not_awaited()

    async def test_an_agent_that_is_not_a_seat_in_the_room_is_409(self) -> None:
        aaron = _human("aaron")
        me = self._member(aaron, MemberRole.OWNER)
        room = self._room([me, self._member(MAJIK)])
        # The seat is not in the room: its own row says who owns it (the
        # caller) → not a 403, a 409.
        svc, _db = self._svc(_Result(scalar=me), _Result(scalar=room), _Result(scalar={"backend": "runner", "owner": "aaron"}))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, aaron.id, metadata={"seats": {"persephone": {"effort": "max"}}})
        self.assertEqual(ctx.exception.status_code, 409)
        with self.assertRaises(HTTPException) as ctx:
            svc2, _ = self._svc(_Result(scalar=me), _Result(scalar=room), _Result(scalar=None))
            await svc2.update_room(room.id, aaron.id, metadata={"seats": {"majik": {"effort": "max"}}})
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_archived_rooms_refuse(self) -> None:
        aaron = _human("aaron")
        me = self._member(aaron, MemberRole.OWNER)
        room = self._room([me, self._member(PERSEPHONE)], archived=True)
        svc, _db = self._svc(_Result(scalar=me), _Result(scalar=room))
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room.id, aaron.id, metadata={"seats": {"persephone": {"effort": "max"}}})
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_shape_errors_are_422_including_a_trailing_newline(self) -> None:
        for bad in (
            {"persephone": {"model": "claude-opus-5-5\n"}},
            {"persephone": "claude-opus-5-5"},
            {"Bad Id": {"effort": "low"}},
            {"persephone": {"effort": "ultra"}},
            {},
            [{"persephone": {}}],
        ):
            svc, db = self._svc()
            with self.assertRaises(HTTPException, msg=repr(bad)) as ctx:
                await svc.update_room(uuid.uuid4(), uuid.uuid4(), metadata={"seats": bad})
            self.assertEqual(ctx.exception.status_code, 422)
            db.execute.assert_not_awaited()

    async def test_reading_is_per_seat_and_fullmatch(self) -> None:
        meta = {"seats": {"persephone": {"model": "claude-opus-5-5", "effort": "medium"}, "flow": {"model": "x\n", "effort": "low"}},
                "seat": {"model": "legacy", "effort": "max"}}
        self.assertEqual(RC.seat_setting_from_metadata(meta, "persephone"), {"model": "claude-opus-5-5", "effort": "medium"})
        self.assertEqual(RC.seat_setting_from_metadata(meta, "flow"), {"model": None, "effort": "low"})
        self.assertEqual(RC.seat_setting_from_metadata(meta, "rook"), {"model": None, "effort": None})
        self.assertEqual(RC.seat_setting_from_metadata(meta, None), {"model": None, "effort": None})
        from app.services.room_service import CLIENT_MUTABLE_METADATA_KEYS

        self.assertEqual(CLIENT_MUTABLE_METADATA_KEYS, frozenset({"auto_titled", "seats"}))


# ---------------------------------------------------------------------------
# P2 — kick scope, PUT /me hardening, stable- prefix, crew flag SQL, roles
# ---------------------------------------------------------------------------


class P2_KickIsSelfOnlyForMemberKeys(IsolatedAsyncioTestCase):
    async def test_member_scoped_key_cannot_kick_another_agent(self) -> None:
        room = SimpleNamespace(id=uuid.uuid4(), name="hub-1", livekit_room_name="stable-hub-1")
        principal = SimpleNamespace(agent_id="persephone", allowed_rooms=["@member"])
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()):
            with self.assertRaises(HTTPException) as ctx:
                await G.gateway_remove_brigade_agent(room="hub-1", brigade_agent_id="claude-code", principal=principal, db=AsyncMock(), livekit=AsyncMock(), redis=AsyncMock())
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_name_scoped_key_may_still_kick(self) -> None:
        room = SimpleNamespace(id=uuid.uuid4(), name="hub-1", livekit_room_name="stable-hub-1")
        principal = SimpleNamespace(agent_id="persephone", allowed_rooms=["hub-1"])
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=SimpleNamespace(id=uuid.uuid4())), _Result(), _Result()])
        db.commit = AsyncMock()
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch.object(G, "clear_relay_pending", new=AsyncMock()):
            await G.gateway_remove_brigade_agent(room="hub-1", brigade_agent_id="claude-code", principal=principal, db=db, livekit=AsyncMock(), redis=AsyncMock())
        db.commit.assert_awaited_once()


class P2_PutMeHardening(IsolatedAsyncioTestCase):
    def _body(self):
        return G.SeatCapabilitiesBody(harness="claude-code", default_model="claude-fable-5-1", default_effort="high")

    async def test_overlong_agent_id_is_422_not_500(self) -> None:
        principal = SimpleNamespace(agent_id="x" * 95, auth_kind="key", human_sub=None)
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            with self.assertRaises(HTTPException) as ctx:
                await G.gateway_put_me(body=self._body(), principal=principal, db=AsyncMock(), redis=AsyncMock())
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_store_is_an_sql_merge(self) -> None:
        seat = _seat(avatar_emoji="🌸")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=seat))
        db.commit = AsyncMock()
        principal = SimpleNamespace(agent_id="persephone", auth_kind="key", human_sub=None)
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_put_me(body=self._body(), principal=principal, db=db, redis=AsyncMock())
        update_calls = [c for c in db.execute.await_args_list if "update participants" in _sql(c.args[0])]
        self.assertEqual(len(update_calls), 1)
        sql = _sql(update_calls[0].args[0])
        self.assertIn("||", sql)
        self.assertIn("coalesce(participants.metadata", sql)
        self.assertEqual(seat.metadata_["seat_capabilities"], out)
        self.assertEqual(seat.metadata_["avatar_emoji"], "🌸")

    async def test_concurrent_first_contact_is_not_a_500(self) -> None:
        from sqlalchemy.exc import IntegrityError

        winner = _seat("grok")
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=None), _Result(scalar=winner)])
        db.add = MagicMock()
        db.commit = AsyncMock(side_effect=IntegrityError("insert", {}, Exception("dup")))
        db.rollback = AsyncMock()
        out = await G._get_or_create_seat_participant(db, "grok")
        self.assertIs(out, winner)
        db.rollback.assert_awaited_once()


class P2_StablePrefixIsReserved(IsolatedAsyncioTestCase):
    def test_room_create_schema_refuses_the_prefix(self) -> None:
        from app.schemas.room import RoomCreate

        with self.assertRaises(ValidationError):
            RoomCreate(name="stable-persephone", display_name="Squat")
        RoomCreate(name="stables-and-barns", display_name="ok")

    # The service-level check moved to client-supplied names only (threads
    # under legacy stable-* rooms must keep working): see
    # tests/test_nav_v3_fix2_surface.py::StablePrefixOnlyOnClientNames.
