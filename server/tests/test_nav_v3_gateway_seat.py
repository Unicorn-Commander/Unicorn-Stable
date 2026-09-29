"""Nav v3 C1 — the gateway's seat surface.

* ``GET /gateway/rooms``: the rooms the key's seat is a member of AND may
  read, with room_class (R2), humans / own_seats / foreign_seats /
  foreign_actors / guests, the seat's own agent_mode and its ``seat`` entry;
* ``GET /gateway/rooms/{room}/context`` gains ``room_class`` and ``seat``;
* ``PUT /gateway/me``: validated capabilities merged into the seat
  participant's ``metadata.seat_capabilities`` by an SQL ``||``.
The history / scope / floor rules are pinned in tests/test_nav_v3_fix_lane.py.
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
from app.services import room_class as RC

NOW = datetime(2026, 9, 28, 22, 0, tzinfo=timezone.utc)


def _res(*, scalar=None, scalars=None, rows=None):
    res = MagicMock()
    res.scalar_one_or_none.return_value = scalar
    res.scalars.return_value.all.return_value = list(scalars or [])
    res.all.return_value = list(rows or [])
    res.rowcount = 1
    return res


def _human(username="aaron"):
    return SimpleNamespace(id=uuid.uuid4(), username=username, keycloak_sub=f"kc-{username}", participant_type=ParticipantType.HUMAN, metadata_={}, display_name=username.title())


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


def _facts(room, seat):
    return RC.room_class_for(room, key_agent_ids={"persephone", "flow"}, asking_seat=seat)


class SeatRoomRow(TestCase):
    def test_private_hub_row(self) -> None:
        aaron, persephone = _human(), _seat()
        room = _room([_member(aaron), _member(persephone, "answers_all")],
                     metadata={"seats": {"persephone": {"model": "claude-opus-5-5", "effort": "medium"}, "flow": {"effort": "low"}}})
        row = G.seat_room_row(room, persephone.id, _facts(room, persephone), "persephone").model_dump(mode="json")
        self.assertEqual(row["id"], str(room.id))
        self.assertEqual((row["name"], row["livekit_room_name"], row["display_name"]),
                         ("hub-fa65c5631810", "stable-hub-fa65c5631810", "Persephone"))
        self.assertEqual(row["room_type"], "agent_hub")
        self.assertIsNone(row["parent_room_id"])
        self.assertEqual(row["room_class"], "private")
        self.assertEqual(row["class_reasons"], [])
        self.assertEqual((row["humans"], row["own_seats"], row["foreign_seats"], row["foreign_actors"], row["guests"]), (1, 0, 0, 0, 0))
        self.assertEqual(row["agent_mode"], "answers_all")
        self.assertEqual(row["seat"], {"model": "claude-opus-5-5", "effort": "medium"})  # its OWN entry
        self.assertEqual(row["updated_at"], NOW.isoformat().replace("+00:00", "Z"))

    def test_thread_shared_and_channel_rows(self) -> None:
        aaron, shafen, persephone, flow = _human(), _human("shafenkhan"), _seat(), _seat("flow", "shafen")
        hub_id = uuid.uuid4()
        thread = _room([_member(aaron), _member(persephone, "when_named"), _member(flow)],
                       name="hub-fa65c5631810-t-1a2b3c4d", parent=hub_id)
        row = G.seat_room_row(thread, persephone.id, _facts(thread, persephone), "persephone").model_dump(mode="json")
        self.assertEqual(row["parent_room_id"], str(hub_id))
        self.assertEqual(row["room_class"], "shared")
        self.assertIn("foreign_seat", row["class_reasons"])
        self.assertEqual((row["own_seats"], row["foreign_seats"]), (0, 1))
        self.assertEqual(row["agent_mode"], "when_named")
        self.assertEqual(row["seat"], {"model": None, "effort": None})
        channel = _room([_member(aaron), _member(shafen), _member(persephone)], name="general", room_type=RoomType.CHANNEL)
        row = G.seat_room_row(channel, persephone.id, _facts(channel, persephone), "persephone").model_dump(mode="json")
        self.assertEqual((row["room_class"], row["humans"], row["agent_mode"]), ("channel", 2, None))


class ListRooms(IsolatedAsyncioTestCase):
    async def test_no_participant_row_yet_is_an_empty_list(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=None))
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_list_rooms(principal=SimpleNamespace(agent_id="ghost", allowed_rooms=["@member"]), db=db, redis=AsyncMock())
        self.assertEqual(out, [])
        self.assertEqual(db.execute.await_count, 1)

    async def test_rooms_the_seat_may_read_are_listed_with_their_facts(self) -> None:
        aaron, shafen, persephone = _human(), _human("shafenkhan"), _seat()
        hub_id, shared_id = uuid.uuid4(), uuid.uuid4()

        def room_row(rid, name, rtype):
            return (rid, name, f"stable-{name}", name.title(), rtype, None, {}, NOW, False)

        def member_row(rid, p, mode=None):
            return (rid, p.id, mode, p.id, p.participant_type, p.username, getattr(p, "keycloak_sub", None), p.display_name, p.metadata_)

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            _res(scalar=persephone),                                            # seat
            _res(rows=[room_row(hub_id, "hub-fa65c5631810", RoomType.AGENT_HUB), room_row(shared_id, "crew", RoomType.GROUP_DM)]),
            _res(scalars=[hub_id, shared_id]),                                  # owner present in both
            _res(rows=[member_row(hub_id, aaron), member_row(hub_id, persephone, "answers_all"),
                       member_row(shared_id, aaron), member_row(shared_id, shafen), member_row(shared_id, persephone)]),
            _res(scalars=["persephone"]),                                       # key agent ids
            _res(rows=[(hub_id, [aaron.id, persephone.id]), (shared_id, [aaron.id, shafen.id])]),  # history
            _res(rows=[]),                                                      # no unknown senders
            _res(),                                                             # floor stamp (shared room)
        ])
        db.commit = AsyncMock()
        principal = SimpleNamespace(agent_id="persephone", allowed_rooms=["@member"], auth_kind="key", human_sub=None)
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_list_rooms(principal=principal, db=db, redis=AsyncMock())
        self.assertEqual([(r.name, r.room_class, r.agent_mode) for r in out],
                         [("hub-fa65c5631810", "private", "answers_all"), ("crew", "shared", None)])
        db.commit.assert_awaited_once()
        rooms_sql = str(db.execute.await_args_list[1].args[0]).lower()
        self.assertIn("rooms.is_archived is false", rooms_sql)
        self.assertIn("room_members.participant_id", rooms_sql)
        self.assertNotIn("agent_configs", rooms_sql)


class ContextMirrorCarriesClassAndSeat(IsolatedAsyncioTestCase):
    async def test_room_class_and_seat_are_added(self) -> None:
        aaron, persephone = _human(), _seat()
        room = _room([_member(aaron), _member(persephone, "answers_all")],
                     metadata={"seats": {"persephone": {"model": None, "effort": "max"}}})
        membership = SimpleNamespace(agent_mode="answers_all", context_depth=None)
        mid = uuid.uuid4()
        payload = {
            "room_id": room.id, "budget_tokens": 6000, "used_tokens": 1, "truncated": False,
            "watermark": mid, "summary": None,
            "entries": [{"id": mid, "ts": NOW, "sender": {"id": persephone.id, "name": "Persephone", "kind": "agent"},
                         "kind": "message", "text": "hi", "parent_id": None}],
        }
        facts = RC.RoomClassFacts(room_class="private", humans=1, own_seats=0, foreign_seats=0, guests=0)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar=persephone), _res(scalar=membership)])
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()), \
             patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)), \
             patch.object(G, "_enforce_scope", new=AsyncMock()), \
             patch.object(G, "_classify_for_seat", new=AsyncMock(return_value=facts)) as classify, \
             patch("app.services.context_builder.build_context", new=AsyncMock(return_value=payload)):
            out = await G.gateway_get_context(
                room="hub-fa65c5631810", principal=SimpleNamespace(agent_id="persephone"),
                db=db, redis=AsyncMock(), budget_tokens=6000, since=None,
            )
        self.assertEqual(out["room_class"], "private")
        self.assertEqual(out["class_reasons"], [])
        self.assertEqual(out["seat"], {"model": None, "effort": "max"})
        self.assertEqual(out["agent_mode"], "answers_all")
        self.assertEqual(out["seat_participant_id"], str(persephone.id))
        self.assertIs(classify.await_args.args[2], persephone)  # the asking seat is counted


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
            dict(harness="claude-code", default_model="claude-fable-5-1\n"),
            dict(harness="claude-code", default_effort="ultra"),
            dict(harness="claude-code", efforts=["low", "turbo"]),
            dict(harness="claude-code", models=[{"id": "has space"}]),
            dict(harness="claude-code", models=[{"id": "ok\n"}]),
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

    async def test_stored_under_seat_capabilities_by_merge(self) -> None:
        seat = _seat(meta={"avatar_emoji": "🌸"})
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=seat))
        db.commit = AsyncMock()
        principal = SimpleNamespace(agent_id="persephone", auth_kind="key", human_sub=None)
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_put_me(body=self._body(), principal=principal, db=db, redis=AsyncMock())
        self.assertEqual(out["harness"], "claude-code")
        self.assertEqual(out["models"], [{"id": "claude-fable-5-1", "label": "Fable 5.1"}])
        self.assertIn("updated_at", out)
        self.assertEqual(seat.metadata_["seat_capabilities"], out)
        for key, value in {"backend": "runner", "crew": True, "owner": "aaron", "avatar_emoji": "🌸"}.items():
            self.assertEqual(seat.metadata_[key], value)
        db.commit.assert_awaited_once()
        # Two statements: the lookup, then the || merge.
        self.assertEqual(db.execute.await_count, 2)
        self.assertIn("||", str(db.execute.await_args_list[1].args[0]))

    async def test_a_seat_with_no_participant_row_gets_one_owned_by_the_jwt_human(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_res(scalar="aaron"), _res(scalar=None), _res()])
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        principal = SimpleNamespace(agent_id="dev-aaron", auth_kind="jwt", human_sub="kc-aaron")
        with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
            out = await G.gateway_put_me(body=self._body(), principal=principal, db=db, redis=AsyncMock())
        created = db.add.call_args.args[0]
        self.assertEqual(created.keycloak_sub, "brigade:dev-aaron")
        self.assertEqual(created.username, "agent-dev-aaron")
        self.assertEqual(created.metadata_["backend"], "runner")
        self.assertEqual(created.metadata_["owner"], "aaron")
        self.assertEqual(created.metadata_["seat_capabilities"], out)
        self.assertEqual(db.commit.await_count, 2)
