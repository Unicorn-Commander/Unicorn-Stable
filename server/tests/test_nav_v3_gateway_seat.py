"""Nav v3 C1 — the gateway's seat surface.

* ``GET /gateway/rooms``: every non-archived room the key's seat is a member
  of, with room_class / humans / own_seats / foreign_seats / guests, the
  seat's own agent_mode and the room's ``seat`` setting;
* ``GET /gateway/rooms/{room}/context`` gains ``room_class`` and ``seat``;
* ``PUT /gateway/me``: validated capabilities stored under the seat
  participant's ``metadata.seat_capabilities`` (merged, never clobbering).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import ValidationError

from app.api import gateway as G
from app.models.participant import ParticipantType
from app.models.room import RoomType

NOW = datetime(2026, 9, 28, 22, 0, tzinfo=timezone.utc)


def _res(*, scalar=None, scalars=None):
    res = MagicMock()
    res.scalar_one_or_none.return_value = scalar
    res.scalars.return_value.all.return_value = list(scalars or [])
    return res


def _human(username="aaron"):
    return SimpleNamespace(id=uuid.uuid4(), username=username, participant_type=ParticipantType.HUMAN, metadata_={})


def _seat(agent_id="persephone", owner="aaron", meta=None):
    data = {"backend": "runner", "crew": True, "owner": owner}
    data.update(meta or {})
    return SimpleNamespace(
        id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
        display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=data,
    )


def _member(participant, mode=None):
    return SimpleNamespace(participant=participant, participant_id=participant.id, agent_mode=mode)


def _room(members, *, name="hub-fa65c5631810", room_type=RoomType.AGENT_HUB, parent=None, metadata=None):
    return SimpleNamespace(
        id=uuid.uuid4(), name=name, livekit_room_name=f"stable-{name}", display_name="Persephone",
        room_type=room_type, parent_room_id=parent, metadata_=metadata or {}, updated_at=NOW,
        members=members, is_archived=False,
    )


class SeatRoomRow(TestCase):
    def test_private_hub_row(self) -> None:
        aaron, persephone = _human(), _seat()
        room = _room([_member(aaron), _member(persephone, "answers_all")],
                     metadata={"seat": {"model": "claude-opus-5-5", "effort": "medium"}})
        row = G.seat_room_row(room, persephone.id).model_dump(mode="json")
        self.assertEqual(row["id"], str(room.id))
        self.assertEqual((row["name"], row["livekit_room_name"], row["display_name"]),
                         ("hub-fa65c5631810", "stable-hub-fa65c5631810", "Persephone"))
        self.assertEqual(row["room_type"], "agent_hub")
        self.assertIsNone(row["parent_room_id"])
        self.assertEqual(row["room_class"], "private")
        self.assertEqual((row["humans"], row["own_seats"], row["foreign_seats"], row["guests"]), (1, 0, 0, 0))
        self.assertEqual(row["agent_mode"], "answers_all")
        self.assertEqual(row["seat"], {"model": "claude-opus-5-5", "effort": "medium"})
        self.assertEqual(row["updated_at"], NOW.isoformat().replace("+00:00", "Z"))

    def test_thread_shared_and_channel_rows(self) -> None:
        aaron, shafen, persephone, flow = _human(), _human("shafen"), _seat(), _seat("flow", "shafen")
        hub_id = uuid.uuid4()
        thread = _room([_member(aaron), _member(persephone, "when_named"), _member(flow)],
                       name="hub-fa65c5631810-t-1a2b3c4d", parent=hub_id)
        row = G.seat_room_row(thread, persephone.id).model_dump(mode="json")
        self.assertEqual(row["parent_room_id"], str(hub_id))
        self.assertEqual(row["room_class"], "shared")
        self.assertEqual((row["own_seats"], row["foreign_seats"]), (0, 1))
        self.assertEqual(row["agent_mode"], "when_named")
        self.assertEqual(row["seat"], {"model": None, "effort": None})
        channel = _room([_member(aaron), _member(shafen), _member(persephone)], name="general", room_type=RoomType.CHANNEL)
        row = G.seat_room_row(channel, persephone.id).model_dump(mode="json")
        self.assertEqual((row["room_class"], row["humans"], row["agent_mode"]), ("channel", 2, None))


class ListRooms(IsolatedAsyncioTestCase):
    async def test_no_participant_row_yet_is_an_empty_list(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=None))
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_list_rooms(principal=SimpleNamespace(agent_id="ghost"), db=db, redis=AsyncMock())
        self.assertEqual(out, [])
        self.assertEqual(db.execute.await_count, 1)

    async def test_rooms_the_seat_is_in_are_listed_with_their_facts(self) -> None:
        aaron, persephone = _human(), _seat()
        hub = _room([_member(aaron), _member(persephone, "answers_all")])
        shared = _room([_member(aaron), _member(_human("shafen")), _member(persephone)], name="crew", room_type=RoomType.GROUP_DM)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=persephone), _res(scalars=[hub, shared])])
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_list_rooms(principal=SimpleNamespace(agent_id="persephone"), db=db, redis=AsyncMock())
        self.assertEqual([(r.name, r.room_class, r.agent_mode) for r in out],
                         [("hub-fa65c5631810", "private", "answers_all"), ("crew", "shared", None)])
        sql = str(db.execute.await_args_list[1].args[0]).lower()
        self.assertIn("is_archived", sql)
        self.assertIn("room_members", sql)


class ContextMirrorCarriesClassAndSeat(IsolatedAsyncioTestCase):
    async def test_room_class_and_seat_are_added(self) -> None:
        aaron, persephone = _human(), _seat()
        room = _room([_member(aaron), _member(persephone, "answers_all")],
                     metadata={"seat": {"model": None, "effort": "max"}})
        membership = SimpleNamespace(agent_mode="answers_all", context_depth=None)
        mid = uuid.uuid4()
        payload = {
            "room_id": room.id, "budget_tokens": 6000, "used_tokens": 1, "truncated": False,
            "watermark": mid, "summary": None,
            "entries": [{"id": mid, "ts": NOW, "sender": {"id": persephone.id, "name": "Persephone", "kind": "agent"},
                         "kind": "message", "text": "hi", "parent_id": None}],
        }
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=persephone), _res(scalar=membership)])
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch("app.services.context_builder.build_context", new=AsyncMock(return_value=payload)):
            out = await G.gateway_get_context(
                room="hub-fa65c5631810", principal=SimpleNamespace(agent_id="persephone"),
                db=db, redis=AsyncMock(), budget_tokens=6000, since=None,
            )
        self.assertEqual(out["room_class"], "private")
        self.assertEqual(out["seat"], {"model": None, "effort": "max"})
        self.assertEqual(out["agent_mode"], "answers_all")
        self.assertEqual(out["seat_participant_id"], str(persephone.id))


class SeatCapabilitiesValidation(TestCase):
    def test_a_good_announcement_is_normalised(self) -> None:
        body = G.SeatCapabilitiesBody(
            harness="claude-code", default_model="claude-fable-5-1", default_effort="high",
            models=[{"id": "claude-fable-5-1", "label": "Fable 5.1"}, {"id": "claude-opus-5-5"}, {"id": "claude-fable-5-1"}],
            efforts=["low", "high", "high", "max"],
        )
        self.assertEqual(
            body.model_dump(),
            {
                "harness": "claude-code", "default_model": "claude-fable-5-1", "default_effort": "high",
                "models": [{"id": "claude-fable-5-1", "label": "Fable 5.1"}, {"id": "claude-opus-5-5", "label": "claude-opus-5-5"}],
                "efforts": ["low", "high", "max"],
            },
        )
        minimal = G.SeatCapabilitiesBody(harness="codex")
        self.assertEqual((minimal.models, minimal.efforts), ([], ["low", "medium", "high", "max"]))

    def test_bad_announcements_are_refused(self) -> None:
        bad = [
            dict(harness="Claude Code"),
            dict(harness="x" * 41),
            dict(harness="claude-code", default_model="Claude-Fable"),
            dict(harness="claude-code", default_effort="ultra"),
            dict(harness="claude-code", efforts=["low", "turbo"]),
            dict(harness="claude-code", models=[{"id": "has space"}]),
            dict(harness="claude-code", models=[{"id": f"m{i}"} for i in range(25)]),
        ]
        for kwargs in bad:
            with self.assertRaises(ValidationError, msg=repr(kwargs)):
                G.SeatCapabilitiesBody(**kwargs)


class PutMe(IsolatedAsyncioTestCase):
    def _body(self):
        return G.SeatCapabilitiesBody(
            harness="claude-code", default_model="claude-fable-5-1", default_effort="high",
            models=[{"id": "claude-fable-5-1", "label": "Fable 5.1"}], efforts=["low", "medium", "high", "max"],
        )

    async def test_stored_under_seat_capabilities_without_clobbering(self) -> None:
        seat = _seat(meta={"avatar_emoji": "🌸"})
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=seat))
        db.commit = AsyncMock()
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_put_me(
                body=self._body(), principal=SimpleNamespace(agent_id="persephone"), db=db, redis=AsyncMock()
            )
        self.assertEqual(out["harness"], "claude-code")
        self.assertEqual(out["models"], [{"id": "claude-fable-5-1", "label": "Fable 5.1"}])
        self.assertIn("updated_at", out)
        self.assertEqual(seat.metadata_["seat_capabilities"], out)
        for key, value in {"backend": "runner", "crew": True, "owner": "aaron", "avatar_emoji": "🌸"}.items():
            self.assertEqual(seat.metadata_[key], value)
        db.commit.assert_awaited_once()

    async def test_a_seat_with_no_participant_row_gets_one(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=None))
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_put_me(
                body=self._body(), principal=SimpleNamespace(agent_id="grok"), db=db, redis=AsyncMock()
            )
        created = db.add.call_args.args[0]
        self.assertEqual(created.keycloak_sub, "brigade:grok")
        self.assertEqual(created.username, "agent-grok")
        self.assertEqual(created.metadata_["backend"], "runner")
        self.assertEqual(created.metadata_["seat_capabilities"], out)
        self.assertEqual(db.commit.await_count, 2)
