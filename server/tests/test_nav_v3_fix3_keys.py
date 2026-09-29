"""Nav v3 fix lane 3 — owning a seat through its key (REVIEW-3.md P1-2,
P2-8).

``PATCH /gateway/keys/{id}`` accepts ``owner`` and stamps it on the seat's
participant row by merge — the only way to own a seat whose key was minted
before owners existed. The stamp never touches ``backend`` on an existing
row (a row without one is what a Brigade-served agent looks like). Mint
answers with the owner that was STORED, and a failed stamp never costs the
caller the key, which is shown once.

Every test here FAILED on 5ee32e9 unless its docstring says it is a pin.

Amended in fix lane 4 (REVIEW-4.md P2-3, P2-4): the API takes ONE owner name,
which must belong to an existing human, so each call below first answers
that lookup (``HUMAN``). ``test_nav_v3_fix4_owner.py`` holds the tests that
fail on e20c618.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.dialects import postgresql

from app.api import gateway as G
from app.models.participant import ParticipantType


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


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect())).lower()


def _human_found():
    """The answer to "is this owner an existing human?": one row."""
    return _Result(scalars=[uuid.uuid4()])


# ---------------------------------------------------------------------------
# P1-2 — PATCH /gateway/keys/{id} accepts owner
# ---------------------------------------------------------------------------


class P1_2_PatchKeyAcceptsOwner(IsolatedAsyncioTestCase):
    def _key(self, agent_id="persephone"):
        return SimpleNamespace(id=uuid.uuid4(), agent_id=agent_id, key_prefix="sbk-abcd", label="seat", allowed_rooms=["@member"],
                               rate_limit_rpm=60, can_manage_voice_settings=False, revoked_at=None)

    def test_the_body_accepts_owner(self) -> None:
        self.assertEqual(G.PatchKeyBody(owner="Aaron").owner, "aaron")
        self.assertEqual(G.PatchKeyBody(owner="  ShafenKhan ").owner, "shafenkhan")
        self.assertIsNone(G.PatchKeyBody(label="x").owner)

    async def test_owner_is_merged_onto_the_seat_row_and_replaces_a_wrong_one(self) -> None:
        key, seat = self._key(), _seat("persephone", owner="mallory", avatar_emoji="🌸")
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=key), _human_found(), _Result(scalar=seat), _Result()])
        db.commit = AsyncMock()
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            out = await G.patch_gateway_key(key.id, G.PatchKeyBody(owner="aaron"), SimpleNamespace(headers={}), db)
        self.assertEqual(out["owner"], "aaron")
        self.assertEqual(seat.metadata_["owner"], "aaron")
        self.assertEqual(seat.metadata_["avatar_emoji"], "🌸")          # a merge, not a rewrite
        sql = _sql(db.execute.await_args_list[3].args[0])
        self.assertIn("update participants", sql)
        self.assertIn("||", sql)

    async def test_owner_creates_the_row_for_a_seat_that_never_posted(self) -> None:
        key = self._key("house-voice")
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=key), _human_found(), _Result(scalar=None)])
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            out = await G.patch_gateway_key(key.id, G.PatchKeyBody(owner="aaron"), SimpleNamespace(headers={}), db)
        created = db.add.call_args.args[0]
        self.assertEqual((created.keycloak_sub, created.metadata_), ("brigade:house-voice", {"backend": "runner", "owner": "aaron"}))
        self.assertEqual(out["owner"], "aaron")

    async def test_a_patch_without_owner_touches_no_participant(self) -> None:
        """PIN (already true on 5ee32e9): the new field changes nothing for
        a PATCH that does not use it."""
        key = self._key()
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=key)])
        db.commit = AsyncMock()
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            out = await G.patch_gateway_key(key.id, G.PatchKeyBody(label="renamed"), SimpleNamespace(headers={}), db)
        self.assertNotIn("owner", out)
        self.assertEqual(db.execute.await_count, 1)

    async def test_stamping_an_owner_never_touches_backend_on_an_existing_row(self) -> None:
        # A Brigade-served row has NO backend key at all (that is how
        # /internal/agent-messages creates it); an explicit one is kept too.
        for before in (None, {}, {"backend": "brigade"}, {"backend": "runner", "crew": True}):
            served = _brigade("perry", None if before is None else dict(before))
            db = AsyncMock()
            db.execute = AsyncMock(side_effect=[_Result(scalar=served), _Result()])
            db.commit = AsyncMock()
            await G._stamp_seat_owner(db, "perry", "aaron", overwrite=True)
            self.assertEqual(served.metadata_, {**(before or {}), "owner": "aaron"}, before)
            params = db.execute.await_args_list[1].args[0].compile(dialect=postgresql.dialect()).params
            self.assertIn({"owner": "aaron"}, list(params.values()))
            self.assertFalse(any(isinstance(v, dict) and "backend" in v for v in params.values()))


# ---------------------------------------------------------------------------
# P2-8 — mint tells the truth and never loses the key
# ---------------------------------------------------------------------------


class P2_8_MintTellsTheTruthAndNeverLosesTheKey(IsolatedAsyncioTestCase):
    def _db(self, seat_result):
        async def refresh(row):
            row.id = getattr(row, "id", None) or uuid.uuid4()

        db = AsyncMock()
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.refresh = AsyncMock(side_effect=refresh)
        db.execute = AsyncMock(side_effect=seat_result)
        return db

    async def test_the_response_carries_the_owner_that_was_stored(self) -> None:
        owned = _seat("persephone", owner="shafen")           # already owned: mint keeps it
        db = self._db([_human_found(), _Result(scalar=owned)])
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            out = await G.mint_gateway_key(G.MintKeyBody(agent_id="persephone", owner="aaron"), SimpleNamespace(headers={}), db)
        self.assertEqual(out["owner"], "shafen")               # not an echo of the request
        self.assertTrue(out["owner_stamped"])
        self.assertTrue(out["key"])

    async def test_a_failed_owner_stamp_never_costs_the_caller_the_key(self) -> None:
        db = self._db([_human_found(), RuntimeError("participants is locked")])
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            out = await G.mint_gateway_key(G.MintKeyBody(agent_id="house-voice", owner="aaron"), SimpleNamespace(headers={}), db)
        self.assertTrue(out["key"])                            # shown once: it must arrive
        self.assertIsNone(out["owner"])
        self.assertFalse(out["owner_stamped"])
        db.rollback.assert_awaited()

    async def test_a_mint_without_owner_says_so(self) -> None:
        db = self._db([])
        with patch.object(G, "verify_key_admin_bearer", lambda _r: None):
            out = await G.mint_gateway_key(G.MintKeyBody(agent_id="house-voice"), SimpleNamespace(headers={}), db)
        self.assertIsNone(out["owner"])
        self.assertTrue(out["owner_stamped"])                  # nothing was asked for
        db.execute.assert_not_awaited()

    async def test_the_merge_never_schedules_an_orm_write_of_the_column(self) -> None:
        from sqlalchemy import inspect as sa_inspect

        from app.models.participant import Participant

        seat = Participant(keycloak_sub="brigade:persephone", username="agent-persephone", display_name="Persephone",
                           participant_type=ParticipantType.AGENT, metadata_={"crew": True, "avatar_emoji": "x"})
        seat.id = uuid.uuid4()
        sa_inspect(seat).committed_state.clear()               # as if just loaded
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(scalar=seat), _Result()])
        db.commit = AsyncMock()
        await G._stamp_seat_owner(db, "persephone", "aaron", overwrite=True)
        self.assertEqual(seat.metadata_, {"crew": True, "avatar_emoji": "x", "owner": "aaron"})
        self.assertNotIn("metadata_", sa_inspect(seat).committed_state)
