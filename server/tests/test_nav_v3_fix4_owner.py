"""Nav v3 fix lane 4 — who may be named as a seat's owner (REVIEW-4.md P2-3,
P2-4).

An owner stamp re-attributes every line a seat ever wrote, and decides which
rooms that seat reads as private. Until this round the key API took any
string, and any list of strings:

* an owner with no human row behind it is a standing offer — on a realm
  that allows registration the first account to take that name owns the
  seat;
* a list naming two people makes one seat private in both people's rooms.

Now ``owner`` at mint and PATCH is ONE username that must belong to an
existing HUMAN participant, compared ``lower(btrim(username))`` like every
reader compares it. A list is refused (it is written by an
operator-reviewed migration only), and every change is logged with the old
owner, the new owner and the ``X-Operator`` header.

Every test here FAILED on e20c618 unless its docstring says it is a pin.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from app.api import gateway as G
from app.deps import get_db
from app.models.participant import ParticipantType
from app.services import room_class as RC


def _seat(agent_id="persephone", owner="aaron", **extra):
    meta = {"backend": "runner", "crew": True}
    if owner is not None:
        meta["owner"] = owner
    meta.update(extra)
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=meta,
                           avatar_url=None, avatar_emoji=None)


def _human(username):
    return SimpleNamespace(id=uuid.uuid4(), username=username, display_name=username.title(), keycloak_sub=f"kc-{username}",
                           participant_type=ParticipantType.HUMAN, metadata_={}, avatar_url=None)


class _Result:
    def __init__(self, *, scalar=None, scalars=None, rowcount=1):
        self._scalar, self._scalars, self.rowcount = scalar, list(scalars or []), rowcount

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return SimpleNamespace(all=lambda: list(self._scalars))


HUMAN_FOUND = lambda: _Result(scalars=[uuid.uuid4()])          # noqa: E731
NOBODY = lambda: _Result(scalars=[])                           # noqa: E731
TWO_ROWS = lambda: _Result(scalars=[uuid.uuid4(), uuid.uuid4()])  # noqa: E731


def _key(agent_id="persephone"):
    return SimpleNamespace(id=uuid.uuid4(), agent_id=agent_id, key_prefix="sbk-abcd", label="seat", allowed_rooms=["@member"],
                           rate_limit_rpm=60, can_manage_voice_settings=False, revoked_at=None)


def _db(results):
    async def refresh(row):
        row.id = getattr(row, "id", None) or uuid.uuid4()

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=results)
    db.add = MagicMock()
    db.commit = AsyncMock()
    db.rollback = AsyncMock()
    db.refresh = AsyncMock(side_effect=refresh)
    return db


def _request(operator=None):
    return SimpleNamespace(headers={"X-Operator": operator} if operator else {})


class _Log:
    """Captures the gateway's structured log lines."""

    def __init__(self):
        self.lines: list[tuple[str, dict]] = []

    def __call__(self, event, **fields):
        self.lines.append((event, fields))

    def named(self, event):
        return [fields for name, fields in self.lines if name == event]


# ---------------------------------------------------------------------------
# P2-3 — the owner is an existing human
# ---------------------------------------------------------------------------


class P2_3_TheOwnerIsAnExistingHuman(IsolatedAsyncioTestCase):
    async def test_mint_refuses_an_owner_nobody_has_and_mints_no_key(self) -> None:
        db = _db([NOBODY()])
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            with self.assertRaises(HTTPException) as ctx:
                await G.mint_gateway_key(G.MintKeyBody(agent_id="house-voice", owner="aaron2", no_expiry=True), _request(), db)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("existing human participant", ctx.exception.detail)
        db.add.assert_not_called()                          # no key row was made
        db.commit.assert_not_awaited()

    async def test_patch_refuses_before_anything_is_changed(self) -> None:
        key = _key()
        db = _db([_Result(scalar=key), NOBODY()])
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            with self.assertRaises(HTTPException) as ctx:
                await G.patch_gateway_key(key.id, G.PatchKeyBody(owner="nobody", label="renamed", rate_limit_rpm=600), _request(), db)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual((key.label, key.rate_limit_rpm), ("seat", 60))   # the rest of the PATCH did not land
        db.commit.assert_not_awaited()
        self.assertEqual(db.execute.await_count, 2)          # the key, the lookup — no participant was touched

    async def test_the_lookup_is_for_humans_compared_trimmed_and_lower_cased(self) -> None:
        db = _db([HUMAN_FOUND()])
        self.assertEqual(await G.require_human_owner(db, "aaron"), "aaron")
        statement = db.execute.await_args.args[0]
        sql = " ".join(str(statement.compile(dialect=postgresql.dialect())).lower().split())
        params = statement.compile(dialect=postgresql.dialect()).params
        self.assertIn("lower(btrim(participants.username)) =", sql)
        self.assertIn("participants.participant_type =", sql)
        self.assertIn(ParticipantType.HUMAN, list(params.values()))
        self.assertIn("aaron", list(params.values()))
        self.assertIn("limit", sql)

    async def test_an_agent_row_with_that_name_is_not_a_human(self) -> None:
        """The lookup asks for HUMAN rows, so a seat named like the owner —
        or a guest who chose the name — answers nothing: 422."""
        db = _db([NOBODY()])
        with self.assertRaises(HTTPException) as ctx:
            await G.require_human_owner(db, "persephone")
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_two_humans_with_the_same_name_once_normalised_are_refused(self) -> None:
        db = _db([TWO_ROWS()])
        with self.assertRaises(HTTPException) as ctx:
            await G.require_human_owner(db, "aaron")
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("more than one human", ctx.exception.detail)

    async def test_a_real_owner_is_stamped(self) -> None:
        """The happy path: the name is looked up, then stamped as before."""
        key, seat = _key(), _seat("persephone", owner=None)
        db = _db([_Result(scalar=key), HUMAN_FOUND(), _Result(scalar=seat), _Result()])
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            out = await G.patch_gateway_key(key.id, G.PatchKeyBody(owner=" Aaron "), _request(), db)
        self.assertEqual((out["owner"], seat.metadata_["owner"]), ("aaron", "aaron"))


# ---------------------------------------------------------------------------
# P2-4 — one name; a list is written by migration only
# ---------------------------------------------------------------------------


class P2_4_OneNameOnly(IsolatedAsyncioTestCase):
    def test_both_bodies_refuse_a_list_and_say_why(self) -> None:
        for build in (
            lambda owner: G.MintKeyBody(agent_id="flow", owner=owner, no_expiry=True),
            lambda owner: G.PatchKeyBody(owner=owner),
        ):
            for owner in (["shafen", "shafenkhan"], ["aaron", "shafen"], ["aaron"], ("aaron",), []):
                with self.assertRaises(ValidationError) as ctx:
                    build(owner)
                self.assertIn("list-form owners are set by migration only", str(ctx.exception), owner)
            for owner in ("", "   ", 7, {"name": "aaron"}, "x" * 101):
                with self.assertRaises(ValidationError):
                    build(owner)
            self.assertEqual(build("  Aaron ").owner, "aaron")
            self.assertIsNone(build(None).owner)

    async def test_over_http_a_list_is_a_422_with_that_detail(self) -> None:
        app = FastAPI()
        app.include_router(G.router, prefix="/api/v1")
        app.dependency_overrides[get_db] = lambda: _db([])
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            minted = await client.post(
                "/api/v1/gateway/keys",
                json={"agent_id": "flow", "owner": ["aaron", "shafen"], "no_expiry": True},
            )
            patched = await client.patch(f"/api/v1/gateway/keys/{uuid.uuid4()}", json={"owner": ["shafen", "shafenkhan"]})
        for response in (minted, patched):
            self.assertEqual(response.status_code, 422, response.text)
            self.assertIn("list-form owners are set by migration only", response.text)

    def test_a_list_on_a_row_is_still_read(self) -> None:
        """PIN (already true on e20c618): 024 stamps Shafen's seats with his
        two accounts, and the classifier and the party rule read them."""
        flow = _seat("flow", ["shafen", "shafenkhan"])
        self.assertEqual(RC.seat_owners(flow), frozenset({"shafen", "shafenkhan"}))
        self.assertEqual(RC.history_verdict([_human("shafenkhan"), flow]), (False, ()))
        self.assertEqual(RC.history_verdict([_human("aaron"), flow]), (True, ("parties",)))


# ---------------------------------------------------------------------------
# P2-3 — every owner change is logged
# ---------------------------------------------------------------------------


class P2_3_EveryOwnerChangeIsLogged(IsolatedAsyncioTestCase):
    async def test_a_patch_logs_old_owner_new_owner_and_operator(self) -> None:
        key, seat = _key(), _seat("persephone", owner="mallory")
        db = _db([_Result(scalar=key), HUMAN_FOUND(), _Result(scalar=seat), _Result()])
        log = _Log()
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None), patch.object(G.logger, "info", new=log):
            await G.patch_gateway_key(key.id, G.PatchKeyBody(owner="aaron"), _request("persephone@macstudio"), db)
        self.assertEqual(log.named("gateway_seat_owner_changed"), [{
            "agent_id": "persephone", "old_owner": "mallory", "new_owner": "aaron",
            "operator": "persephone@macstudio", "source": "patch", "row_created": False,
        }])

    async def test_replacing_a_list_logs_the_list_it_replaced(self) -> None:
        key, seat = _key("flow"), _seat("flow", ["shafen", "shafenkhan"])
        db = _db([_Result(scalar=key), HUMAN_FOUND(), _Result(scalar=seat), _Result()])
        log = _Log()
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None), patch.object(G.logger, "info", new=log):
            out = await G.patch_gateway_key(key.id, G.PatchKeyBody(owner="shafen"), _request(), db)
        line = log.named("gateway_seat_owner_changed")[0]
        self.assertEqual((line["old_owner"], line["new_owner"], line["operator"]), (["shafen", "shafenkhan"], "shafen", None))
        self.assertEqual(out["owner"], "shafen")

    async def test_mint_logs_the_first_owner_of_a_new_row(self) -> None:
        db = _db([HUMAN_FOUND(), _Result(scalar=None)])
        log = _Log()
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None), patch.object(G.logger, "info", new=log):
            out = await G.mint_gateway_key(G.MintKeyBody(agent_id="house-voice", owner="aaron", no_expiry=True), _request("aaron"), db)
        self.assertEqual(log.named("gateway_seat_owner_changed"), [{
            "agent_id": "house-voice", "old_owner": None, "new_owner": "aaron",
            "operator": "aaron", "source": "mint", "row_created": True,
        }])
        self.assertEqual((out["owner"], out["owner_stamped"]), ("aaron", True))

    async def test_an_owner_that_does_not_change_writes_and_logs_nothing(self) -> None:
        key, seat = _key(), _seat("persephone", owner="aaron")
        db = _db([_Result(scalar=key), HUMAN_FOUND(), _Result(scalar=seat)])
        log = _Log()
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None), patch.object(G.logger, "info", new=log):
            out = await G.patch_gateway_key(key.id, G.PatchKeyBody(owner="aaron"), _request("persephone"), db)
        self.assertEqual(log.named("gateway_seat_owner_changed"), [])
        self.assertEqual(db.execute.await_count, 3)          # the key, the lookup, the seat — no UPDATE
        self.assertEqual(out["owner"], "aaron")

    async def test_the_operator_header_is_capped(self) -> None:
        self.assertEqual(G._operator_of(_request("  persephone  ")), "persephone")
        self.assertEqual(len(G._operator_of(_request("x" * 5000))), 120)
        self.assertIsNone(G._operator_of(_request()))
        self.assertIsNone(G._operator_of(_request("   ")))


class TheOwnerUpdateLeavesTheSessionAlone(TestCase):
    def test_the_statement_is_not_reconciled_with_the_session(self) -> None:
        import asyncio

        seat = _seat("persephone", owner=None)
        db = _db([_Result(scalar=seat), _Result()])
        asyncio.run(G._stamp_seat_owner(db, "persephone", "aaron", overwrite=True))
        statement = db.execute.await_args_list[1].args[0]
        self.assertIs(statement.get_execution_options().get("synchronize_session"), False)
