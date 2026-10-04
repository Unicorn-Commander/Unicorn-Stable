"""L2 — invite links (item 4) and visibility (item 3).

* mint AND accept carry the ``rate_limit`` dependency;
* the preview returns room name, inviter display name, member count, expiry
  and role;
* exhausted / expired / revoked / unknown / malformed tokens are a UNIFORM
  404 on preview and accept, and DELETE revokes;
* both search endpoints can never return messages from private rooms the
  caller is not in: the per-room search sits behind ``require_room_member``
  and the global search is scoped by a membership subquery in SQL;
* a visibility change fans out ``room_visibility`` to the room.
"""

from __future__ import annotations

import typing
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.models.room import RoomType

# Relative to the real clock, never a fixed date: the handlers under test read
# ``datetime.now``, so a frozen NOW made every "valid for 7 days" invite expire
# a week later (these tests went red on 2026-09-28).
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def _res(*, scalar=None, rows=None, scalars=None, scalar_value=None):
    res = MagicMock()
    res.scalar_one_or_none.return_value = scalar
    res.all.return_value = list(rows or [])
    res.scalars.return_value.all.return_value = list(scalars or [])
    res.scalar.return_value = scalar_value
    return res


def _dep_qualnames(module, fn) -> list[str]:
    hints = typing.get_type_hints(fn, include_extras=True, globalns=vars(module))
    out: list[str] = []
    for ann in hints.values():
        for meta in getattr(ann, "__metadata__", ()):
            dep = getattr(meta, "dependency", None)
            if dep is not None:
                out.append(getattr(dep, "__qualname__", getattr(dep, "__name__", str(dep))))
    return out


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect())).replace("\n", " ")


class InviteRoutesAreRateLimited(unittest.TestCase):
    def test_mint_and_accept_carry_the_rate_limit_dependency(self) -> None:
        import app.api.conversation as C

        for fn in (C.mint_room_invite, C.accept_invite):
            with self.subTest(route=fn.__name__):
                names = _dep_qualnames(C, fn)
                self.assertTrue(any(n.startswith("rate_limit.") for n in names), names)


def _invite(raw: str, **over):
    from app.auth.gateway_auth import hash_key

    base = dict(
        id=uuid.uuid4(),
        room_id=uuid.uuid4(),
        token_hash=hash_key(raw),
        token_prefix=raw[:12],
        role="member",
        expires_at=NOW + timedelta(days=7),
        max_uses=None,
        use_count=0,
        revoked_at=None,
        created_by=uuid.uuid4(),
        created_at=NOW,
    )
    base.update(over)
    return SimpleNamespace(**base)


class InvitePreviewAndUniform404(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        from app.api.conversation import mint_invite_token

        self.raw = mint_invite_token()
        self.user = {"participant_id": uuid.uuid4(), "username": "bob", "display_name": "Bob"}

    async def test_preview_returns_room_inviter_count_expiry_and_role(self) -> None:
        from app.api.conversation import preview_invite

        invite = _invite(self.raw, role="admin")
        room = SimpleNamespace(id=invite.room_id, display_name="Ops crew", room_type=RoomType.CHANNEL, visibility="private")
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _res(scalar=invite),
            _res(scalar=room),
            _res(scalar_value=7),
            _res(scalar="Aaron"),
            _res(scalar=None),
        ])
        out = await preview_invite(self.raw, self.user, db)
        self.assertEqual(out.display_name, "Ops crew")
        self.assertEqual(out.inviter_display_name, "Aaron")
        self.assertEqual(out.member_count, 7)
        self.assertEqual(out.expires_at, invite.expires_at)
        self.assertEqual(out.role, "admin")
        self.assertEqual(out.visibility, "private")
        self.assertFalse(out.already_member)

    async def test_dead_tokens_are_a_uniform_404_on_preview_and_accept(self) -> None:
        from app.api.conversation import accept_invite, preview_invite

        dead = {
            "exhausted": _invite(self.raw, max_uses=2, use_count=2),
            "expired": _invite(self.raw, expires_at=NOW - timedelta(minutes=1)),
            "revoked": _invite(self.raw, revoked_at=NOW - timedelta(hours=1)),
            "unknown": None,
        }
        for label, row in dead.items():
            for route in (preview_invite, accept_invite):
                with self.subTest(case=label, route=route.__name__):
                    db = AsyncMock()
                    db.execute = AsyncMock(return_value=_res(scalar=row))
                    with self.assertRaises(HTTPException) as ctx:
                        if route is preview_invite:
                            await route(self.raw, self.user, db)
                        else:
                            await route(self.raw, self.user, db, AsyncMock(), AsyncMock(), None)
                    self.assertEqual(ctx.exception.status_code, 404)
                    self.assertEqual(ctx.exception.detail, "Invite not found")

    async def test_malformed_tokens_never_touch_the_database(self) -> None:
        from app.api.conversation import accept_invite, preview_invite

        for token in ("", "nope", "sri-short", "x" * 60):
            for route in (preview_invite, accept_invite):
                with self.subTest(token=token[:8], route=route.__name__):
                    db = AsyncMock()
                    with self.assertRaises(HTTPException) as ctx:
                        if route is preview_invite:
                            await route(token, self.user, db)
                        else:
                            await route(token, self.user, db, AsyncMock(), AsyncMock(), None)
                    self.assertEqual(ctx.exception.status_code, 404)
                    db.execute.assert_not_awaited()

    async def test_accept_refuses_an_archived_room_uniformly(self) -> None:
        from app.api.conversation import accept_invite

        invite = _invite(self.raw)
        room = SimpleNamespace(id=invite.room_id, is_archived=True, display_name="x", room_type=RoomType.CHANNEL)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=invite), _res(scalar=room)])
        with self.assertRaises(HTTPException) as ctx:
            await accept_invite(self.raw, self.user, db, AsyncMock(), AsyncMock(), None)
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_delete_revokes_and_a_revoked_link_stops_working(self) -> None:
        import app.api.conversation as C
        from app.api.conversation import invite_is_usable, revoke_room_invite

        invite = _invite(self.raw)
        room = SimpleNamespace(id=invite.room_id, room_type=RoomType.CHANNEL, visibility="public", is_archived=False)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=room), _res(scalar=invite)])
        with patch.object(C, "_require_invite_manager", AsyncMock()):
            await revoke_room_invite(room.id, invite.id, self.user, db)
        self.assertIsNotNone(invite.revoked_at)
        db.commit.assert_awaited_once()
        self.assertFalse(invite_is_usable(invite))

    async def test_accept_is_idempotent_for_an_existing_member_and_counts_once(self) -> None:
        import app.api.conversation as C
        from app.api.conversation import accept_invite

        invite = _invite(self.raw, max_uses=1, use_count=0)
        room = SimpleNamespace(id=invite.room_id, is_archived=False, display_name="x", room_type=RoomType.CHANNEL)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _res(scalar=invite), _res(scalar=room), _res(scalar=SimpleNamespace(role="member")),
        ])
        svc = SimpleNamespace(join_room=AsyncMock())
        with patch.object(C, "_build_room_service", return_value=svc), patch.object(
            C, "_member_response_for", AsyncMock(return_value="row")
        ), patch.object(C, "push_room_to_participants", AsyncMock()) as push:
            out = await accept_invite(self.raw, self.user, db, AsyncMock(), AsyncMock(), None)
        self.assertEqual(out, "row")
        self.assertEqual(invite.use_count, 0)  # not consumed by a re-accept
        svc.join_room.assert_not_awaited()
        push.assert_not_awaited()


# ---------------------------------------------------------------------------
# Search never leaks private rooms
# ---------------------------------------------------------------------------


class SearchIsMembershipScoped(IsolatedAsyncioTestCase):
    def test_room_search_requires_membership_and_global_search_a_real_user(self) -> None:
        import app.api.messages as M

        self.assertIn("require_room_member", _dep_qualnames(M, M.search_messages))
        self.assertIn("get_current_user", _dep_qualnames(M, M.search_all_messages))
        self.assertNotIn("require_room_member_or_guest", _dep_qualnames(M, M.search_messages))

    async def test_global_search_sql_is_scoped_by_the_callers_memberships(self) -> None:
        from app.services.message_service import MessageService

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalars=[]))
        svc = MessageService(db=db, livekit=AsyncMock())
        me = uuid.uuid4()
        out = await svc.search_all_messages(participant_id=me, query_text="secret", in_room="private-ops")
        self.assertEqual(out, [])
        sql = _sql(db.execute.call_args.args[0])
        self.assertIn("messages.room_id IN (SELECT room_members.room_id", sql)
        self.assertIn("room_members.participant_id = ", sql)
        self.assertIn("messages.is_deleted = false", sql)
        # in: narrows WITHIN the membership scope, never replaces it.
        self.assertIn("rooms.name", sql.lower())

    async def test_room_search_sql_is_pinned_to_that_room(self) -> None:
        from app.services.message_service import MessageService

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalars=[]))
        svc = MessageService(db=db, livekit=AsyncMock())
        room_id = uuid.uuid4()
        await svc.search_messages(room_id=room_id, query_text="secret")
        stmt = db.execute.call_args.args[0]
        self.assertIn("messages.room_id = ", _sql(stmt))
        self.assertIn(room_id, stmt.compile(dialect=postgresql.dialect()).params.values())

    async def test_room_search_route_refuses_a_non_member_before_searching(self) -> None:
        from app.deps import require_room_member

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=None))
        with self.assertRaises(HTTPException) as ctx:
            await require_room_member(room_id=uuid.uuid4(), user={"participant_id": uuid.uuid4()}, db=db)
        self.assertEqual(ctx.exception.status_code, 403)


# ---------------------------------------------------------------------------
# room_visibility fan-out
# ---------------------------------------------------------------------------


class VisibilityFanout(IsolatedAsyncioTestCase):
    def _room(self, visibility: str):
        return SimpleNamespace(
            id=uuid.uuid4(), name="ops", display_name="Ops", description=None, room_type=RoomType.CHANNEL,
            livekit_room_name="stable-ops", livekit_sid=None, max_participants=50, metadata_={},
            is_archived=False, created_by=None, created_at=NOW, updated_at=NOW, parent_room_id=None,
            visibility=visibility, project_number=None, recording_policy="off", recording_kind="audio",
        )

    async def _patch(self, body):
        import app.api.rooms as R
        from app.schemas.room import RoomUpdate

        room = self._room(body.get("visibility") or "public")
        svc = SimpleNamespace(
            update_room=AsyncMock(return_value=room),
            get_room=AsyncMock(return_value={"room": room, "member_count": 3, "online_count": 0}),
            room_extras=AsyncMock(return_value={}),
        )
        with patch.object(R, "_build_room_service", return_value=svc), patch(
            "app.api.messages._ws_broadcast_room", AsyncMock()
        ) as ws:
            out = await R.update_room(room.id, RoomUpdate(**body), {"participant_id": uuid.uuid4()}, AsyncMock(), AsyncMock(), AsyncMock())
        return out, ws, room

    async def test_visibility_change_fans_out_room_visibility(self) -> None:
        out, ws, room = await self._patch({"visibility": "private"})
        self.assertEqual(out.visibility, "private")
        ws.assert_awaited_once()
        envelope = ws.await_args.args[2]
        self.assertEqual(envelope["type"], "room_visibility")
        self.assertEqual(envelope["payload"], {"room_id": str(room.id), "visibility": "private"})

    async def test_other_patches_do_not_fan_out_visibility(self) -> None:
        _out, ws, _room = await self._patch({"display_name": "Renamed"})
        ws.assert_not_awaited()

    def test_browse_and_self_join_rules_are_pinned_by_l0(self) -> None:
        # Kept by L2 untouched; the L0 contract tests cover them.
        import tests.test_conversation_contracts as L0

        self.assertTrue(hasattr(L0, "PrivateChannelsDenyByDefault"))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
