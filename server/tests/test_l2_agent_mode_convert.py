"""L2 — agent_mode everywhere it must bite (item 6) and group → channel.

* the gateway messages poll is what triggers a bridge's text run, so a
  ``listening`` / ``muted`` seat gets an empty page and a 403 on post;
* the envelope carries ``room_id`` / ``room_type`` / ``parent_room_id`` and
  the calling seat's own ``agent_mode`` (L4 contract), additively;
* the responder's gate is wired at the ``_respond`` call site (truth table
  pinned by the L0 tests);
* ``PATCH members/{id}`` fans out ``member_mode``;
* a group DM converts to a private channel: owner-only, renamed + retyped
  in place, audited as an ``agent_events`` row, fanned out as
  ``room_converted``.
"""

from __future__ import annotations

import inspect
import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.models.agent import AgentEvent
from app.models.room import RoomType

NOW = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)


def _res(*, scalar=None, rows=None, scalars=None, scalar_value=None):
    res = MagicMock()
    res.scalar_one_or_none.return_value = scalar
    res.all.return_value = list(rows or [])
    res.scalars.return_value.all.return_value = list(scalars or [])
    res.scalar.return_value = scalar_value
    return res


def _room(**over):
    base = dict(
        id=uuid.uuid4(), name="crew", display_name="Show crew", description=None, room_type=RoomType.GROUP_DM,
        livekit_room_name="stable-crew", livekit_sid=None, max_participants=50, metadata_={},
        is_archived=False, created_by=None, created_at=NOW, updated_at=NOW, parent_room_id=None,
        visibility="public", project_number=None, recording_policy="off", recording_kind="audio", org_id=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


class GatewaySeatMode(IsolatedAsyncioTestCase):
    def test_silence_rule(self) -> None:
        from app.api.gateway import SILENT_AGENT_MODES, seat_is_silent

        self.assertEqual(SILENT_AGENT_MODES, frozenset({"listening", "muted"}))
        for mode in ("listening", "muted"):
            self.assertTrue(seat_is_silent(mode))
        for mode in ("answers_all", "when_named", None, ""):
            self.assertFalse(seat_is_silent(mode))

    def _principal(self):
        return SimpleNamespace(agent_id="grok", allowed_rooms=["*"], human_sub=None, key_id="k1")

    async def _get(self, mode, room=None):
        import app.api.gateway as G

        room = room or _room(room_type=RoomType.CHANNEL)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=room), _res(scalar=mode)])
        svc = SimpleNamespace(get_messages=AsyncMock(return_value={"messages": [], "cursor": None, "has_more": False}))
        with patch.object(G, "_gateway_rate_limit", AsyncMock()), patch.object(
            G, "touch_bridge_seen", AsyncMock()
        ), patch.object(G, "clear_relay_pending", AsyncMock()), patch.object(
            G, "_build_message_service", return_value=svc
        ):
            out = await G.gateway_get_messages("crew", self._principal(), db, AsyncMock(), AsyncMock(), None, 50)
        return out, svc, db, room

    async def test_listening_and_muted_seats_get_an_empty_page_with_the_mode(self) -> None:
        for mode in ("listening", "muted"):
            with self.subTest(mode=mode):
                out, svc, db, room = await self._get(mode)
                self.assertEqual(out.messages, [])
                self.assertFalse(out.has_more)
                self.assertEqual(out.agent_mode, mode)
                self.assertEqual(out.room_id, room.id)
                self.assertEqual(out.room_type, "channel")
                svc.get_messages.assert_not_awaited()
                # The mode lookup names the seat's pseudo-sub and the room.
                seat_sql = str(db.execute.call_args_list[1].args[0].compile())
                self.assertIn("room_members.agent_mode", seat_sql)
                self.assertIn("participants.keycloak_sub", seat_sql)

    async def test_speaking_seats_read_normally_and_the_envelope_carries_room_facts(self) -> None:
        parent = uuid.uuid4()
        thread = _room(room_type=RoomType.AGENT_HUB, parent_room_id=parent)
        for mode in ("answers_all", "when_named", None):
            with self.subTest(mode=mode):
                out, svc, _db, _room_ = await self._get(mode, room=thread)
                svc.get_messages.assert_awaited_once()
                self.assertEqual(out.agent_mode, mode)
                self.assertEqual(out.room_id, thread.id)
                self.assertEqual(out.room_type, "agent_hub")
                self.assertEqual(out.parent_room_id, parent)

    def test_envelope_fields_are_additive_with_none_defaults(self) -> None:
        from app.schemas.message import MessageListResponse

        page = MessageListResponse(messages=[], has_more=False)
        self.assertIsNone(page.room_id)
        self.assertIsNone(page.room_type)
        self.assertIsNone(page.parent_room_id)
        self.assertIsNone(page.agent_mode)

    async def test_silent_seat_cannot_post(self) -> None:
        import app.api.gateway as G

        room = _room(room_type=RoomType.CHANNEL)
        for mode in ("listening", "muted"):
            with self.subTest(mode=mode):
                db = AsyncMock()
                db.execute = AsyncMock(side_effect=[_res(scalar=room), _res(scalar=mode)])
                with patch.object(G, "_gateway_rate_limit", AsyncMock()), patch.object(
                    G, "_resolve_agent_participant", AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4(), username="agent-grok", display_name="Grok"))
                ), patch.object(G, "send_message", AsyncMock()) as send:
                    with self.assertRaises(HTTPException) as ctx:
                        await G.gateway_post_message(
                            SimpleNamespace(room="crew", content="hi", parent_id=None, via=None),
                            SimpleNamespace(), self._principal(), db, AsyncMock(), AsyncMock(),
                        )
                self.assertEqual(ctx.exception.status_code, 403)
                self.assertIn(mode, ctx.exception.detail)
                send.assert_not_awaited()

    async def test_speaking_seat_posts(self) -> None:
        import app.api.gateway as G

        room = _room(room_type=RoomType.CHANNEL)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=room), _res(scalar="answers_all")])
        with patch.object(G, "_gateway_rate_limit", AsyncMock()), patch.object(
            G, "_resolve_agent_participant", AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4(), username="agent-grok", display_name="Grok"))
        ), patch.object(G, "send_message", AsyncMock(return_value="posted")) as send, patch.object(
            G, "touch_bridge_seen", AsyncMock()
        ), patch.object(G, "clear_relay_pending", AsyncMock()):
            out = await G.gateway_post_message(
                SimpleNamespace(room="crew", content="hi", parent_id=None, via=None),
                SimpleNamespace(), self._principal(), db, AsyncMock(), AsyncMock(),
            )
        self.assertEqual(out, "posted")
        send.assert_awaited_once()


class ResponderGateIsWired(unittest.TestCase):
    def test_respond_reads_the_mode_off_the_room_and_gates_on_it(self) -> None:
        from app.services import agent_chat_responder as R

        src = inspect.getsource(R._respond)
        self.assertIn("_should_respond(", src)
        self.assertIn("agent_mode=_agent_mode_for(room, agent_participant)", src)
        # Truth table (listening/muted never reply) is pinned by the L0 tests.
        self.assertFalse(R._should_respond(room_type="dm", content="@majik hi", brigade_agent_id="majik", agent_mode="listening"))
        self.assertFalse(R._should_respond(room_type="agent_hub", content="hi", brigade_agent_id="majik", agent_mode="muted"))


class MemberModeFanout(IsolatedAsyncioTestCase):
    async def test_patch_member_fans_out_member_mode(self) -> None:
        import app.api.conversation as C

        room_id, pid = uuid.uuid4(), uuid.uuid4()
        membership = SimpleNamespace(agent_mode="listening", context_depth=None)
        svc = SimpleNamespace(set_member_settings=AsyncMock(return_value=membership))
        with patch.object(C, "_build_room_service", return_value=svc), patch.object(
            C, "_ws_room", AsyncMock()
        ) as ws, patch.object(C, "_member_response_for", AsyncMock(return_value="row")):
            out = await C.set_member_settings(
                room_id, pid, SimpleNamespace(agent_mode="listening", context_depth=None),
                {"participant_id": uuid.uuid4()}, AsyncMock(), AsyncMock(), AsyncMock(),
            )
        self.assertEqual(out, "row")
        self.assertEqual(ws.await_args.args[2], "member_mode")
        self.assertEqual(ws.await_args.args[3]["agent_mode"], "listening")
        self.assertEqual(ws.await_args.args[3]["participant_id"], str(pid))


class ConvertGroupToChannelService(IsolatedAsyncioTestCase):
    def _svc(self, room, *, taken=None):
        from app.services.room_service import RoomService

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=room), _res(scalar=taken)])
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        svc._require_role = AsyncMock()
        return svc, db

    async def test_owner_converts_in_place_private_by_default(self) -> None:
        room = _room(metadata_={"brigade_agent_ids": ["majik"]})
        svc, db = self._svc(room)
        actor = uuid.uuid4()
        out = await svc.convert_group_to_channel(room_id=room.id, actor_id=actor)
        svc._require_role.assert_awaited_once_with(room.id, actor, ["owner"])
        self.assertIs(out, room)
        self.assertEqual(room.room_type, RoomType.CHANNEL)
        self.assertEqual(room.name, "show-crew")  # slug from the label
        self.assertEqual(room.display_name, "Show crew")
        self.assertEqual(room.visibility, "private")
        self.assertEqual(room.metadata_["converted_from"]["room_type"], "group_dm")
        self.assertEqual(room.metadata_["converted_from"]["name"], "crew")
        self.assertEqual(room.metadata_["brigade_agent_ids"], ["majik"])  # wiring kept
        db.commit.assert_awaited_once()

    async def test_explicit_name_label_and_visibility(self) -> None:
        room = _room()
        svc, _db = self._svc(room)
        await svc.convert_group_to_channel(room_id=room.id, actor_id=uuid.uuid4(), name="ops-crew", display_name="Ops crew", visibility="public")
        self.assertEqual((room.name, room.display_name, room.visibility), ("ops-crew", "Ops crew", "public"))

    async def test_refusals(self) -> None:
        for label, room, taken, expected in (
            ("not a group", _room(room_type=RoomType.DM), None, 409),
            ("a thread", _room(parent_room_id=uuid.uuid4()), None, 409),
            ("name taken", _room(), SimpleNamespace(), 409),
        ):
            with self.subTest(case=label):
                svc, _db = self._svc(room, taken=taken)
                with self.assertRaises(HTTPException) as ctx:
                    await svc.convert_group_to_channel(room_id=room.id, actor_id=uuid.uuid4())
                self.assertEqual(ctx.exception.status_code, expected)
        svc, _db = self._svc(_room())
        with self.assertRaises(HTTPException) as ctx:
            await svc.convert_group_to_channel(room_id=uuid.uuid4(), actor_id=uuid.uuid4(), name="Bad Name!")
        self.assertEqual(ctx.exception.status_code, 422)
        svc, _db = self._svc(_room())
        with self.assertRaises(HTTPException) as ctx:
            await svc.convert_group_to_channel(room_id=uuid.uuid4(), actor_id=uuid.uuid4(), visibility="secret")
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_non_owner_is_refused_by_the_role_ladder(self) -> None:
        from app.services.room_service import RoomService

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=SimpleNamespace(role=SimpleNamespace(value="admin"))))
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        with self.assertRaises(HTTPException) as ctx:
            await svc.convert_group_to_channel(room_id=uuid.uuid4(), actor_id=uuid.uuid4())
        self.assertEqual(ctx.exception.status_code, 403)


class ConvertRouteAuditsAndFansOut(IsolatedAsyncioTestCase):
    async def test_audit_row_and_room_converted_event(self) -> None:
        import app.api.conversation as C

        room = _room(room_type=RoomType.CHANNEL, name="show-crew", visibility="private",
                     metadata_={"converted_from": {"room_type": "group_dm", "name": "crew"}})
        svc = SimpleNamespace(convert_group_to_channel=AsyncMock(return_value=room))
        db = AsyncMock()
        db.add = MagicMock()
        me = uuid.uuid4()
        user = {"participant_id": me, "username": "aaron", "sub": "kc-aaron"}
        with patch.object(C, "_build_room_service", return_value=svc), patch.object(
            C, "_ws_room", AsyncMock()
        ) as ws, patch.object(C, "_room_response", AsyncMock(return_value="room-out")):
            out = await C.convert_group_to_channel(
                room.id, SimpleNamespace(name=None, display_name=None, visibility="private"), user, db, AsyncMock(), AsyncMock(),
            )
        self.assertEqual(out, "room-out")
        self.assertEqual(svc.convert_group_to_channel.await_args.kwargs["actor_id"], me)
        audit = db.add.call_args.args[0]
        self.assertIsInstance(audit, AgentEvent)
        self.assertEqual(audit.event_type, "room.converted_to_channel")
        self.assertEqual(audit.agent_identity, "aaron")
        self.assertEqual(audit.room_ref, str(room.id))
        self.assertEqual(audit.event_data["from_room_type"], "group_dm")
        self.assertEqual(audit.event_data["to_room_type"], "channel")
        self.assertEqual(audit.event_data["from_name"], "crew")
        self.assertEqual(audit.event_data["by"], str(me))
        db.commit.assert_awaited_once()
        self.assertEqual(ws.await_args.args[2], "room_converted")
        self.assertEqual(ws.await_args.args[3]["room_type"], "channel")
        self.assertEqual(ws.await_args.args[3]["visibility"], "private")

    def test_route_is_mounted_for_real_users_only(self) -> None:
        import typing

        import app.api.conversation as C
        from app.main import create_app

        paths = create_app().openapi()["paths"]
        self.assertIn("/api/v1/rooms/{room_id}/convert-to-channel", paths)
        self.assertIn("/api/v1/rooms/for-project", paths)
        self.assertIn("/api/v1/rooms/{room_id}/tasks", paths)
        hints = typing.get_type_hints(C.convert_group_to_channel, include_extras=True, globalns=vars(C))
        names = [getattr(m.dependency, "__name__", "") for ann in hints.values() for m in getattr(ann, "__metadata__", ()) if hasattr(m, "dependency")]
        self.assertIn("get_current_user", names)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
