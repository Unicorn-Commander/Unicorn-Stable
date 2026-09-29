"""Nav v3 C1 — the ``@member`` gateway-key scope.

``allowed_rooms`` may carry ``"@member"``: any room the key's agent
participant is a member of, resolved against ``room_members`` at check
time. Names, ``stable-`` names and ``"*"`` behave exactly as before; a
revoked key never gets a principal at all.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from app.api import gateway as G
from app.auth.gateway_auth import (
    MEMBER_SCOPE,
    GatewayAuthError,
    hash_key,
    key_scope_wants_membership,
    resolve_key_room_scope,
    room_in_key_scope,
    verify_gateway_key,
)

TOKEN = "sbk-unit-test-member-scope-not-a-real-secret"


def _res(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _room(name: str = "hub-fa65c5631810"):
    return SimpleNamespace(id=uuid.uuid4(), name=name, livekit_room_name=f"stable-{name}")


class MemberScopeRule(IsolatedAsyncioTestCase):
    async def test_names_and_star_never_touch_the_database(self) -> None:
        db = AsyncMock()
        room = _room()
        self.assertTrue(await resolve_key_room_scope(db, [room.name], "persephone", room))
        self.assertTrue(await resolve_key_room_scope(db, [room.livekit_room_name], "persephone", room))
        self.assertTrue(await resolve_key_room_scope(db, ["*"], "persephone", room))
        self.assertFalse(await resolve_key_room_scope(db, ["some-other-room"], "persephone", room))
        self.assertFalse(await resolve_key_room_scope(db, None, "persephone", room))
        db.execute.assert_not_awaited()

    async def test_member_token_is_in_scope_when_the_seat_is_a_member(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(uuid.uuid4()))
        room = _room()
        self.assertTrue(await resolve_key_room_scope(db, [MEMBER_SCOPE], "persephone", room))
        db.execute.assert_awaited_once()
        sql = str(db.execute.await_args.args[0]).lower()
        self.assertIn("room_members", sql)
        self.assertIn("keycloak_sub", sql)

    async def test_member_token_is_out_of_scope_when_not_a_member(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(None))
        self.assertFalse(await resolve_key_room_scope(db, [MEMBER_SCOPE], "persephone", _room()))

    async def test_member_token_still_honours_explicit_names(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(None))
        room = _room("build-in-public-live")
        # Named → in scope without a membership row.
        self.assertTrue(
            await resolve_key_room_scope(db, [MEMBER_SCOPE, "build-in-public-live"], "persephone", room)
        )
        db.execute.assert_not_awaited()

    async def test_enforce_scope_refuses_a_non_member_and_admits_a_member(self) -> None:
        principal = SimpleNamespace(allowed_rooms=[MEMBER_SCOPE], agent_id="persephone")
        room = _room()
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(None))
        with self.assertRaises(HTTPException) as ctx:
            await G._enforce_scope(db, principal, room)
        self.assertEqual(ctx.exception.status_code, 403)
        db.execute = AsyncMock(return_value=_res(uuid.uuid4()))
        await G._enforce_scope(db, principal, room)  # no raise

    async def test_a_revoked_key_never_becomes_a_principal(self) -> None:
        # The lookup filters revoked_at IS NULL, so a revoked row is simply
        # not found: 401 before any scope question is asked.
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(None))
        with self.assertRaises(GatewayAuthError) as ctx:
            await verify_gateway_key(TOKEN, db)
        self.assertEqual(ctx.exception.status_code, 401)
        sql = str(db.execute.await_args.args[0]).lower()
        self.assertIn("revoked_at is null", sql)

    async def test_a_live_member_scoped_key_carries_the_token(self) -> None:
        row = SimpleNamespace(
            id=uuid.uuid4(),
            key_hash=hash_key(TOKEN),
            agent_id="persephone",
            allowed_rooms=[MEMBER_SCOPE],
            rate_limit_rpm=60,
            can_manage_voice_settings=False,
            revoked_at=None,
        )
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(row))
        principal = await verify_gateway_key(TOKEN, db)
        self.assertEqual(principal.allowed_rooms, [MEMBER_SCOPE])
        self.assertTrue(key_scope_wants_membership(principal.allowed_rooms))
        self.assertFalse(room_in_key_scope(principal.allowed_rooms, _room()))


class RoomControllerHonoursMemberScope(IsolatedAsyncioTestCase):
    """deps.get_room_controller (voice-settings by control key) uses the same
    resolver, so a ``@member`` desk-app key works in rooms it has joined."""

    def _key_row(self, allowed):
        return SimpleNamespace(
            id=uuid.uuid4(),
            key_hash=hash_key(TOKEN),
            agent_id="talk-controls-app",
            allowed_rooms=allowed,
            rate_limit_rpm=30,
            can_manage_voice_settings=False,
            revoked_at=None,
        )

    async def _run(self, member_row):
        from app.deps import get_room_controller

        room = _room()
        db = AsyncMock()
        db.execute = AsyncMock(
            side_effect=[_res(self._key_row([MEMBER_SCOPE])), _res(room), _res(member_row)]
        )
        request = SimpleNamespace(headers={"Authorization": f"Bearer {TOKEN}"})
        return await get_room_controller(
            room_id=room.id, request=request, settings=SimpleNamespace(), db=db
        )

    async def test_member_is_authorized(self) -> None:
        user = await self._run(uuid.uuid4())
        self.assertTrue(user["is_control_key"])
        self.assertEqual(user["control_key_agent_id"], "talk-controls-app")

    async def test_non_member_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._run(None)
        self.assertEqual(ctx.exception.status_code, 403)


class KeyBodiesAcceptTheToken(TestCase):
    def test_mint_and_patch_accept_member(self) -> None:
        self.assertEqual(G.MintKeyBody(agent_id="persephone", allowed_rooms=["@member"]).allowed_rooms, ["@member"])
        self.assertEqual(G.PatchKeyBody(allowed_rooms=["@member"]).allowed_rooms, ["@member"])

    def test_names_and_star_are_unchanged_and_deduplicated(self) -> None:
        body = G.MintKeyBody(
            agent_id="rook", allowed_rooms=["persephone", "stable-persephone", "*", "persephone"]
        )
        self.assertEqual(body.allowed_rooms, ["persephone", "stable-persephone", "*"])
        self.assertEqual(G.MintKeyBody(agent_id="rook").allowed_rooms, ["*"])
        self.assertIsNone(G.PatchKeyBody(label="x").allowed_rooms)

    def test_a_mistyped_token_or_empty_entry_is_refused(self) -> None:
        with self.assertRaises(ValidationError):
            G.MintKeyBody(agent_id="rook", allowed_rooms=["@memberr"])
        with self.assertRaises(ValidationError):
            G.PatchKeyBody(allowed_rooms=["@all"])
        with self.assertRaises(ValidationError):
            G.MintKeyBody(agent_id="rook", allowed_rooms=["persephone", "  "])
