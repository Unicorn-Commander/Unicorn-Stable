"""L0 contracts — conversation model, agent mode, invite links, context,
recording policy (design docs/design/stable-ux-north-star-2026-09-21.md §9).

Structural + pure-logic assertions in the house style (unittest + mocks, no
live DB): the routes exist under /api/v1 with the intended auth dependency,
private rooms are denied by default in browse AND self-join, the responder
honours ``agent_mode``, invite tokens are hashed and uniformly refused, the
context builder honours its budget, and the migration chain is well-formed.
"""

from __future__ import annotations

import importlib
import typing
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException
from sqlalchemy.dialects import postgresql


def _deps(module, fn) -> list[str]:
    hints = typing.get_type_hints(fn, include_extras=True, globalns=vars(module))
    out: list[str] = []
    for ann in hints.values():
        for meta in getattr(ann, "__metadata__", ()):
            dep = getattr(meta, "dependency", None)
            if dep is not None:
                out.append(getattr(dep, "__name__", str(dep)))
    return out


# ---------------------------------------------------------------------------
# Routes are mounted, versioned, and behind the right door
# ---------------------------------------------------------------------------


class ContractRoutesAreMounted(unittest.TestCase):
    EXPECTED = {
        ("post", "/api/v1/agents/{agent_id}/hub"),
        ("post", "/api/v1/rooms/{room_id}/threads"),
        ("get", "/api/v1/rooms/{room_id}/threads"),
        ("patch", "/api/v1/rooms/{room_id}/members/{participant_id}"),
        ("post", "/api/v1/rooms/{room_id}/invites"),
        ("get", "/api/v1/rooms/{room_id}/invites"),
        ("delete", "/api/v1/rooms/{room_id}/invites/{invite_id}"),
        ("get", "/api/v1/invites/{token}"),
        ("post", "/api/v1/invites/{token}/accept"),
        ("get", "/api/v1/rooms/{room_id}/context"),
        ("get", "/api/v1/gateway/rooms/{room}/context"),
        ("post", "/api/v1/rooms/{room_id}/recording/start"),
        ("post", "/api/v1/rooms/{room_id}/recording/stop"),
        ("get", "/api/v1/rooms/{room_id}/recordings"),
    }

    def test_every_contract_route_is_mounted_under_v1(self) -> None:
        from app.main import create_app

        app = create_app()
        mounted = {
            (method.lower(), path)
            for path, operations in (app.openapi().get("paths") or {}).items()
            for method in operations
        }
        missing = self.EXPECTED - mounted
        self.assertEqual(missing, set(), f"unmounted contract routes: {sorted(missing)}")


class ContractRoutesAuthPosture(unittest.TestCase):
    """No contract route is reachable by a guest, broadcast or gateway token
    except the gateway's own context mirror."""

    def test_conversation_routes_require_a_real_user(self) -> None:
        import app.api.conversation as C

        member_only = {"get_current_user", "require_room_member", "get_room_controller"}
        for fn in (
            C.ensure_agent_hub,
            C.create_thread,
            C.list_threads,
            C.set_member_settings,
            C.mint_room_invite,
            C.list_room_invites,
            C.revoke_room_invite,
            C.preview_invite,
            C.accept_invite,
        ):
            with self.subTest(route=fn.__name__):
                self.assertTrue(member_only & set(_deps(C, fn)), _deps(C, fn))

    def test_context_is_member_only(self) -> None:
        # The guest-reachable route set is pinned elsewhere as an exact list;
        # this route must not widen it.
        import app.api.conversation as C

        deps = _deps(C, C.get_room_context)
        self.assertIn("require_room_member", deps)
        self.assertNotIn("require_room_member_or_guest", deps)

    def test_recording_routes_require_membership(self) -> None:
        import app.api.recording as R

        for fn in (R.start_recording, R.stop_recording, R.list_recordings):
            with self.subTest(route=fn.__name__):
                self.assertIn("require_room_member", _deps(R, fn))

    def test_gateway_context_uses_gateway_auth(self) -> None:
        import app.api.gateway as G

        self.assertIn("authenticate_gateway_caller", _deps(G, G.gateway_get_context))


# ---------------------------------------------------------------------------
# Private rooms are denied by default
# ---------------------------------------------------------------------------


class PrivateChannelsDenyByDefault(IsolatedAsyncioTestCase):
    async def test_browse_query_filters_to_public(self) -> None:
        from app.api.rooms import browse_channels

        db = AsyncMock()
        res = MagicMock()
        res.scalars.return_value.all.return_value = []
        db.execute = AsyncMock(return_value=res)
        settings = SimpleNamespace(instance_org_id=None)
        user = {"participant_id": uuid.uuid4()}
        out = await browse_channels(
            user=user, settings=settings, db=db, livekit=AsyncMock(), presence=AsyncMock(), q="", limit=50
        )
        self.assertEqual(out, [])
        sql = str(
            db.execute.call_args.args[0].compile(
                dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
            )
        )
        self.assertIn("rooms.visibility = 'public'", sql)

    async def test_self_join_into_private_channel_is_refused(self) -> None:
        from app.models.room import RoomType
        from app.services.room_service import RoomService

        db = AsyncMock()
        room = SimpleNamespace(
            id=uuid.uuid4(),
            room_type=RoomType.CHANNEL,
            visibility="private",
            is_archived=False,
            org_id=None,
            max_participants=50,
        )
        res = MagicMock()
        res.scalar_one_or_none.return_value = room
        db.execute = AsyncMock(return_value=res)
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        with self.assertRaises(HTTPException) as ctx:
            await svc.join_room(room_id=room.id, participant_id=uuid.uuid4(), self_join=True)
        self.assertEqual(ctx.exception.status_code, 403)
        # Uniform with the DM refusal: not a "private room exists" oracle.
        self.assertEqual(ctx.exception.detail, "This room is invite-only")

    async def test_invited_join_into_private_channel_is_allowed(self) -> None:
        from app.models.room import RoomType
        from app.services.room_service import RoomService

        db = AsyncMock()
        room = SimpleNamespace(
            id=uuid.uuid4(),
            room_type=RoomType.CHANNEL,
            visibility="private",
            is_archived=False,
            org_id=None,
            max_participants=50,
        )
        room_res = MagicMock()
        room_res.scalar_one_or_none.return_value = room
        none_res = MagicMock()
        none_res.scalar_one_or_none.return_value = None
        count_res = MagicMock()
        count_res.scalar.return_value = 1
        db.execute = AsyncMock(side_effect=[room_res, none_res, count_res])
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        membership = await svc.join_room(room_id=room.id, participant_id=uuid.uuid4(), self_join=False)
        self.assertIsNotNone(membership)
        db.add.assert_called_once()

    async def test_visibility_is_a_channel_only_setting(self) -> None:
        from app.models.room import RoomType
        from app.services.room_service import RoomService

        db = AsyncMock()
        room = SimpleNamespace(
            id=uuid.uuid4(), room_type=RoomType.GROUP_DM, visibility="public",
            display_name="g", description=None, is_archived=False, metadata_={},
        )
        room_res = MagicMock()
        room_res.scalar_one_or_none.return_value = room
        db.execute = AsyncMock(return_value=room_res)
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        svc._require_role = AsyncMock()  # owner/admin already proven
        with self.assertRaises(HTTPException) as ctx:
            await svc.update_room(room_id=room.id, participant_id=uuid.uuid4(), visibility="private")
        self.assertEqual(ctx.exception.status_code, 422)


# ---------------------------------------------------------------------------
# Responder honours agent_mode
# ---------------------------------------------------------------------------


class ResponderAgentMode(unittest.TestCase):
    def setUp(self) -> None:
        from app.services.agent_chat_responder import _should_respond

        self.gate = _should_respond

    def test_legacy_rule_when_mode_unset(self) -> None:
        self.assertTrue(self.gate(room_type="dm", content="hi", brigade_agent_id="majik"))
        self.assertTrue(self.gate(room_type="agent_hub", content="hi", brigade_agent_id="majik"))
        self.assertFalse(self.gate(room_type="channel", content="hi", brigade_agent_id="majik"))
        self.assertTrue(self.gate(room_type="channel", content="@majik hi", brigade_agent_id="majik"))

    def test_answers_all_replies_even_in_a_channel(self) -> None:
        self.assertTrue(
            self.gate(room_type="channel", content="hi", brigade_agent_id="majik", agent_mode="answers_all")
        )

    def test_when_named_requires_a_mention_even_in_a_dm(self) -> None:
        self.assertFalse(
            self.gate(room_type="dm", content="hi", brigade_agent_id="majik", agent_mode="when_named")
        )
        self.assertTrue(
            self.gate(room_type="dm", content="@majik hi", brigade_agent_id="majik", agent_mode="when_named")
        )

    def test_listening_and_muted_never_reply(self) -> None:
        for mode in ("listening", "muted"):
            with self.subTest(mode=mode):
                self.assertFalse(
                    self.gate(room_type="dm", content="@majik hi", brigade_agent_id="majik", agent_mode=mode)
                )

    def test_mode_is_read_off_the_loaded_room_members(self) -> None:
        from app.services.agent_chat_responder import _agent_mode_for

        agent = SimpleNamespace(id=uuid.uuid4())
        other = SimpleNamespace(id=uuid.uuid4())
        room = SimpleNamespace(
            members=[
                SimpleNamespace(participant_id=other.id, agent_mode="muted"),
                SimpleNamespace(participant_id=agent.id, agent_mode="listening"),
            ]
        )
        self.assertEqual(_agent_mode_for(room, agent), "listening")
        self.assertIsNone(_agent_mode_for(SimpleNamespace(members=[]), agent))
        self.assertIsNone(_agent_mode_for(SimpleNamespace(), agent))


# ---------------------------------------------------------------------------
# Invite links: hashed, uniformly refused
# ---------------------------------------------------------------------------


class InviteLinkContract(IsolatedAsyncioTestCase):
    def test_token_shape_and_hash(self) -> None:
        from app.api.conversation import INVITE_TOKEN_PREFIX, mint_invite_token
        from app.auth.gateway_auth import hash_key

        raw = mint_invite_token()
        self.assertTrue(raw.startswith(INVITE_TOKEN_PREFIX))
        self.assertGreater(len(raw), 40)
        self.assertEqual(len(hash_key(raw)), 64)
        self.assertNotEqual(hash_key(raw), raw)

    def test_usability_rules(self) -> None:
        from app.api.conversation import invite_is_usable

        now = datetime.now(timezone.utc)
        live = SimpleNamespace(revoked_at=None, expires_at=now + timedelta(hours=1), max_uses=None, use_count=0)
        self.assertTrue(invite_is_usable(live, now))
        self.assertFalse(invite_is_usable(SimpleNamespace(**{**vars(live), "revoked_at": now}), now))
        self.assertFalse(invite_is_usable(SimpleNamespace(**{**vars(live), "expires_at": now - timedelta(seconds=1)}), now))
        self.assertFalse(invite_is_usable(SimpleNamespace(**{**vars(live), "max_uses": 2, "use_count": 2}), now))
        self.assertTrue(invite_is_usable(SimpleNamespace(**{**vars(live), "max_uses": 2, "use_count": 1}), now))

    async def test_unknown_and_malformed_tokens_are_a_uniform_404(self) -> None:
        from app.api.conversation import _lookup_usable_invite

        db = AsyncMock()
        res = MagicMock()
        res.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(return_value=res)
        for token in ("", "nope", "sri-" + "x" * 50):
            with self.subTest(token=token[:8]):
                with self.assertRaises(HTTPException) as ctx:
                    await _lookup_usable_invite(db, token)
                self.assertEqual(ctx.exception.status_code, 404)
                self.assertEqual(ctx.exception.detail, "Invite not found")

    async def test_dm_rooms_have_no_invite_links(self) -> None:
        from app.api.conversation import _require_invite_manager
        from app.models.room import MemberRole, RoomType

        db = AsyncMock()
        res = MagicMock()
        res.scalar_one_or_none.return_value = SimpleNamespace(role=MemberRole.OWNER)
        db.execute = AsyncMock(return_value=res)
        room = SimpleNamespace(id=uuid.uuid4(), room_type=RoomType.DM, visibility="public")
        with self.assertRaises(HTTPException) as ctx:
            await _require_invite_manager(db, room, {"participant_id": uuid.uuid4()})
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_private_rooms_need_owner_or_admin(self) -> None:
        from app.api.conversation import _require_invite_manager
        from app.models.room import MemberRole, RoomType

        db = AsyncMock()
        res = MagicMock()
        res.scalar_one_or_none.return_value = SimpleNamespace(role=MemberRole.MEMBER)
        db.execute = AsyncMock(return_value=res)
        private = SimpleNamespace(id=uuid.uuid4(), room_type=RoomType.CHANNEL, visibility="private")
        with self.assertRaises(HTTPException) as ctx:
            await _require_invite_manager(db, private, {"participant_id": uuid.uuid4()})
        self.assertEqual(ctx.exception.status_code, 403)
        public = SimpleNamespace(id=uuid.uuid4(), room_type=RoomType.CHANNEL, visibility="public")
        membership = await _require_invite_manager(db, public, {"participant_id": uuid.uuid4()})
        self.assertEqual(membership.role, MemberRole.MEMBER)


# ---------------------------------------------------------------------------
# Context builder: budget, order, kinds
# ---------------------------------------------------------------------------


class ContextBuilderContract(unittest.TestCase):
    def _entry(self, text: str, ts: int) -> dict:
        return {
            "id": uuid.uuid4(),
            "ts": datetime(2026, 9, 21, tzinfo=timezone.utc) + timedelta(seconds=ts),
            "sender": {"id": None, "name": "x", "kind": "human"},
            "kind": "message",
            "text": text,
            "parent_id": None,
        }

    def test_budget_keeps_newest_and_returns_oldest_first(self) -> None:
        from app.services.context_builder import fit_to_budget

        newest_first = [self._entry("m" * 40, 3), self._entry("m" * 40, 2), self._entry("m" * 40, 1)]
        # 40 chars ≈ 10 tokens + 4 framing = 14 each; budget 30 keeps two.
        kept, used, truncated = fit_to_budget(newest_first, 30)
        self.assertEqual(len(kept), 2)
        self.assertTrue(truncated)
        self.assertLess(kept[0]["ts"], kept[1]["ts"])
        self.assertEqual(kept[1]["ts"], newest_first[0]["ts"])
        self.assertLessEqual(used, 30)

    def test_one_entry_always_fits(self) -> None:
        from app.services.context_builder import fit_to_budget

        kept, used, truncated = fit_to_budget([self._entry("z" * 4000, 1)], 1)
        self.assertEqual(len(kept), 1)
        self.assertFalse(truncated)

    def test_context_depth_caps_entries(self) -> None:
        from app.services.context_builder import fit_to_budget

        newest_first = [self._entry("a", i) for i in range(10, 0, -1)]
        kept, _used, truncated = fit_to_budget(newest_first, 10_000, max_entries=3)
        self.assertEqual(len(kept), 3)
        self.assertTrue(truncated)

    def test_entry_kinds(self) -> None:
        from app.models.message import ContentType
        from app.services.context_builder import entry_kind

        base = dict(content_type=ContentType.TEXT, metadata_={}, parent_id=None)
        self.assertEqual(entry_kind(SimpleNamespace(**base)), "message")
        self.assertEqual(entry_kind(SimpleNamespace(**{**base, "parent_id": uuid.uuid4()})), "reply")
        self.assertEqual(entry_kind(SimpleNamespace(**{**base, "metadata_": {"via": "voice"}})), "voice")
        self.assertEqual(entry_kind(SimpleNamespace(**{**base, "content_type": ContentType.SYSTEM})), "system")


# ---------------------------------------------------------------------------
# Recording policy contract
# ---------------------------------------------------------------------------


class RecordingPolicyContract(IsolatedAsyncioTestCase):
    def _db(self, room):
        db = AsyncMock()
        res = MagicMock()
        res.scalar_one_or_none.return_value = room
        db.execute = AsyncMock(return_value=res)
        return db

    async def test_policy_off_is_403_before_anything_else(self) -> None:
        from app.api.recording import start_recording

        room = SimpleNamespace(id=uuid.uuid4(), recording_policy="off")
        with self.assertRaises(HTTPException) as ctx:
            await start_recording(room.id, None, {"participant_id": uuid.uuid4(), "roles": ["stable-recorder"]}, self._db(room))
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_unentitled_user_is_403(self) -> None:
        from app.api.recording import start_recording

        room = SimpleNamespace(id=uuid.uuid4(), recording_policy="on_request")
        with self.assertRaises(HTTPException) as ctx:
            await start_recording(room.id, None, {"participant_id": uuid.uuid4(), "roles": []}, self._db(room))
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_entitled_user_hits_the_not_enabled_stub(self) -> None:
        from app.api.recording import start_recording, stop_recording

        room = SimpleNamespace(id=uuid.uuid4(), recording_policy="always")
        user = {"participant_id": uuid.uuid4(), "roles": ["stable-recorder"]}
        for fn in (start_recording, stop_recording):
            with self.subTest(route=fn.__name__):
                with self.assertRaises(HTTPException) as ctx:
                    if fn is start_recording:
                        await fn(room.id, None, user, self._db(room))
                    else:
                        await fn(room.id, user, self._db(room))
                self.assertEqual(ctx.exception.status_code, 409)

    def test_room_update_rejects_bad_policy_values(self) -> None:
        from pydantic import ValidationError

        from app.schemas.room import RoomUpdate

        with self.assertRaises(ValidationError):
            RoomUpdate(recording_policy="sometimes")
        self.assertEqual(RoomUpdate(recording_policy="always").recording_policy, "always")


# ---------------------------------------------------------------------------
# Migration chain
# ---------------------------------------------------------------------------


class MigrationChain(unittest.TestCase):
    def _load(self, name: str):
        import importlib.util
        import pathlib

        path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / f"{name}.py"
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        return mod

    def test_ids_fit_varchar_32_and_chain_from_020(self) -> None:
        chain = ["021_conversation_model", "022_agent_hubs_backfill", "023_recording_policy"]
        prev = "020_agent_backend"
        for name in chain:
            mod = self._load(name)
            self.assertEqual(mod.revision, name)
            self.assertLessEqual(len(mod.revision), 32)
            self.assertEqual(mod.down_revision, prev)
            prev = name

    def test_models_carry_the_contract_columns(self) -> None:
        from app.models.call_egress import CallEgress
        from app.models.room import Room, RoomMember, RoomType
        from app.models.room_invite import RoomInvite

        cols = {c.name for c in Room.__table__.columns}
        self.assertTrue({"parent_room_id", "visibility", "project_number", "recording_policy", "recording_kind"} <= cols)
        self.assertTrue({"agent_mode", "context_depth"} <= {c.name for c in RoomMember.__table__.columns})
        self.assertTrue({"kind", "started_by", "storage_url", "retention_until", "legal_hold"} <= {c.name for c in CallEgress.__table__.columns})
        self.assertTrue({"token_hash", "token_prefix", "room_id", "role", "expires_at", "max_uses", "use_count", "revoked_at"} <= {c.name for c in RoomInvite.__table__.columns})
        self.assertEqual(RoomType.AGENT_HUB.value, "agent_hub")

    def test_ws_contract_events_are_named(self) -> None:
        from app.ws import events

        self.assertEqual(
            set(events.CONTRACT_EVENTS),
            {"thread_created", "room_visibility", "invite_created", "member_mode", "recording_state", "voice_dispatch"},
        )

    def test_hub_slug_matches_the_backfill(self) -> None:
        import hashlib

        from app.services.room_service import RoomService

        human = uuid.uuid4()
        expected = "hub-" + hashlib.md5(f"{human}:majik".encode()).hexdigest()[:12]
        self.assertEqual(RoomService.hub_slug(human, "majik"), expected)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
