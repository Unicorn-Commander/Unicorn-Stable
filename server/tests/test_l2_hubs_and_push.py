"""L2 — agent hubs (item 1) and the new-room push (item 7).

* a NEW hub starts with voice settings: ``voice_relay_source`` = the human's
  username, ``voice_relay_activation`` = always, the agent's preset voice
  from the server TTS preset table;
* the hub route runs the agent-access entitlement funnel and pushes the hub
  to the caller's sockets when it created one;
* ``room_invited`` pushes: the actor's own sockets get NO ``inviter_name``
  (refetch, no toast), everyone else gets it; ids are de-duplicated; the
  thread route pushes every seeded member; the accept route pushes the
  joiner; ``createAgentDm``'s server half is documented as deprecated.
"""

from __future__ import annotations

import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from app.models.participant import ParticipantType
from app.models.room import RoomType
from app.services.room_push import PUSH_KINDS, ROOM_INVITED, push_room_to_participants, room_push_payload
from app.services.room_service import RoomService, ThreadCreation

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
        id=uuid.uuid4(), name="hub-abc", display_name="Persephone", description=None,
        room_type=RoomType.AGENT_HUB, livekit_room_name="stable-hub-abc", livekit_sid=None,
        max_participants=50, metadata_={}, is_archived=False, created_by=None,
        created_at=NOW, updated_at=NOW, parent_room_id=None, visibility="public",
        project_number=None, recording_policy="off", recording_kind="audio", org_id=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


class HubVoiceDefaults(IsolatedAsyncioTestCase):
    async def test_defaults_name_the_human_always_and_the_preset_voice(self) -> None:
        from app.api.tts import resolve_agent_voice

        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar="aaron"))
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        meta = await svc._hub_voice_defaults(uuid.uuid4(), "persephone")
        self.assertEqual(meta["voice_relay_source"], "aaron")
        self.assertEqual(meta["voice_relay_activation"], "always")
        self.assertEqual(meta["voice_relay_agent_id"], "persephone")
        self.assertEqual(meta["voice_primary_agent_id"], "persephone")
        self.assertEqual(meta["voice_relay_voices"], {"persephone": resolve_agent_voice("persephone")})
        self.assertEqual(meta["voice_relay_voices"]["persephone"], "af_heart")

    async def test_unknown_agent_gets_no_voice_row_and_no_source_without_username(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=None))
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        meta = await svc._hub_voice_defaults(uuid.uuid4(), "nobody-here")
        self.assertNotIn("voice_relay_voices", meta)
        self.assertNotIn("voice_relay_source", meta)
        self.assertEqual(meta["voice_relay_activation"], "always")

    async def test_ensure_agent_hub_seeds_the_defaults_on_creation_only(self) -> None:
        human_id = uuid.uuid4()
        agent_p = SimpleNamespace(id=uuid.uuid4(), display_name="Persephone", metadata_=None)
        db = AsyncMock()
        db.add = MagicMock()
        db.execute = AsyncMock(side_effect=[
            _res(scalar=None),      # no existing hub
            _res(scalar=agent_p),   # find_agent_participant
            _res(scalar="aaron"),   # human username for voice_relay_source
            _res(scalar=None),      # human membership → add OWNER
            _res(scalar=None),      # agent membership → add answers_all
        ])
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        hub = _room()
        svc.create_room = AsyncMock(return_value=hub)
        room, created = await svc.ensure_agent_hub(human_id=human_id, agent_id="persephone", org_id=None)
        self.assertTrue(created)
        self.assertIs(room, hub)
        meta = svc.create_room.call_args.kwargs["metadata"]
        self.assertEqual(meta["agent_hub"], {"human_id": str(human_id), "agent_id": "persephone"})
        self.assertEqual(meta["brigade_agent_id"], "persephone")
        self.assertEqual(meta["voice_relay_source"], "aaron")
        self.assertEqual(meta["voice_relay_activation"], "always")
        self.assertEqual(meta["voice_relay_voices"], {"persephone": "af_heart"})
        modes = [a.args[0].agent_mode for a in db.add.call_args_list if hasattr(a.args[0], "agent_mode")]
        self.assertIn("answers_all", modes)

        # An EXISTING hub: no create, no voice rewrite.
        db.execute = AsyncMock(side_effect=[
            _res(scalar=hub),
            _res(scalar=agent_p),
            _res(scalar=SimpleNamespace(role="owner")),
            _res(scalar=SimpleNamespace(agent_mode="answers_all")),
        ])
        svc.create_room = AsyncMock()
        room, created = await svc.ensure_agent_hub(human_id=human_id, agent_id="persephone", org_id=None)
        self.assertFalse(created)
        svc.create_room.assert_not_awaited()


class HubRoute(IsolatedAsyncioTestCase):
    async def _call(self, created: bool):
        import app.api.conversation as C

        hub = _room()
        svc = SimpleNamespace(
            ensure_agent_hub=AsyncMock(return_value=(hub, created)),
            get_room=AsyncMock(return_value={"room": hub, "member_count": 2, "online_count": 1}),
            room_extras=AsyncMock(return_value={}),
        )
        user = {"participant_id": uuid.uuid4(), "username": "aaron", "display_name": "Aaron"}
        with patch.object(C, "_build_room_service", return_value=svc), patch.object(
            C, "ensure_agent_access", AsyncMock()
        ) as gate, patch.object(C, "push_room_to_participants", AsyncMock()) as push:
            out = await C.ensure_agent_hub(
                "Persephone", user, SimpleNamespace(instance_org_id=None), AsyncMock(), AsyncMock(), AsyncMock(), None
            )
        return out, gate, push, user, hub

    async def test_entitlement_funnel_runs_and_creation_pushes_the_caller(self) -> None:
        out, gate, push, user, hub = await self._call(created=True)
        self.assertTrue(out.created)
        self.assertEqual(out.display_name, "Persephone")
        gate.assert_awaited_once()
        self.assertEqual(gate.await_args.args[2], "persephone")  # normalised agent id
        self.assertEqual(gate.await_args.kwargs["surface"], "agent_hub")
        push.assert_awaited_once()
        self.assertEqual(push.await_args.kwargs["kind"], "hub")
        self.assertEqual(push.await_args.kwargs["self_id"], user["participant_id"])
        self.assertEqual(list(push.await_args.args[0]), [user["participant_id"]])

    async def test_existing_hub_is_not_pushed_again(self) -> None:
        out, gate, push, _user, _hub = await self._call(created=False)
        self.assertFalse(out.created)
        gate.assert_awaited_once()
        push.assert_not_awaited()


class RoomInvitedPush(IsolatedAsyncioTestCase):
    def test_payload_shape(self) -> None:
        rid, pid = uuid.uuid4(), uuid.uuid4()
        p = room_push_payload(room_id=rid, kind="thread", inviter_name="Aaron", parent_room_id=pid, display_name="Plan")
        self.assertEqual(p, {
            "room_id": str(rid), "kind": "thread", "inviter_name": "Aaron",
            "parent_room_id": str(pid), "display_name": "Plan",
        })
        # No inviter → key ABSENT (the web toasts on presence, refetches always).
        self.assertNotIn("inviter_name", room_push_payload(room_id=rid, kind="hub"))
        with self.assertRaises(ValueError):
            room_push_payload(room_id=rid, kind="mystery")
        for kind in ("hub", "thread", "group", "invite", "project_channel"):
            self.assertIn(kind, PUSH_KINDS)

    async def test_self_gets_refetch_only_others_get_the_toast_and_ids_dedupe(self) -> None:
        me, bob = uuid.uuid4(), uuid.uuid4()
        rid = uuid.uuid4()
        with patch("app.api.messages._ws_send_participant", AsyncMock()) as send:
            n = await push_room_to_participants(
                [me, bob, str(bob), None], room_id=rid, kind="thread", inviter_name="Aaron", self_id=me
            )
        self.assertEqual(n, 2)
        self.assertEqual(send.await_count, 2)
        by_pid = {c.args[0]: c.args[1] for c in send.await_args_list}
        self.assertEqual(by_pid[str(me)]["type"], ROOM_INVITED)
        self.assertNotIn("inviter_name", by_pid[str(me)]["payload"])
        self.assertEqual(by_pid[str(bob)]["payload"]["inviter_name"], "Aaron")
        self.assertEqual(by_pid[str(bob)]["payload"]["room_id"], str(rid))

    async def test_a_failed_publish_never_raises(self) -> None:
        with patch("app.api.messages._ws_send_participant", AsyncMock(side_effect=RuntimeError("redis down"))):
            n = await push_room_to_participants([uuid.uuid4()], room_id=uuid.uuid4(), kind="invite")
        self.assertEqual(n, 1)


class ThreadRoutePushesEveryMember(IsolatedAsyncioTestCase):
    async def test_thread_created_fanout_system_line_and_member_push(self) -> None:
        import app.api.conversation as C

        parent_id = uuid.uuid4()
        me, agent, bob = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        thread = _room(name="hub-abc-t-1", display_name="Plan", parent_room_id=parent_id)
        system_line = SimpleNamespace(room_id=parent_id)
        made = ThreadCreation(room=thread, system_message=system_line, seed_message=None, member_ids=[me, agent, bob])
        svc = SimpleNamespace(
            create_thread=AsyncMock(return_value=made),
            get_room=AsyncMock(return_value={"room": thread, "member_count": 3, "online_count": 0}),
            room_extras=AsyncMock(return_value={}),
        )
        user = {"participant_id": me, "username": "aaron", "display_name": "Aaron"}
        body = SimpleNamespace(title="Plan", seed_message_id=None)
        with patch.object(C, "_build_room_service", return_value=svc), patch.object(
            C, "_ws_room", AsyncMock()
        ) as ws_room, patch.object(C, "_fanout_message", AsyncMock()) as fanout, patch.object(
            C, "push_room_to_participants", AsyncMock()
        ) as push:
            out = await C.create_thread(parent_id, body, user, AsyncMock(), AsyncMock(), AsyncMock(), None)
        self.assertEqual(out.parent_room_id, parent_id)
        # thread_created to the parent room, with the seeded members.
        self.assertEqual(ws_room.await_args.args[2], "thread_created")
        self.assertEqual(ws_room.await_args.args[3]["member_ids"], [str(me), str(agent), str(bob)])
        # The system line (and the absent seed) go through the message fan-out.
        self.assertEqual(fanout.await_count, 2)
        self.assertIs(fanout.await_args_list[0].args[1], system_line)
        # Every seeded member's sockets get the room; the creator without a toast.
        push.assert_awaited_once()
        self.assertEqual(list(push.await_args.args[0]), [me, agent, bob])
        self.assertEqual(push.await_args.kwargs["kind"], "thread")
        self.assertEqual(push.await_args.kwargs["self_id"], me)
        self.assertEqual(push.await_args.kwargs["parent_room_id"], parent_id)


class AcceptRoutePushesTheJoiner(IsolatedAsyncioTestCase):
    async def test_new_member_is_pushed_with_the_minters_name(self) -> None:
        import app.api.conversation as C
        from app.api.conversation import mint_invite_token
        from app.auth.gateway_auth import hash_key

        raw = mint_invite_token()
        room = _room(room_type=RoomType.CHANNEL, visibility="private", display_name="Ops")
        minter = uuid.uuid4()
        invite = SimpleNamespace(
            id=uuid.uuid4(), room_id=room.id, token_hash=hash_key(raw), token_prefix=raw[:12], role="member",
            expires_at=datetime(2099, 1, 1, tzinfo=timezone.utc), max_uses=None, use_count=0, revoked_at=None,
            created_by=minter,
        )
        me = uuid.uuid4()
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _res(scalar=invite),   # token lookup (FOR UPDATE)
            _res(scalar=room),     # room
            _res(scalar=None),     # not a member yet
            _res(scalar="Aaron"),  # minter display name
        ])
        svc = SimpleNamespace(join_room=AsyncMock(return_value=SimpleNamespace()))
        user = {"participant_id": me, "username": "bob", "display_name": "Bob"}
        with patch.object(C, "_build_room_service", return_value=svc), patch.object(
            C, "_broadcast_members_changed", AsyncMock()
        ), patch.object(C, "_member_response_for", AsyncMock(return_value="member-row")), patch.object(
            C, "push_room_to_participants", AsyncMock()
        ) as push:
            out = await C.accept_invite(raw, user, db, AsyncMock(), AsyncMock(), None)
        self.assertEqual(out, "member-row")
        self.assertEqual(invite.use_count, 1)
        svc.join_room.assert_awaited_once()
        self.assertFalse(svc.join_room.await_args.kwargs["self_join"])
        push.assert_awaited_once()
        self.assertEqual(list(push.await_args.args[0]), [me])
        self.assertEqual(push.await_args.kwargs["kind"], "invite")
        self.assertEqual(push.await_args.kwargs["inviter_name"], "Aaron")


class StartGroupPushesTheCreatorToo(unittest.TestCase):
    def test_route_pushes_through_the_shared_helper_with_self_id(self) -> None:
        import inspect

        import app.api.rooms as R

        src = inspect.getsource(R.start_group_from_dm)
        self.assertIn("push_room_to_participants(", src)
        self.assertIn('kind="group"', src)
        self.assertIn('self_id=user["participant_id"]', src)


class DeprecatedAgentDm(unittest.TestCase):
    def test_room_type_dm_for_agent_chats_is_documented_deprecated_but_still_valid(self) -> None:
        from app.schemas.room import RoomCreate

        desc = RoomCreate.model_fields["room_type"].description or ""
        self.assertIn("deprecated", desc.lower())
        self.assertIn("/agents/{agent_id}/hub", desc)
        # Still works: the old client keeps minting dm rooms until L3 lands.
        self.assertEqual(RoomCreate(name="chat-with-majik", display_name="Chat with Majik", room_type="dm").room_type, "dm")

    def test_agent_participant_type_is_what_the_hub_binds(self) -> None:
        self.assertEqual(ParticipantType.AGENT.value, "agent")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
