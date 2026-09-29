"""Nav v3 C3 — the crew (design §2.0 / §2.1).

Own seats (``metadata.owner`` == the caller), house agents (Brigade, via a
hub or agent DM), partner seats (someone else's, sharing a room); guest
agents and integrations never. Ranking: own seats → house agents heard from
in the last 14 days → partners → the rest by name. ``/home/summary`` reuses
the builder and keeps the CrewCard shape; the New picker lists the crew's
runner seats instead of a fixed allowlist.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.api import brigade as brigade_api
from app.api import home
from app.api.crew import CrewRow, crew_row, router as crew_router
from app.models.participant import ParticipantStatus, ParticipantType
from app.models.room import RoomType
from app.services import crew as C

NOW = datetime(2026, 9, 28, 22, 0, tzinfo=timezone.utc)


def _agent(agent_id, *, backend="runner", crew=True, owner="aaron", kind=None,
           status=ParticipantStatus.ONLINE, display=None, extra=None):
    meta = {}
    if backend:
        meta["backend"] = backend
    if crew:
        meta["crew"] = True
    if owner:
        meta["owner"] = owner
    if kind:
        meta["kind"] = kind
    meta.update(extra or {})
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=f"agent-{agent_id}",
        keycloak_sub=f"brigade:{agent_id}",
        display_name=display or agent_id.replace("-", " ").title(),
        participant_type=ParticipantType.AGENT,
        status=status,
        metadata_=meta,
        avatar_url=None,
    )


def _brigade(agent_id, **kw):
    return _agent(agent_id, backend=None, crew=False, owner=None, status=ParticipantStatus.OFFLINE, **kw)


def _row(participant, room_type=RoomType.AGENT_HUB, mode="answers_all"):
    room = SimpleNamespace(id=uuid.uuid4(), room_type=room_type)
    return (participant, SimpleNamespace(agent_mode=mode), room)


def _msg(participant, days_ago, text="On it."):
    return SimpleNamespace(sender_id=participant.id, content=text, created_at=NOW - timedelta(days=days_ago))


def _heartbeat(identity, minutes_ago):
    return SimpleNamespace(
        agent_identity=identity, event_type="worker_heartbeat", event_data={},
        occurred_at=NOW - timedelta(minutes=minutes_ago),
    )


class CrewMembershipAndRanking(TestCase):
    def _crew(self, *, runner_seats=(), live=None, rows=(), messages=(), unread=None, events=(), caller="aaron", roles=None):
        return C.rank_crew(
            C.assemble_crew(
                now=NOW,
                caller_username=caller,
                runner_seats=list(runner_seats),
                live_key_agent_ids=set(live or ()),
                shared_rows=list(rows),
                last_messages={str(m.sender_id): m for m in messages},
                unread_by_room=dict(unread or {}),
                events=list(events),
                brigade_roles=roles,
            ),
            NOW,
        )

    def test_own_seats_first_then_recent_house_then_partners_then_the_rest(self) -> None:
        persephone = _agent("persephone")
        grok = _agent("grok")  # own seat, no room shared yet
        flow = _agent("flow", owner="shafen")
        majik = _brigade("majik")
        gunny = _brigade("gunny")
        perry = _brigade("perry")
        rows = [
            _row(persephone),
            _row(flow, RoomType.CHANNEL, mode=None),
            _row(majik),
            _row(gunny, RoomType.DM),
            _row(perry),
        ]
        crew = self._crew(
            runner_seats=[persephone, grok],
            live=["persephone", "grok", "flow"],
            rows=rows,
            messages=[_msg(gunny, 1), _msg(majik, 3), _msg(perry, 40), _msg(grok, 2), _msg(persephone, 0)],
        )
        self.assertEqual(
            [(e.agent_id, e.group) for e in crew],
            [
                ("persephone", "own_seat"),
                ("grok", "own_seat"),
                ("gunny", "house"),
                ("majik", "house"),
                ("flow", "partner"),
                ("perry", "house"),  # last heard 40 days ago → the rest
            ],
        )
        by_id = {e.agent_id: e for e in crew}
        self.assertEqual((by_id["persephone"].kind, by_id["persephone"].owner), ("seat", "aaron"))
        self.assertEqual((by_id["flow"].kind, by_id["flow"].owner), ("seat", "shafen"))
        self.assertEqual((by_id["majik"].kind, by_id["majik"].owner), ("brigade", None))
        self.assertEqual(by_id["persephone"].hub_room_id, str(rows[0][2].id))
        self.assertIsNone(by_id["grok"].hub_room_id)
        self.assertEqual(by_id["gunny"].last_line, "On it.")

    def test_integrations_and_guest_agents_never_appear(self) -> None:
        webhook = _agent("webhook-dev-stable", kind="integration")
        relay = _agent("texts-relay", kind="integration", crew=False)
        visitor = _brigade("visitor-claude", kind="guest_agent")
        persephone = _agent("persephone")
        crew = self._crew(
            runner_seats=[webhook, relay, persephone],
            live=["webhook-dev-stable", "texts-relay", "persephone"],
            rows=[_row(webhook), _row(relay), _row(visitor), _row(persephone)],
        )
        self.assertEqual([e.agent_id for e in crew], ["persephone"])

    def test_a_runner_seat_needs_the_crew_flag_and_a_live_key(self) -> None:
        unflagged = _agent("claude-dev", crew=False)
        revoked = _agent("zen")  # flagged, but no live key
        persephone = _agent("persephone")
        crew = self._crew(
            runner_seats=[unflagged, revoked, persephone],
            live=["persephone", "claude-dev"],
            rows=[_row(unflagged), _row(revoked), _row(persephone)],
        )
        self.assertEqual([e.agent_id for e in crew], ["persephone"])

    def test_a_house_agent_needs_a_hub_or_dm_not_just_a_channel(self) -> None:
        majik = _brigade("majik")
        crew = self._crew(rows=[_row(majik, RoomType.CHANNEL, mode=None)])
        self.assertEqual(crew, [])
        crew = self._crew(rows=[_row(majik, RoomType.DM)])
        self.assertEqual([(e.agent_id, e.group) for e in crew], [("majik", "house")])

    def test_partner_needs_a_shared_room_and_someone_elses_owner(self) -> None:
        flow = _agent("flow", owner="shafen")
        # Not shared with the caller → not listed at all.
        self.assertEqual(self._crew(runner_seats=[flow], live=["flow"]), [])
        crew = self._crew(runner_seats=[flow], live=["flow"], rows=[_row(flow, RoomType.GROUP_DM, mode=None)])
        self.assertEqual([(e.agent_id, e.group, e.owner) for e in crew], [("flow", "partner", "shafen")])
        # No owner at all is still a partner when it shares a room.
        orphan = _agent("orphan", owner=None)
        crew = self._crew(runner_seats=[orphan], live=["orphan"], rows=[_row(orphan, RoomType.GROUP_DM, mode=None)])
        self.assertEqual([(e.group, e.owner) for e in crew], [("partner", None)])

    def test_presence_from_a_fresh_heartbeat_or_online_status(self) -> None:
        persephone = _agent("persephone", status=ParticipantStatus.OFFLINE)
        rook = _agent("claude-code", status=ParticipantStatus.OFFLINE)
        grok = _agent("grok", status=ParticipantStatus.ONLINE)
        crew = self._crew(
            runner_seats=[persephone, rook, grok],
            live=["persephone", "claude-code", "grok"],
            events=[_heartbeat("agent-persephone", 2), _heartbeat("brigade:claude-code", 9)],
        )
        by_id = {e.agent_id: e for e in crew}
        self.assertEqual(by_id["persephone"].presence, "online")
        self.assertEqual(by_id["persephone"].status, "online")
        self.assertEqual(by_id["claude-code"].presence, "offline")  # 9 min > 6 min
        self.assertEqual(by_id["grok"].presence, "online")

    def test_unread_role_line_and_capabilities(self) -> None:
        caps = {"harness": "claude-code", "default_model": "claude-fable-5-1", "default_effort": "high",
                "models": [], "efforts": ["low", "medium", "high", "max"]}
        persephone = _agent("persephone", extra={"seat_capabilities": caps, "description": "Aaron's main assistant"})
        majik = _brigade("majik", extra={"title": "House DJ"})
        hub = _row(persephone)
        crew = self._crew(
            runner_seats=[persephone], live=["persephone"], rows=[hub, _row(majik)],
            unread={str(hub[2].id): 3}, roles={"majik": "House DJ — runs the radio"},
        )
        by_id = {e.agent_id: e for e in crew}
        self.assertEqual(by_id["persephone"].unread, 3)
        self.assertEqual(by_id["persephone"].seat_capabilities, caps)
        self.assertEqual(by_id["persephone"].role_line, "Aaron's main assistant")
        self.assertEqual(by_id["majik"].role_line, "House DJ — runs the radio")
        self.assertEqual(by_id["majik"].unread, 0)
        self.assertIsNone(by_id["majik"].seat_capabilities)

    def test_owner_match_is_case_insensitive_and_needs_a_caller(self) -> None:
        persephone = _agent("persephone", owner="Aaron ")
        crew = self._crew(runner_seats=[persephone], live=["persephone"], caller="AARON")
        self.assertEqual([e.group for e in crew], ["own_seat"])
        self.assertEqual(self._crew(runner_seats=[persephone], live=["persephone"], caller=None), [])

    def test_role_lines_from_brigade_roster(self) -> None:
        roster = {"agents": [
            {"id": "majik", "title": "House DJ", "bio": "Runs the radio."},
            {"id": "gunny", "bio": "Ops."},
            {"id": "blank"},
            "junk",
        ]}
        self.assertEqual(
            C.role_lines_from_roster(roster),
            {"majik": "House DJ — Runs the radio.", "gunny": "Ops."},
        )


class HomeCrewReusesTheBuilder(IsolatedAsyncioTestCase):
    async def test_home_crew_maps_entries_to_crew_cards_under_the_cap(self) -> None:
        entries = [
            C.CrewEntry(
                agent_id=f"a{i}", participant_id=str(uuid.uuid4()), display_name=f"A{i}", avatar_url=None,
                role_line=None, backend="runner", kind="seat", owner="aaron", group="own_seat",
                presence="online", hub_room_id="hub", seat_capabilities=None, last_line="hi",
                last_at=NOW, unread=0, status="online", agent_mode="answers_all",
                current_task="deploy", since=NOW,
            )
            for i in range(home.CREW_CAP + 5)
        ]
        with patch.object(home, "build_crew", new=AsyncMock(return_value=entries)) as build:
            cards = await home._crew(AsyncMock(), uuid.uuid4(), NOW)
        build.assert_awaited_once()
        self.assertEqual(len(cards), home.CREW_CAP)
        card = cards[0]
        self.assertIsInstance(card, home.CrewCard)
        self.assertEqual(
            (card.agent_id, card.status, card.agent_mode, card.current_task, card.last_line, card.hub_room_id),
            ("a0", "online", "answers_all", "deploy", "hi", "hub"),
        )
        self.assertEqual(card.since, NOW)

    def test_crew_route_and_row_shape(self) -> None:
        self.assertEqual([r.path for r in crew_router.routes], ["/crew"])
        entry = C.CrewEntry(
            agent_id="persephone", participant_id="p", display_name="Persephone", avatar_url=None,
            role_line="Main assistant", backend="runner", kind="seat", owner="aaron", group="own_seat",
            presence="online", hub_room_id="hub", seat_capabilities={"harness": "claude-code"},
            last_line="On it.", last_at=NOW, unread=2, status="online", agent_mode="answers_all",
            current_task=None, since=None,
        )
        dumped = crew_row(entry).model_dump(mode="json")
        self.assertEqual(
            set(dumped),
            {"agent_id", "participant_id", "display_name", "avatar_url", "role_line", "backend", "kind",
             "owner", "group", "presence", "hub_room_id", "seat_capabilities", "last_line", "last_at", "unread"},
        )
        self.assertEqual((dumped["kind"], dumped["owner"], dumped["group"], dumped["unread"]), ("seat", "aaron", "own_seat", 2))
        self.assertIsInstance(crew_row(entry), CrewRow)


class BuildCrewWiring(IsolatedAsyncioTestCase):
    """build_crew's query order against a fake session: username, live keys,
    crew-flagged seats, shared rows, last messages, unread (hubs), events."""

    async def test_query_order_and_result(self) -> None:
        persephone = _agent("persephone")
        hub = _row(persephone)
        message = _msg(persephone, 0, "Deploying now.")

        def res(*, scalar=None, scalars=None, rows=None):
            r = MagicMock()
            r.scalar_one_or_none.return_value = scalar
            r.scalars.return_value.all.return_value = list(scalars or [])
            r.all.return_value = list(rows or [])
            return r

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            res(scalar="aaron"),                       # caller username
            res(scalars=["persephone", "rook"]),       # live key agent ids
            res(scalars=[persephone]),                 # crew-flagged runner seats
            res(rows=[hub]),                           # shared rows
            res(scalars=[message]),                    # last messages
            res(rows=[(hub[2].id, 4)]),                # unread in hubs
            res(scalars=[_heartbeat("agent-persephone", 1)]),  # events
        ])
        crew = await C.build_crew(db, uuid.uuid4(), NOW)
        self.assertEqual(db.execute.await_count, 7)
        self.assertEqual(len(crew), 1)
        entry = crew[0]
        self.assertEqual((entry.agent_id, entry.group, entry.unread, entry.last_line, entry.presence),
                         ("persephone", "own_seat", 4, "Deploying now.", "online"))

    async def test_empty_crew_stops_after_membership_queries(self) -> None:
        def res(*, scalar=None, scalars=None, rows=None):
            r = MagicMock()
            r.scalar_one_or_none.return_value = scalar
            r.scalars.return_value.all.return_value = list(scalars or [])
            r.all.return_value = list(rows or [])
            return r

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[res(scalar="aaron"), res(scalars=[]), res(scalars=[]), res(rows=[])])
        self.assertEqual(await C.build_crew(db, uuid.uuid4(), NOW), [])
        self.assertEqual(db.execute.await_count, 4)


class NewPickerListsTheCrewsSeats(IsolatedAsyncioTestCase):
    def test_the_allowlist_is_gone(self) -> None:
        self.assertFalse(hasattr(brigade_api, "_BRIDGE_CREW_AGENTS"))

    async def test_bridge_crew_agents_come_from_the_callers_crew(self) -> None:
        entries = [
            C.CrewEntry(
                agent_id="persephone", participant_id="p", display_name="Persephone", avatar_url=None,
                role_line="Main assistant", backend="runner", kind="seat", owner="aaron", group="own_seat",
                presence="online", hub_room_id=None, seat_capabilities=None, last_line=None, last_at=None,
                unread=0, status="online", agent_mode=None, current_task=None, since=None,
            ),
            C.CrewEntry(
                agent_id="flow", participant_id="f", display_name="Flow", avatar_url=None,
                role_line=None, backend="runner", kind="seat", owner="shafen", group="partner",
                presence="offline", hub_room_id=None, seat_capabilities=None, last_line=None, last_at=None,
                unread=0, status="offline", agent_mode=None, current_task=None, since=None,
            ),
        ]
        with patch.object(brigade_api, "crew_runner_seats_for", new=AsyncMock(return_value=entries)) as seats:
            agents = await brigade_api._fetch_bridge_crew_agents(AsyncMock(), {"participant_id": uuid.uuid4()})
        seats.assert_awaited_once()
        self.assertEqual([(a.id, a.name, a.description) for a in agents],
                         [("persephone", "Persephone", "Main assistant"), ("flow", "Flow", "")])

    async def test_without_a_caller_every_live_crew_seat_is_listed(self) -> None:
        seat = _agent("persephone", extra={"description": "Main assistant"})
        with patch.object(brigade_api, "list_crew_runner_seats", new=AsyncMock(return_value=[seat])):
            agents = await brigade_api._fetch_bridge_crew_agents(AsyncMock())
        self.assertEqual([(a.id, a.name, a.description) for a in agents], [("persephone", "Persephone", "Main assistant")])

    async def test_brigade_outage_degrades_to_the_seats_and_re_raises_without_them(self) -> None:
        seat = brigade_api.BrigadeAgent(id="persephone", name="Persephone")
        boom = HTTPException(502, "Could not reach Brigade")
        with patch.object(brigade_api, "_fetch_bridge_crew_agents", new=AsyncMock(return_value=[seat])), \
             patch.object(brigade_api, "_fetch_brigade_agents", new=AsyncMock(side_effect=boom)):
            agents = await brigade_api._fetch_invitable_agents(AsyncMock(), {"participant_id": uuid.uuid4()})
        self.assertEqual([a.id for a in agents], ["persephone"])
        with patch.object(brigade_api, "_fetch_bridge_crew_agents", new=AsyncMock(return_value=[])), \
             patch.object(brigade_api, "_fetch_brigade_agents", new=AsyncMock(side_effect=boom)):
            with self.assertRaises(HTTPException):
                await brigade_api._fetch_invitable_agents(AsyncMock())

    async def test_roster_merge_keeps_brigade_first(self) -> None:
        seat = brigade_api.BrigadeAgent(id="persephone", name="Persephone")
        majik = brigade_api.BrigadeAgent(id="majik", name="Majik")
        with patch.object(brigade_api, "_fetch_bridge_crew_agents", new=AsyncMock(return_value=[seat])), \
             patch.object(brigade_api, "_fetch_brigade_agents", new=AsyncMock(return_value=[majik])):
            agents = await brigade_api._fetch_invitable_agents(AsyncMock(), None)
        self.assertEqual([a.id for a in agents], ["majik", "persephone"])
