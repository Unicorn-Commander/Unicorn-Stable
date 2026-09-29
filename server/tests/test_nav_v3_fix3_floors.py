"""Nav v3 fix lane 3 — the floor, the notice rule and what a poll costs
(REVIEW-3.md P1-2, P2-1, P2-2, P2-3, P2-7).

Floors are written ONLY from what was written: historical authors and a
thread's seed author that are foreign to each other. Never from current
membership, never from the asking row, never by or because of a seat nobody
has claimed yet. A member who never writes leaves no trace. The NULL-sender
rule is NULL-safe and is run here by a real SQL engine (sqlite), so widening
it fails a test. The history read touches ``room_id`` and ``sender_id`` only;
``last_message_at`` is a per-room top-1.

Every test here FAILED on 5ee32e9 unless its docstring says it is a pin.

Amended in fix lane 4 (REVIEW-4.md P2-1): the test that asserted a
``rollback`` after a failed insert-time floor is gone. It ran on an
``AsyncMock`` session, which expires nothing, and so pinned behaviour that
raised on a real one. ``test_nav_v3_fix4_send.py`` replaces it with a real
session. The stamp itself now runs in a SAVEPOINT.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.api import gateway as G
from app.models.participant import ParticipantType
from app.models.room import RoomType
from app.services import room_class as RC

NOW = datetime(2026, 9, 29, 1, 0, tzinfo=timezone.utc)
HUB = RoomType.AGENT_HUB


def _human(username="aaron"):
    return SimpleNamespace(id=uuid.uuid4(), username=username, display_name=username.title(), keycloak_sub=f"kc-{username}",
                           participant_type=ParticipantType.HUMAN, metadata_={}, avatar_url=None, avatar_emoji=None)


def _guest():
    return SimpleNamespace(id=uuid.uuid4(), username="guest-7f3a", display_name="Jordan (guest)", keycloak_sub="guest:7f3a",
                           participant_type=ParticipantType.GUEST, metadata_={}, avatar_url=None, avatar_emoji=None)


def _seat(agent_id="persephone", owner="aaron", **extra):
    meta = {"backend": "runner", "crew": True}
    if owner is not None:
        meta["owner"] = owner
    meta.update(extra)
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=meta,
                           avatar_url=None, avatar_emoji=None)


def _brigade(agent_id="majik", metadata=None):
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=metadata,
                           avatar_url=None, avatar_emoji=None)


def _webhook(room_name="hub-fa65c5631810"):
    return SimpleNamespace(id=uuid.uuid4(), username=f"webhook-{room_name}", keycloak_sub=f"webhook:{room_name}",
                           display_name="Forgejo CI", participant_type=ParticipantType.AGENT, metadata_=None,
                           avatar_url=None, avatar_emoji=None)


def _members(*participants):
    return [SimpleNamespace(participant=p, participant_id=getattr(p, "id", None), agent_mode=None) for p in participants]


AARON, JORDAN, SHAFEN = _human("aaron"), _human("jordan"), _human("shafenkhan")


PERSEPHONE, FLOW, MAJIK = _seat(), _seat("flow", ["shafen", "shafenkhan"]), _brigade()


class _Result:
    def __init__(self, *, scalar=None, scalars=None, rows=None, rowcount=1):
        self._scalar, self._scalars, self._rows, self.rowcount = scalar, list(scalars or []), list(rows or []), rowcount

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return SimpleNamespace(all=lambda: list(self._scalars))

    def all(self):
        return list(self._rows)

    def one_or_none(self):
        return self._rows[0] if self._rows else None


class _Savepoint:
    """What ``session.begin_nested()`` hands back: an async context manager."""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


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
# P1-2 — floors come only from what was written
# ---------------------------------------------------------------------------


class P1_2_FloorsComeOnlyFromWhatWasWritten(IsolatedAsyncioTestCase):
    async def _classify(self, room, asking, history_senders, agent_id="persephone", actors=()):
        db = AsyncMock()
        results = [_Result(scalars=["persephone", "flow"]), _Result(rows=[(room.id, history_senders, False)])]
        if actors:
            results.append(_Result(rows=[(a.id, a.participant_type, a.username, a.keycloak_sub, a.display_name, a.metadata_, None) for a in actors]))
        results.append(_Result())  # a floor stamp, should one be attempted
        db.execute = AsyncMock(side_effect=results)
        db.commit = AsyncMock()
        facts = await G._classify_for_seat(db, room, asking, agent_id)
        return facts, db

    async def test_the_review3_repro_member_row_is_the_asking_row_is_an_unowned_seat(self) -> None:
        seat = _seat("persephone", owner=None)  # before her row has an owner
        room = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, seat))
        facts, db = await self._classify(room, seat, [AARON.id, seat.id])
        self.assertEqual(facts.room_class, "shared")        # read shared, live
        self.assertEqual(_floor_updates(db), [])             # …and nothing written
        db.commit.assert_not_awaited()
        self.assertNotIn("class_floor", room.metadata_)
        self.assertFalse(facts.history_shared)
        # Once the row is owned, the very same room reads private.
        seat.metadata_["owner"] = "aaron"
        facts, db = await self._classify(room, seat, [AARON.id, seat.id])
        self.assertEqual(facts.room_class, "private")
        self.assertEqual(_floor_updates(db), [])

    async def test_a_new_seat_minted_without_owner_never_floors_by_reading(self) -> None:
        new_seat = _seat("house-voice", owner=None)
        room = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE, new_seat))
        facts, db = await self._classify(room, new_seat, [AARON.id, PERSEPHONE.id], agent_id="house-voice")
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual(_floor_updates(db), [])

    async def test_a_silent_human_leaves_no_floor_and_the_class_returns_to_private(self) -> None:
        with_gina = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE, JORDAN))
        facts, db = await self._classify(with_gina, PERSEPHONE, [AARON.id, PERSEPHONE.id])
        self.assertEqual(facts.room_class, "shared")         # while she sits in the room
        self.assertIn("humans_2", facts.reasons)
        self.assertEqual(_floor_updates(db), [])
        db.commit.assert_not_awaited()
        self.assertNotIn("class_floor", with_gina.metadata_)
        self.assertFalse(facts.history_shared)
        # Jordan is removed without having written: same room, same history.
        after = SimpleNamespace(id=with_gina.id, room_type=HUB, metadata_=with_gina.metadata_, members=_members(AARON, PERSEPHONE))
        facts, db = await self._classify(after, PERSEPHONE, [AARON.id, PERSEPHONE.id])
        self.assertEqual(facts.room_class, "private")
        self.assertEqual(facts.reasons, ())

    async def test_a_member_who_did_write_floors_the_room(self) -> None:
        """PIN (already true on 5ee32e9, where only the last line is new):
        the floor is still written when a second party really wrote."""
        room = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE))
        facts, db = await self._classify(room, PERSEPHONE, [AARON.id, PERSEPHONE.id, JORDAN.id], actors=[JORDAN])
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual(len(_floor_updates(db)), 1)
        db.commit.assert_awaited_once()
        self.assertEqual(room.metadata_["class_floor"], "shared")
        self.assertTrue(facts.history_shared)

    def test_history_verdict_is_about_parties_and_nothing_else(self) -> None:
        verdict = lambda *authors, keys=(): RC.history_verdict(list(authors), key_agent_ids=keys)  # noqa: E731
        self.assertEqual(verdict(AARON, PERSEPHONE, MAJIK), (False, ()))
        self.assertEqual(verdict(), (False, ()))
        self.assertEqual(verdict(PERSEPHONE), (False, ()))                         # only the seat has written
        self.assertEqual(verdict(AARON, _seat("x", owner=None)), (False, ()))      # unowned seat: unprovisioned
        self.assertEqual(verdict(_seat("x", owner=None)), (False, ()))
        self.assertEqual(verdict(SHAFEN, FLOW), (False, ()))                       # one party: Shafen's
        self.assertEqual(verdict(AARON, JORDAN), (True, ("parties",)))
        self.assertEqual(verdict(AARON, FLOW), (True, ("parties",)))
        self.assertEqual(verdict(PERSEPHONE, FLOW), (True, ("parties",)))
        self.assertEqual(verdict(AARON, _webhook()), (True, ("foreign_agent",)))
        self.assertEqual(verdict(AARON, _guest()), (True, ("guest_human",)))
        self.assertEqual(verdict(AARON, None), (True, ("unattributed_actor",)))
        self.assertEqual(verdict(AARON, _guest(), JORDAN, None), (True, ("guest_human", "unattributed_actor", "parties")))
        # An agent that is neither house nor anybody's seat (a service account).
        service = SimpleNamespace(id=uuid.uuid4(), username="agent-triage", keycloak_sub="3f0c-kc-uuid", display_name="Triage",
                                  participant_type=ParticipantType.AGENT, metadata_={})
        self.assertEqual(verdict(AARON, service), (True, ("foreign_agent",)))
        relay = _seat("texts-relay", owner=None, kind="integration")
        self.assertEqual(verdict(AARON, relay), (True, ("integration",)))
        # The asker and the members are not inputs at all.
        facts = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE, JORDAN, FLOW), asking_seat=FLOW, historical=[AARON, PERSEPHONE])
        self.assertEqual((facts.room_class, facts.history_shared), ("shared", False))

    def test_a_seat_nobody_has_claimed_yet_never_floors_whatever_its_row_looks_like(self) -> None:
        """"Unowned seat row" in every shape it takes: runner-backed, a
        brigade id that holds a key, a dev-* identity. Each reads shared
        LIVE and leaves the floor alone; each is judged by its owner once it
        has one, even under a stale ``backend``."""
        runner = _seat("house-voice", owner=None)
        key_holder = _brigade("perry", {"backend": "brigade"})            # exists in both worlds, key minted
        bare_key_holder = _brigade("tern", None)
        dev = _brigade("dev-jordan", {"backend": "runner"})
        for row in (runner, key_holder, bare_key_holder, dev):
            keys = {"house-voice", "perry", "tern"}
            facts = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), key_agent_ids=keys, asking_seat=PERSEPHONE,
                                        historical=[AARON, PERSEPHONE, row])
            self.assertEqual((facts.room_class, facts.history_shared), ("shared", False), row.username)
            self.assertFalse(RC.insert_floors_room(HUB, row, key_agent_ids=keys), row.username)
        # Claimed by Aaron: his party. Claimed by Shafen: two parties.
        mine = _brigade("perry", {"backend": "brigade", "owner": "aaron"})
        theirs = _brigade("perry", {"backend": "brigade", "owner": ["shafen", "shafenkhan"]})
        self.assertEqual(RC.history_verdict([AARON, mine], key_agent_ids={"perry"}), (False, ()))
        self.assertEqual(RC.history_verdict([AARON, theirs], key_agent_ids={"perry"}), (True, ("parties",)))
        # Without a key the same bare row is a house agent: nobody's party.
        self.assertEqual(RC.history_verdict([AARON, bare_key_holder], key_agent_ids=set()), (False, ()))
        self.assertTrue(RC.is_house_agent(bare_key_holder, set()))

    def test_one_foreign_party_alone_in_the_history_is_shared_live_without_a_floor(self) -> None:
        # Only Mallory ever wrote; Aaron and Persephone are the members now.
        mallory = _human("mallory")
        facts = RC.room_class_facts(HUB, _members(AARON, PERSEPHONE), asking_seat=PERSEPHONE, historical=[mallory])
        self.assertEqual(facts.room_class, "shared")
        self.assertFalse(facts.history_shared)

    async def _send(self, author, members, *, room_type=HUB, metadata=None):
        from app.services.message_service import MessageService

        rows = [(SimpleNamespace(participant_id=p.id, mention_count=0, has_unread_mention=False), p) for p in members]

        async def stamp(obj):
            obj.created_at = NOW

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=SimpleNamespace(is_muted=False)), _Result(rows=rows), _Result(scalar=author),
            _Result(rows=[("stable-hub", room_type, False, None, metadata or {})]), _Result(),
        ])
        db.add = MagicMock()
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.begin_nested = MagicMock(return_value=_Savepoint())
        db.refresh = AsyncMock(side_effect=stamp)
        await MessageService(db=db, livekit=AsyncMock()).send_message(
            room_id=uuid.uuid4(), sender_id=author.id, content="hello", content_type="text")
        db.rollback.assert_not_awaited()                   # a send never rolls the session back
        return db

    async def test_the_insert_rule_judges_the_author_never_the_membership(self) -> None:
        unowned = _seat("persephone", owner=None)
        hook, guest = _webhook(), _guest()
        # Aaron's own line while Jordan sits in the hub.
        self.assertEqual(_floor_updates(await self._send(AARON, [AARON, PERSEPHONE, JORDAN])), [])
        # Jordan's own line (a second human): decided by the history on read, not here.
        self.assertEqual(_floor_updates(await self._send(JORDAN, [AARON, PERSEPHONE, JORDAN])), [])
        # First post by a seat whose row has no owner.
        self.assertEqual(_floor_updates(await self._send(unowned, [AARON, unowned])), [])
        # Someone else's seat, and the owner's own seat.
        self.assertEqual(_floor_updates(await self._send(FLOW, [AARON, PERSEPHONE, FLOW])), [])
        self.assertEqual(_floor_updates(await self._send(PERSEPHONE, [AARON, PERSEPHONE, JORDAN])), [])
        # Authors that are foreign by nature DO floor, at insert.
        self.assertEqual(len(_floor_updates(await self._send(hook, [AARON, PERSEPHONE, hook]))), 1)
        self.assertEqual(len(_floor_updates(await self._send(guest, [AARON, PERSEPHONE, guest]))), 1)
        # …but never a channel, and never twice.
        self.assertEqual(_floor_updates(await self._send(hook, [AARON, hook], room_type=RoomType.CHANNEL)), [])
        self.assertEqual(_floor_updates(await self._send(hook, [AARON, hook], metadata={"class_floor": "shared"})), [])

    async def test_a_thread_seed_floors_at_birth_only_when_its_author_is_foreign_by_nature(self) -> None:
        from app.services.room_service import RoomService

        parent = SimpleNamespace(id=uuid.uuid4(), name="crew", room_type=RoomType.GROUP_DM, parent_room_id=None,
                                 is_archived=False, metadata_={}, org_id=None, max_participants=50, visibility="public",
                                 recording_policy="off", recording_kind="audio", project_number=None, updated_at=NOW)

        async def thread_meta(seed_author):
            seed = SimpleNamespace(id=uuid.uuid4(), sender_id=getattr(seed_author, "id", None), sender=seed_author, content="ship it", created_at=NOW)
            db = AsyncMock()
            db.execute = AsyncMock(side_effect=[
                _Result(scalar=parent), _Result(scalar=SimpleNamespace()), _Result(scalar=seed),
                _Result(rows=[(SimpleNamespace(agent_mode="answers_all"), PERSEPHONE), (SimpleNamespace(agent_mode=None), SHAFEN)]),
            ])
            db.add = MagicMock()
            db.commit = AsyncMock()
            db.refresh = AsyncMock()
            svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
            svc.create_room = AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4(), name="crew-t-1", metadata_={}, parent_room_id=None))
            await svc.create_thread(parent_id=parent.id, creator_id=AARON.id, seed_message_id=seed.id)
            return svc.create_room.await_args.kwargs["metadata"]

        self.assertNotIn("class_floor", await thread_meta(SHAFEN))     # a human's line: judged on read
        self.assertNotIn("class_floor", await thread_meta(AARON))
        self.assertEqual((await thread_meta(_webhook("crew")))["class_floor"], "shared")
        self.assertEqual((await thread_meta(None))["class_floor"], "shared")   # the author is gone


# ---------------------------------------------------------------------------
# P2-1 — the notice rule on REAL SQL semantics (sqlite), and the mutations
# ---------------------------------------------------------------------------


class P2_1_NoticeRuleOnRealSql(TestCase):
    """The production predicate (:func:`room_class.foreign_null_line`) run by
    a real SQL engine over rows that exercise three-valued logic. ``kind``
    stands for ``metadata->>'kind'``, which Postgres returns as NULL for a
    missing key, a JSON null, or NULL metadata."""

    ROWS = [
        # id,                     sender_id, content_type, kind,          foreign?
        ("recording_notice",      None,      "system",     "recording",   False),
        ("system_without_kind",   None,      "system",     None,          True),
        ("system_other_kind",     None,      "system",     "thread_seed", True),
        ("system_started_kind",   None,      "system",     "thread_started", True),
        ("text_without_kind",     None,      "text",       None,          True),
        ("text_claiming_notice",  None,      "text",       "recording",   True),
        ("attributed_system",     "p1",      "system",     None,          False),  # has a sender: not a NULL line
        ("attributed_text",       "p1",      "text",       None,          False),
    ]

    def _flagged(self, notice_kinds=RC.SYSTEM_NOTICE_KINDS, predicate=None) -> set[str]:
        engine = sa.create_engine("sqlite://")
        meta = sa.MetaData()
        lines = sa.Table("lines", meta, sa.Column("id", sa.String, primary_key=True), sa.Column("sender_id", sa.String, nullable=True),
                         sa.Column("content_type", sa.String, nullable=False), sa.Column("kind", sa.String, nullable=True))
        meta.create_all(engine)
        with engine.begin() as conn:
            conn.execute(lines.insert(), [dict(id=i, sender_id=s, content_type=c, kind=k) for i, s, c, k, _f in self.ROWS])
            where = (predicate or RC.foreign_null_line)(lines.c.sender_id, lines.c.content_type, lines.c.kind,
                                                        system_value="system", notice_kinds=notice_kinds)
            return {row[0] for row in conn.execute(sa.select(lines.c.id).where(where))}

    def test_only_a_system_recording_notice_is_house(self) -> None:
        self.assertEqual(self._flagged(), {i for i, _s, _c, _k, foreign in self.ROWS if foreign})
        self.assertEqual(RC.SYSTEM_NOTICE_KINDS, ("recording",))

    def test_the_three_valued_hole_is_what_this_catches(self) -> None:
        """The 5ee32e9 rule, verbatim (no COALESCE): it misses the NULL-kind
        system line — which is exactly the row the fixed rule flags."""
        def old_rule(sender_id, content_type, kind_text, *, system_value, notice_kinds):
            return sa.and_(sender_id.is_(None), sa.not_(sa.and_(content_type == system_value, kind_text.in_(list(notice_kinds)))))

        self.assertNotIn("system_without_kind", self._flagged(predicate=old_rule))
        self.assertIn("system_without_kind", self._flagged())

    def test_widening_the_house_rule_fails(self) -> None:
        """The review's mutations M1 (and_ → or_) and M2 (more kinds) change
        the flagged set, so a test that pins the set catches them."""
        def or_rule(sender_id, content_type, kind_text, *, system_value, notice_kinds):
            is_notice = sa.or_(content_type == system_value, kind_text.in_(list(notice_kinds)))
            return sa.and_(sender_id.is_(None), sa.not_(sa.func.coalesce(is_notice, False)))

        expected = {i for i, _s, _c, _k, foreign in self.ROWS if foreign}
        self.assertNotEqual(self._flagged(predicate=or_rule), expected)
        self.assertNotEqual(self._flagged(notice_kinds=("recording", "thread_seed", "thread_started")), expected)

    def test_the_production_statement_uses_the_null_safe_predicate(self) -> None:
        sql = _sql(RC.history_statement([uuid.uuid4()]))
        self.assertIn("not coalesce(messages.content_type =", sql)
        self.assertIn("(messages.metadata ->>", sql)
        params = RC.history_statement([uuid.uuid4()]).compile(dialect=postgresql.dialect()).params
        self.assertIs(params["coalesce_1"], False)          # an unknown verdict is "not a notice"
        self.assertEqual(params["metadata_1"], "kind")
        self.assertEqual([getattr(v, "value", v) for v in params["param_2"]], ["recording"])


# ---------------------------------------------------------------------------
# P2-2 / P2-3 — index-only history, top-1 last_message_at, statement counts
# ---------------------------------------------------------------------------


class _CountingDb:
    def __init__(self, results):
        self._results = list(results)
        self.statements: list = []
        self.commits = 0

    async def execute(self, stmt, *_a, **_kw):
        self.statements.append(stmt)
        return self._results.pop(0)

    async def commit(self):
        self.commits += 1


class P2_2_3_CostOfAPollAndOfTheRoomsList(IsolatedAsyncioTestCase):
    def test_the_sender_read_touches_only_room_id_and_sender_id(self) -> None:
        sql = _sql(RC.history_statement([uuid.uuid4()]))
        senders = sql[sql.index("(select array_agg"): sql.index("as anon_1")]
        self.assertIn("array_agg(distinct messages.sender_id)", senders)
        self.assertIn("messages.room_id = rooms.id", senders)
        self.assertIn("messages.sender_id is not null", senders)
        for column in ("content_type", "metadata", "is_deleted", "created_at", "content "):
            self.assertNotIn(column, senders)               # index-only on (room_id, sender_id)
        self.assertNotIn("is_deleted", sql)                 # deleted lines were still read
        self.assertNotIn("bool_or", sql)
        self.assertNotIn("group by", sql)
        exists = sql[sql.index("exists (select"):]
        self.assertIn("messages.sender_id is null", exists)  # bounded: NULL-sender rows only
        self.assertIn("messages.room_id = rooms.id", exists)

    def test_last_message_at_is_a_per_room_top_one(self) -> None:
        sql = _sql(G.seat_rooms_statement(uuid.uuid4()))
        self.assertIn("select messages.created_at", sql)
        self.assertIn("messages.room_id = rooms.id", sql)
        self.assertIn("order by messages.created_at desc", sql)
        self.assertIn("limit", sql)
        self.assertNotIn("max(", sql)
        self.assertFalse(hasattr(G, "_last_message_at"))

    async def test_classifying_a_poll_costs_nothing_when_floored_or_a_channel(self) -> None:
        for room in (
            SimpleNamespace(id=uuid.uuid4(), room_type=HUB, metadata_={"class_floor": "shared"}, members=_members(AARON, PERSEPHONE)),
            SimpleNamespace(id=uuid.uuid4(), room_type=RoomType.CHANNEL, metadata_={}, members=_members(AARON, SHAFEN, PERSEPHONE)),
        ):
            db = _CountingDb([])
            facts = await G._classify_for_seat(db, room, PERSEPHONE, "persephone")
            self.assertEqual(len(db.statements), 0)
            self.assertIn(facts.room_class, ("shared", "channel"))

    async def test_classifying_a_poll_of_a_private_hub_costs_two_statements(self) -> None:
        """PIN (already two on 5ee32e9): the count did not grow; what changed
        is what the second statement costs."""
        room = SimpleNamespace(id=uuid.uuid4(), room_type=HUB, metadata_={}, members=_members(AARON, PERSEPHONE))
        db = _CountingDb([_Result(scalars=["persephone"]), _Result(rows=[(room.id, [AARON.id, PERSEPHONE.id], False)])])
        facts = await G._classify_for_seat(db, room, PERSEPHONE, "persephone")
        self.assertEqual(facts.room_class, "private")
        self.assertEqual(len(db.statements), 2)   # key ids, history
        self.assertEqual(db.commits, 0)

    async def test_the_rooms_list_costs_six_statements_unfloored_and_four_floored(self) -> None:
        def room_row(rid, floored):
            return (rid, "hub-1", "stable-hub-1", "Persephone", HUB, None, {"class_floor": "shared"} if floored else {}, NOW, False, NOW)

        def member_rows(rid):
            return [(rid, p.id, None, p.id, p.participant_type, p.username, p.keycloak_sub, p.display_name, p.metadata_) for p in (AARON, PERSEPHONE)]

        principal = SimpleNamespace(agent_id="persephone", allowed_rooms=["*"], auth_kind="key", human_sub=None)
        rid = uuid.uuid4()
        db = _CountingDb([_Result(scalar=PERSEPHONE), _Result(rows=[room_row(rid, False)]), _Result(scalars=[rid]),
                          _Result(rows=member_rows(rid)), _Result(scalars=["persephone"]), _Result(rows=[(rid, [AARON.id], False)])])
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            rows = await G.gateway_list_rooms(principal=principal, db=db, redis=AsyncMock())
        self.assertEqual((rows[0].room_class, rows[0].last_message_at), ("private", NOW))
        self.assertEqual(len(db.statements), 6)   # seat, rooms(+last_at), owner-present, members, key ids, history
        db = _CountingDb([_Result(scalar=PERSEPHONE), _Result(rows=[room_row(rid, True)]), _Result(scalars=[rid]), _Result(rows=member_rows(rid))])
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            rows = await G.gateway_list_rooms(principal=principal, db=db, redis=AsyncMock())
        self.assertEqual(rows[0].room_class, "shared")
        self.assertEqual(len(db.statements), 4)   # seat, rooms(+last_at), owner-present, members
