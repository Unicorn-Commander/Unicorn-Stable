"""Mention-triggered agent membership is explicit, scoped, and idempotent."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from app.models.room import MemberRole
from app.services import agent_chat_responder as responder


class _Result:
    def __init__(self, value=None, many=None):
        self.value = value
        self.many = many or []

    def scalar_one_or_none(self):
        return self.value

    def scalars(self):
        return SimpleNamespace(all=lambda: list(self.many))


def _db(*results):
    db = MagicMock()
    db.execute = AsyncMock(side_effect=[_Result(value) for value in results])
    db.add = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.rollback = AsyncMock()
    return db


def _fixture():
    room = SimpleNamespace(id=uuid.uuid4(), metadata_={})
    sender = SimpleNamespace(
        id=uuid.uuid4(), display_name="Dana Example", username="dana-example"
    )
    agent = SimpleNamespace(
        id=uuid.uuid4(),
        keycloak_sub="brigade:sidekick",
        display_name="Sidekick",
        metadata_={},
    )
    return room, sender, agent


class MentionAgentMembershipTests(IsolatedAsyncioTestCase):
    async def test_member_can_mention_invite_and_get_one_join_notice(self) -> None:
        room, sender, agent = _fixture()
        caller_member = SimpleNamespace(role=MemberRole.MEMBER)
        db = _db(None, caller_member)

        with (
            patch.object(
                responder,
                "resolve_agent_access",
                new=AsyncMock(return_value=(True, "default_open")),
            ),
            patch.object(responder, "_post_agent_system_message", new=AsyncMock()) as notice,
            patch.object(responder, "_broadcast_agent_members_changed", new=AsyncMock()),
        ):
            resolved = await responder._ensure_mentioned_agent_member(
                db=db,
                room=room,
                sender_id=sender.id,
                sender=sender,
                agent_id="sidekick",
                agent_name="Sidekick",
                agent_participant=agent,
            )

        self.assertEqual(resolved, ("sidekick", agent))
        self.assertEqual(room.metadata_["brigade_agent_id"], "sidekick")
        self.assertEqual(room.metadata_["brigade_agent_ids"], ["sidekick"])
        db.commit.assert_awaited_once()
        self.assertEqual(len(db.add.call_args_list), 1)
        added_member = db.add.call_args.args[0]
        self.assertEqual((added_member.room_id, added_member.participant_id), (room.id, agent.id))
        notice.assert_awaited_once()
        self.assertIn("Sidekick joined (mentioned by Dana Example)", notice.call_args.kwargs["content"])

    async def test_non_member_without_invite_rights_gets_members_notice(self) -> None:
        room, sender, agent = _fixture()
        db = _db(None, None)

        with patch.object(responder, "_post_agent_system_message", new=AsyncMock()) as notice:
            resolved = await responder._ensure_mentioned_agent_member(
                db=db,
                room=room,
                sender_id=sender.id,
                sender=sender,
                agent_id="sidekick",
                agent_name="Sidekick",
                agent_participant=agent,
            )

        self.assertEqual(resolved, (None, None))
        db.commit.assert_not_awaited()
        db.add.assert_not_called()
        notice.assert_awaited_once()
        self.assertEqual(
            notice.call_args.kwargs["content"],
            "Sidekick is not in this room — invite it from Members",
        )

    async def test_already_member_keeps_existing_dispatch_resolution(self) -> None:
        room, sender, agent = _fixture()
        existing_member = SimpleNamespace(role=MemberRole.MEMBER)
        db = _db(existing_member)

        with (
            patch.object(responder, "resolve_agent_access", new=AsyncMock()) as access,
            patch.object(responder, "_post_agent_system_message", new=AsyncMock()) as notice,
        ):
            resolved = await responder._ensure_mentioned_agent_member(
                db=db,
                room=room,
                sender_id=sender.id,
                sender=sender,
                agent_id="sidekick",
                agent_name="Sidekick",
                agent_participant=agent,
            )

        self.assertEqual(resolved, ("sidekick", agent))
        access.assert_not_awaited()
        notice.assert_not_awaited()
        db.commit.assert_not_awaited()
        self.assertEqual(db.execute.await_count, 1)

    async def test_resolver_invites_an_explicit_roster_mention(self) -> None:
        room, sender, agent = _fixture()
        caller_member = SimpleNamespace(role=MemberRole.MEMBER)
        db = MagicMock()
        db.execute = AsyncMock(
            side_effect=[
                _Result(many=[]),  # agent members in this room
                _Result(many=[agent]),  # known agent participants
                _Result(None),  # target membership
                _Result(caller_member),  # poster membership
            ]
        )
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()

        with (
            patch.object(
                responder,
                "resolve_agent_access",
                new=AsyncMock(return_value=(True, "default_open")),
            ),
            patch.object(responder, "_post_agent_system_message", new=AsyncMock()),
            patch.object(responder, "_broadcast_agent_members_changed", new=AsyncMock()),
        ):
            resolved = await responder._resolve_agent(
                db=db,
                room=room,
                content="@Sidekick please help",
                sender_id=sender.id,
                sender=sender,
            )

        self.assertEqual(resolved, ("sidekick", agent))

    async def test_council_selects_existing_sidekick_when_channel_has_no_agent(self) -> None:
        room, sender, agent = _fixture()
        caller_member = SimpleNamespace(role=MemberRole.MEMBER)
        db = MagicMock()
        db.execute = AsyncMock(
            side_effect=[
                _Result(many=[]),  # agent members in this room
                _Result(many=[agent]),  # known global agent participants
                _Result(None),  # target membership
                _Result(caller_member),  # poster membership
            ]
        )
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()

        with (
            patch.object(
                responder,
                "resolve_agent_access",
                new=AsyncMock(return_value=(True, "default_open")),
            ),
            patch.object(responder, "_post_agent_system_message", new=AsyncMock()),
            patch.object(responder, "_broadcast_agent_members_changed", new=AsyncMock()),
            patch.object(responder, "find_agent_participant", new=AsyncMock(return_value=agent)),
        ):
            resolved = await responder._resolve_agent(
                db=db,
                room=room,
                content="is the cap right?",
                metadata={"council": True},
                sender_id=sender.id,
                sender=sender,
            )

        self.assertEqual(resolved, ("sidekick", agent))
