"""Tests for the explicit DM → new-group conversion (start_group_from_dm).

Covers the pure composition plan (compose_group_seed + naming/slug helpers)
and the RoomService gates + transactional create, in the same mocked-session
style as test_ensure_human_dm.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException

from app.models.participant import ParticipantType
from app.models.room import MemberRole, Room, RoomMember, RoomType
from app.services.room_service import (
    RoomService,
    compose_group_seed,
    group_display_name,
    group_slug_base,
)


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class ComposeGroupSeedTests(TestCase):
    def test_seeds_source_members_then_extras_deduped(self) -> None:
        a, b, c = str(_uuid()), str(_uuid()), str(_uuid())
        seed = compose_group_seed(
            source_room_id="src",
            source_member_ids=[a, b],
            source_agent_ids=[],
            source_metadata=None,
            extra_participant_ids=[b, c, c],
            new_agent_ids=[],
        )
        self.assertEqual(seed.member_ids, (a, b, c))
        self.assertEqual(seed.agent_ids_to_create, ())
        self.assertIsNone(seed.canonical_agent_id)
        self.assertEqual(seed.metadata, {"origin_dm_id": "src"})

    def test_resident_agent_not_recreated_and_stays_canonical(self) -> None:
        a, agent_pid = str(_uuid()), str(_uuid())
        seed = compose_group_seed(
            source_room_id="src",
            source_member_ids=[a, agent_pid],
            source_agent_ids=["perry"],
            source_metadata={"brigade_agent_id": "perry"},
            extra_participant_ids=[],
            new_agent_ids=["perry"],  # re-picking the resident is a no-op add
        )
        self.assertEqual(seed.agent_ids_to_create, ())
        # Raw last-invited order: re-picking the resident keeps it canonical.
        self.assertEqual(seed.canonical_agent_id, "perry")
        # The agent's member row rides along like any other source member.
        self.assertIn(agent_pid, seed.member_ids)

    def test_last_new_agent_wins_canonical(self) -> None:
        seed = compose_group_seed(
            source_room_id="src",
            source_member_ids=[str(_uuid())],
            source_agent_ids=["perry"],
            source_metadata={"brigade_agent_id": "perry"},
            extra_participant_ids=[],
            new_agent_ids=["iris", "sgt-cipher"],
        )
        self.assertEqual(seed.agent_ids_to_create, ("iris", "sgt-cipher"))
        self.assertEqual(seed.canonical_agent_id, "sgt-cipher")
        self.assertEqual(seed.metadata["brigade_agent_id"], "sgt-cipher")

    def test_source_agent_canonical_when_no_new_agents(self) -> None:
        seed = compose_group_seed(
            source_room_id="src",
            source_member_ids=[str(_uuid()), str(_uuid())],
            source_agent_ids=["perry"],
            source_metadata={"brigade_agent_id": "perry"},
            extra_participant_ids=[str(_uuid())],
            new_agent_ids=[],
        )
        self.assertEqual(seed.canonical_agent_id, "perry")
        self.assertEqual(seed.metadata["brigade_agent_id"], "perry")

    def test_metadata_carries_model_override_and_provenance_only(self) -> None:
        src = str(_uuid())
        seed = compose_group_seed(
            source_room_id=src,
            source_member_ids=[str(_uuid()), str(_uuid())],
            source_agent_ids=[],
            source_metadata={
                "model_override": "uc/chat-default-nothink",
                "dm_pair": "a:b",  # private-DM key must NOT leak into the group
                "pinned_message_ids": ["m1"],  # nor pins/history furniture
            },
            extra_participant_ids=[],
            new_agent_ids=[],
        )
        self.assertEqual(
            seed.metadata,
            {"origin_dm_id": src, "model_override": "uc/chat-default-nothink"},
        )

    def test_human_dm_no_agents_yields_no_brigade_binding(self) -> None:
        seed = compose_group_seed(
            source_room_id="src",
            source_member_ids=[str(_uuid()), str(_uuid())],
            source_agent_ids=[],
            source_metadata={},
            extra_participant_ids=[],
            new_agent_ids=[],
        )
        self.assertNotIn("brigade_agent_id", seed.metadata)


class NamingHelperTests(TestCase):
    def test_display_name_caps_at_three(self) -> None:
        self.assertEqual(
            group_display_name(["Alice", "Bob", "Cara", "Dan"]),
            "Group: Alice, Bob, Cara",
        )

    def test_display_name_skips_blanks_and_falls_back(self) -> None:
        self.assertEqual(group_display_name(["", "  ", "Perry"]), "Group: Perry")
        self.assertEqual(group_display_name([]), "Group chat")

    def test_slug_base_sanitizes_and_falls_back(self) -> None:
        self.assertEqual(group_slug_base("Group: Alice, Bob!"), "group-alice-bob")
        self.assertEqual(group_slug_base("Ω≈ç√"), "group")
        self.assertLessEqual(len(group_slug_base("x" * 500)), 80)


class StartGroupFromDmServiceTests(IsolatedAsyncioTestCase):
    def _service(self) -> tuple[RoomService, AsyncMock, AsyncMock]:
        db = AsyncMock()
        db.add = MagicMock()  # session.add is sync
        livekit = AsyncMock()
        presence = AsyncMock()
        svc = RoomService(db=db, livekit=livekit, presence=presence)
        return svc, db, livekit

    def _participant(
        self,
        pid: uuid.UUID,
        *,
        ptype: ParticipantType = ParticipantType.HUMAN,
        name: str = "bob",
        sub: str | None = None,
    ) -> SimpleNamespace:
        return SimpleNamespace(
            id=pid,
            participant_type=ptype,
            display_name=name.title(),
            username=name,
            keycloak_sub=sub or f"kc-{name}",
        )

    def _dm_room(
        self,
        room_id: uuid.UUID,
        *,
        room_type: RoomType = RoomType.DM,
        metadata: dict | None = None,
    ) -> SimpleNamespace:
        return SimpleNamespace(
            id=room_id,
            name="dm-x-y",
            display_name="DM with Bob",
            description=None,
            room_type=room_type,
            livekit_room_name="stable-dm-x-y",
            livekit_sid="LK_1",
            max_participants=2,
            metadata_=dict(metadata or {}),
            is_archived=False,
            created_by=None,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
            org_id=None,
        )

    @staticmethod
    def _scalar(value) -> MagicMock:
        row = MagicMock()
        row.scalar_one_or_none.return_value = value
        return row

    @staticmethod
    def _rows(pairs) -> MagicMock:
        row = MagicMock()
        row.all.return_value = pairs
        return row

    @staticmethod
    def _scalars(values) -> MagicMock:
        row = MagicMock()
        row.scalars.return_value.all.return_value = values
        return row

    async def test_404_when_room_missing(self) -> None:
        svc, db, _lk = self._service()
        db.execute = AsyncMock(return_value=self._scalar(None))
        with self.assertRaises(HTTPException) as ctx:
            await svc.start_group_from_dm(
                source_room_id=_uuid(), caller_id=_uuid()
            )
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_400_when_source_is_not_a_dm(self) -> None:
        svc, db, _lk = self._service()
        room = self._dm_room(_uuid(), room_type=RoomType.CHANNEL)
        db.execute = AsyncMock(return_value=self._scalar(room))
        with self.assertRaises(HTTPException) as ctx:
            await svc.start_group_from_dm(
                source_room_id=room.id, caller_id=_uuid()
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("1:1 DM", ctx.exception.detail)

    async def test_403_when_caller_not_a_member(self) -> None:
        svc, db, _lk = self._service()
        room = self._dm_room(_uuid())
        peer = self._participant(_uuid(), name="alice")
        other = self._participant(_uuid(), name="bob")
        db.execute = AsyncMock(
            side_effect=[
                self._scalar(room),
                self._rows([(MagicMock(), peer), (MagicMock(), other)]),
            ]
        )
        with self.assertRaises(HTTPException) as ctx:
            await svc.start_group_from_dm(
                source_room_id=room.id, caller_id=_uuid()
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_404_when_extra_participant_unknown(self) -> None:
        svc, db, _lk = self._service()
        room = self._dm_room(_uuid())
        caller = self._participant(_uuid(), name="me")
        peer = self._participant(_uuid(), name="alice")
        db.execute = AsyncMock(
            side_effect=[
                self._scalar(room),
                self._rows([(MagicMock(), caller), (MagicMock(), peer)]),
                self._scalars([]),  # extras lookup finds nobody
            ]
        )
        with self.assertRaises(HTTPException) as ctx:
            await svc.start_group_from_dm(
                source_room_id=room.id,
                caller_id=caller.id,
                extra_participant_ids=[_uuid()],
            )
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_400_when_extra_participant_is_an_agent(self) -> None:
        svc, db, _lk = self._service()
        room = self._dm_room(_uuid())
        caller = self._participant(_uuid(), name="me")
        peer = self._participant(_uuid(), name="alice")
        agent = self._participant(
            _uuid(), ptype=ParticipantType.AGENT, name="perry", sub="brigade:perry"
        )
        db.execute = AsyncMock(
            side_effect=[
                self._scalar(room),
                self._rows([(MagicMock(), caller), (MagicMock(), peer)]),
                self._scalars([agent]),
            ]
        )
        with self.assertRaises(HTTPException) as ctx:
            await svc.start_group_from_dm(
                source_room_id=room.id,
                caller_id=caller.id,
                extra_participant_ids=[agent.id],
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("agent_ids", ctx.exception.detail)

    async def test_happy_path_creates_group_atomically(self) -> None:
        svc, db, livekit = self._service()
        source = self._dm_room(
            _uuid(), metadata={"brigade_agent_id": "perry", "dm_pair": "a:b"}
        )
        caller = self._participant(_uuid(), name="me")
        peer = self._participant(_uuid(), name="alice")
        resident = self._participant(
            _uuid(), ptype=ParticipantType.AGENT, name="perry", sub="brigade:perry"
        )
        extra = self._participant(_uuid(), name="cara")

        livekit.create_room = AsyncMock(
            return_value=SimpleNamespace(sid="LK_G", name="stable-group")
        )
        db.execute = AsyncMock(
            side_effect=[
                self._scalar(source),  # source room
                self._rows(
                    [
                        (MagicMock(), caller),
                        (MagicMock(), peer),
                        (MagicMock(), resident),
                    ]
                ),
                self._scalar(None),  # new agent backend check
                self._scalar(None),  # no external gateway registration
                self._scalars([extra]),  # extras validation
                self._scalar(None),  # new agent "iris" participant lookup
                self._scalar(None),  # slug free
            ]
        )
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()

        room = await svc.start_group_from_dm(
            source_room_id=source.id,
            caller_id=caller.id,
            extra_participant_ids=[extra.id],
            new_agent_ids=["iris"],
            agent_names={"iris": "Iris"},
            display_name="Group: Alice, Cara, Iris",
            org_id=None,
        )

        # New room: a group_dm with the client label, source untouched.
        self.assertEqual(room.room_type, RoomType.GROUP_DM)
        self.assertEqual(room.display_name, "Group: Alice, Cara, Iris")
        self.assertEqual(source.room_type, RoomType.DM)
        self.assertEqual(
            source.metadata_,
            {"brigade_agent_id": "perry", "dm_pair": "a:b"},
        )

        # Provenance + carried binding, never the private dm_pair key.
        self.assertEqual(room.metadata_["origin_dm_id"], str(source.id))
        self.assertEqual(room.metadata_["brigade_agent_id"], "iris")
        self.assertNotIn("dm_pair", room.metadata_)

        added = [c.args[0] for c in db.add.call_args_list]
        rooms_added = [a for a in added if isinstance(a, Room)]
        members_added = [a for a in added if isinstance(a, RoomMember)]
        self.assertEqual(len(rooms_added), 1)
        # caller + peer + resident agent + extra + new agent participant
        self.assertEqual(len(members_added), 5)
        roles = {
            str(m.participant_id): m.role for m in members_added
        }
        self.assertEqual(roles[str(caller.id)], MemberRole.OWNER)
        self.assertEqual(roles[str(peer.id)], MemberRole.MEMBER)
        self.assertEqual(roles[str(resident.id)], MemberRole.MEMBER)
        self.assertEqual(roles[str(extra.id)], MemberRole.MEMBER)

        # ONE commit — the room and every membership land together.
        db.commit.assert_awaited_once()
        livekit.create_room.assert_awaited_once()
        self.assertEqual(
            livekit.create_room.await_args.kwargs["max_participants"], 50
        )

    async def test_server_derives_label_when_client_sends_none(self) -> None:
        svc, db, livekit = self._service()
        source = self._dm_room(_uuid())
        caller = self._participant(_uuid(), name="me")
        peer = self._participant(_uuid(), name="alice")

        livekit.create_room = AsyncMock(
            return_value=SimpleNamespace(sid="LK_G", name="x")
        )
        db.execute = AsyncMock(
            side_effect=[
                self._scalar(source),
                self._rows([(MagicMock(), caller), (MagicMock(), peer)]),
                self._scalar(None),  # slug free
            ]
        )
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()

        room = await svc.start_group_from_dm(
            source_room_id=source.id,
            caller_id=caller.id,
        )
        # Peer first, caller excluded — the standing CreateDmModal formula.
        self.assertEqual(room.display_name, "Group: Alice")
        self.assertTrue(room.name.startswith("group-alice"))


class KickClearsResponderBindingTest(TestCase):
    """Kicking the resident agent must clear metadata.brigade_agent_id.

    The text responder answers as the room's metadata binding — if the kick
    leaves it pointing at the evicted agent, the agent keeps replying after
    removal (the kickability requirement fails silently).
    """

    def test_metadata_binding_cleared_on_kick(self) -> None:
        import inspect

        import app.api.brigade as brigade_api

        source = inspect.getsource(brigade_api.remove_brigade_agent)
        # The kick path must both drop the member row AND revoke the residency
        # binding. Since the multi-agent SET form, that is delegated to
        # remove_resident_agent (drops the agent from brigade_agent_ids and
        # re-points the canonical scalar at whoever remains), reassigned — not
        # mutated — for JSONB change detection.
        self.assertIn(
            "room.metadata_ = remove_resident_agent(room.metadata_, brigade_agent_id)",
            source,
        )
