"""Nav v3 fix lane — who may reach a seat (REVIEW.md P1-1/R4, R5, P1-2/R9,
P2-8): ``@member`` follows the seat's owner human, only owners add seats, the
relay marker honours ``@member``, an empty allowlist is nothing. Every test
here FAILED on 3111bfe.
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
# P1-1 / R4 — @member follows the human; the list respects scope; [] is nothing
# ---------------------------------------------------------------------------


class P1_1_MemberScopeFollowsTheHuman(IsolatedAsyncioTestCase):
    def _room(self, archived=False):
        return SimpleNamespace(id=uuid.uuid4(), name="mallory-room", livekit_room_name="stable-mallory-room", is_archived=archived)

    async def test_seat_member_but_owner_absent_is_out_of_scope(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=uuid.uuid4()),                 # seat is a member
            _Result(scalar={"backend": "runner", "owner": "aaron"}),
            _Result(scalar=None),                         # no owner human in the room
        ])
        self.assertFalse(await GA.seat_follows_human(db, "persephone", self._room()))

    async def test_seat_and_owner_present_is_in_scope(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalar=uuid.uuid4()),
            _Result(scalar={"backend": "runner", "owner": ["shafen", "shafenkhan"]}),
            _Result(scalar=uuid.uuid4()),
        ])
        self.assertTrue(await GA.seat_follows_human(db, "flow", self._room()))
        sql = _sql(db.execute.await_args_list[2].args[0])
        self.assertIn("lower(participants.username)", sql)
        self.assertIn("room_members.room_id", sql)

    async def test_a_seat_with_no_owner_never_matches(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=uuid.uuid4()), _Result(scalar={"backend": "runner"})])
        self.assertFalse(await GA.seat_follows_human(db, "orphan", self._room()))
        self.assertEqual(db.execute.await_count, 2)

    async def test_archived_rooms_are_out_of_scope_without_a_query(self) -> None:
        db = AsyncMock()
        self.assertFalse(await GA.seat_follows_human(db, "persephone", self._room(archived=True)))
        db.execute.assert_not_awaited()

    async def test_empty_allowlist_is_scoped_to_nothing(self) -> None:
        db = AsyncMock()
        self.assertFalse(await GA.resolve_key_room_scope(db, [], "persephone", self._room()))
        db.execute.assert_not_awaited()
        with self.assertRaises(ValueError):
            G.validate_allowed_rooms([])
        with self.assertRaises(ValidationError):
            G.PatchKeyBody(allowed_rooms=[])
        with self.assertRaises(ValidationError):
            G.MintKeyBody(agent_id="x", allowed_rooms=[], no_expiry=True, history="full")

    async def test_a_stored_empty_allowlist_does_not_become_a_wildcard(self) -> None:
        token = "sbk-unit-test-empty-scope-not-a-real-secret"
        row = SimpleNamespace(id=uuid.uuid4(), key_hash=GA.hash_key(token), agent_id="x", allowed_rooms=[], rate_limit_rpm=30, can_manage_voice_settings=False, revoked_at=None)
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=row))
        principal = await GA.verify_gateway_key(token, db)
        self.assertEqual(principal.allowed_rooms, [])

    async def test_name_scoped_key_lists_only_its_names(self) -> None:
        seat = _seat()
        a = RC.RoomLite(id=uuid.uuid4(), name="persephone", livekit_room_name="stable-persephone")
        b = RC.RoomLite(id=uuid.uuid4(), name="mallory-room", livekit_room_name="stable-mallory-room")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalars=[a.id, b.id]))  # owner present in both
        kept = await G._scope_filter_rooms(db, SimpleNamespace(allowed_rooms=["persephone"], human_sub=None), seat, [a, b])
        self.assertEqual([r.name for r in kept], ["persephone"])
        db.execute.assert_awaited_once()

    async def test_member_scoped_key_lists_rooms_where_the_owner_is_present(self) -> None:
        seat = _seat()
        a = RC.RoomLite(id=uuid.uuid4(), name="hub-1", livekit_room_name="stable-hub-1")
        b = RC.RoomLite(id=uuid.uuid4(), name="mallory-room", livekit_room_name="stable-mallory-room")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalars=[a.id]))
        kept = await G._scope_filter_rooms(db, SimpleNamespace(allowed_rooms=["@member"], human_sub=None), seat, [a, b])
        self.assertEqual([r.name for r in kept], ["hub-1"])

    async def test_jwt_principal_lists_rooms_its_human_is_in(self) -> None:
        seat = _seat("dev-aaron")
        a = RC.RoomLite(id=uuid.uuid4(), name="x", livekit_room_name="stable-x")
        b = RC.RoomLite(id=uuid.uuid4(), name="y", livekit_room_name="stable-y")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalars=[b.id]))
        kept = await G._scope_filter_rooms(db, SimpleNamespace(allowed_rooms=None, human_sub="kc-aaron"), seat, [a, b])
        self.assertEqual([r.name for r in kept], ["y"])


# ---------------------------------------------------------------------------
# P1-1 / R5 — only a seat's owner may add it anywhere
# ---------------------------------------------------------------------------


class R5_OnlyTheOwnerAddsASeat(IsolatedAsyncioTestCase):
    """The owner is matched against the caller's DB username, looked up by
    participant id (fix lane 2, P2-7) — so an owned seat costs two lookups,
    anything else one."""

    def _user(self, username, ptype="human"):
        return {"participant_id": uuid.uuid4(), "username": username, "participant_type": ptype}

    async def test_someone_else_is_refused_with_ask_the_owner(self) -> None:
        from app.services import agent_access as AA

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar={"backend": "runner", "owner": "aaron"}), _Result(scalar="mallory")])
        with patch.object(AA, "resolve_agent_access", new=AsyncMock(return_value=(True, "default_open"))):
            with self.assertRaises(HTTPException) as ctx:
                await AA.ensure_agent_access(db, self._user("mallory"), "persephone", surface="room_member_invite")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("ask the seat's owner", ctx.exception.detail)

    async def test_the_owner_passes_and_a_brigade_agent_is_unchanged(self) -> None:
        from app.services import agent_access as AA

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(scalar={"backend": "runner", "owner": ["shafen", "shafenkhan"]}),
            _Result(scalar="ShafenKhan"),
        ])
        with patch.object(AA, "resolve_agent_access", new=AsyncMock(return_value=(True, "default_open"))) as resolve:
            await AA.ensure_agent_access(db, self._user("whatever-the-token-says"), "flow", surface="agent_hub")
        resolve.assert_awaited_once()
        db.execute = AsyncMock(return_value=_Result(scalar=None))  # Majik: NULL metadata
        with patch.object(AA, "resolve_agent_access", new=AsyncMock(return_value=(True, "default_open"))) as resolve:
            await AA.ensure_agent_access(db, self._user("mallory"), "majik", surface="agent_hub")
        resolve.assert_awaited_once()
        db.execute.assert_awaited_once()  # no username lookup for an unowned agent

    async def test_the_worker_principal_still_passes_for_unowned_agents(self) -> None:
        from app.services import agent_access as AA

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(scalar=None))
        with patch.object(AA, "resolve_agent_access", new=AsyncMock()) as resolve:
            await AA.ensure_agent_access(db, self._user("worker", ptype="agent"), "majik", surface="agent_hub")
        resolve.assert_not_awaited()      # grants never gate the worker
        db.execute.assert_awaited_once()  # but the owner check ran

    async def test_roster_marks_owned_seats_unentitled_for_others(self) -> None:
        from app.services import agent_access as AA

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _Result(rows=[("brigade:persephone", {"backend": "runner", "owner": "aaron"}), ("brigade:majik", None)]),
            _Result(scalar="mallory"),
            _Result(scalars=[]),
        ])
        with patch.object(AA, "_default_is_open", return_value=True):
            entitled = await AA.entitled_agent_ids(db, participant_id=uuid.uuid4(), agent_ids=["persephone", "majik"])
        self.assertEqual(entitled, {"majik"})


# ---------------------------------------------------------------------------
# P1-2 / R9 — the relay marker honours @member
# ---------------------------------------------------------------------------


class P1_2_RelayMarkerHonoursMemberScope(IsolatedAsyncioTestCase):
    async def test_member_scoped_key_counts_as_a_bridge_here_when_the_seat_follows_its_human(self) -> None:
        from app.services import agent_status as AS

        room = SimpleNamespace(id=uuid.uuid4(), name="hub-fa65c5631810", livekit_room_name="stable-hub-fa65c5631810", is_archived=False)
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_Result(rows=[("persephone", ["@member"]), ("grok", ["build-in-public-live"])]))
        with patch("app.auth.gateway_auth.resolve_key_room_scope", new=AsyncMock(return_value=True)) as resolve:
            scoped = await AS.scoped_bridge_agents(db=db, room=room, agent_ids=["persephone", "grok"])
        self.assertEqual(scoped, {"persephone"})
        resolve.assert_awaited_once()
        with patch("app.auth.gateway_auth.resolve_key_room_scope", new=AsyncMock(return_value=False)):
            scoped = await AS.scoped_bridge_agents(db=db, room=room, agent_ids=["persephone", "grok"])
        self.assertEqual(scoped, set())
        self.assertFalse(AS._room_in_allowed(["@member"], room))  # the pure name rule is unchanged
