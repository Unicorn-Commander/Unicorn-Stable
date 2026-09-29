"""Nav v3 — the room classifier (design §2.0 / §2.3, C1) and the seat
setting's shape (C2). Pure functions, no database.

Ownership decides privacy: a room is ``private`` when exactly one human is
in it and every runner seat present is that human's. Guests (human or
agent) and someone else's seat make it ``shared``; a channel is a channel.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import TestCase

from app.models.participant import ParticipantType
from app.models.room import RoomType
from app.services.room_class import (
    RoomClassFacts,
    SeatSettingError,
    classify_room,
    room_class_facts,
    room_class_for,
    seat_owner,
    seat_setting_from_metadata,
    validate_seat_setting,
)


def _human(username: str):
    return SimpleNamespace(
        id=uuid.uuid4(), username=username, participant_type=ParticipantType.HUMAN, metadata_={}
    )


def _guest():
    return SimpleNamespace(
        id=uuid.uuid4(), username="guest-1", participant_type=ParticipantType.GUEST, metadata_={}
    )


def _seat(agent_id: str, owner: str | None = "aaron", **meta):
    data = {"backend": "runner", "crew": True}
    if owner is not None:
        data["owner"] = owner
    data.update(meta)
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=f"agent-{agent_id}",
        participant_type=ParticipantType.AGENT,
        metadata_=data,
    )


def _brigade(agent_id: str, **meta):
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=f"agent-{agent_id}",
        participant_type=ParticipantType.AGENT,
        metadata_=dict(meta),
    )


def _members(*participants):
    return [SimpleNamespace(participant=p, participant_id=p.id) for p in participants]


AARON = _human("aaron")
SHAFEN = _human("Shafen")  # username case must not matter
PERSEPHONE = _seat("persephone", "aaron")
ROOK = _seat("claude-code", "aaron")
FLOW = _seat("flow", "shafen")
MAJIK = _brigade("majik")


class ClassifyRoomCounts(TestCase):
    def test_channel_wins_whatever_the_counts(self) -> None:
        self.assertEqual(classify_room(RoomType.CHANNEL, 1, 0, 0), "channel")
        self.assertEqual(classify_room("channel", 5, 3, 2), "channel")

    def test_one_human_no_foreign_seat_no_guest_is_private(self) -> None:
        self.assertEqual(classify_room(RoomType.AGENT_HUB, 1, 0, 0), "private")
        self.assertEqual(classify_room(RoomType.DM, 1, 0, 0), "private")
        self.assertEqual(classify_room(RoomType.GROUP_DM, 1, 0, 0), "private")

    def test_anything_else_is_shared(self) -> None:
        self.assertEqual(classify_room(RoomType.GROUP_DM, 2, 0, 0), "shared")
        self.assertEqual(classify_room(RoomType.AGENT_HUB, 1, 1, 0), "shared")
        self.assertEqual(classify_room(RoomType.AGENT_HUB, 1, 0, 1), "shared")
        self.assertEqual(classify_room(RoomType.DM, 0, 0, 0), "shared")


class ClassifyRoomMembers(TestCase):
    """The cases Aaron set (design §2.0), from Persephone's point of view."""

    def _facts(self, *participants, seat=PERSEPHONE, room_type=RoomType.AGENT_HUB) -> RoomClassFacts:
        return room_class_facts(
            room_type, _members(*participants), seat_participant_id=seat.id
        )

    def test_you_and_persephone_is_private(self) -> None:
        facts = self._facts(AARON, PERSEPHONE)
        self.assertEqual(facts.room_class, "private")
        self.assertEqual((facts.humans, facts.own_seats, facts.foreign_seats, facts.guests), (1, 0, 0, 0))
        self.assertEqual(facts.runner_seats, 1)

    def test_you_persephone_and_rook_both_yours_is_private(self) -> None:
        facts = self._facts(AARON, PERSEPHONE, ROOK)
        self.assertEqual(facts.room_class, "private")
        # Rook is an OWN seat from Persephone's view; she is not counted.
        self.assertEqual((facts.own_seats, facts.foreign_seats), (1, 0))
        self.assertEqual(facts.runner_seats, 2)

    def test_you_persephone_and_flow_shafens_seat_is_shared(self) -> None:
        facts = self._facts(AARON, PERSEPHONE, FLOW)
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual((facts.own_seats, facts.foreign_seats), (0, 1))

    def test_you_persephone_and_majik_brigade_is_private(self) -> None:
        facts = self._facts(AARON, PERSEPHONE, MAJIK)
        self.assertEqual(facts.room_class, "private")
        self.assertEqual((facts.own_seats, facts.foreign_seats), (0, 0))

    def test_you_shafen_and_anyone_is_shared(self) -> None:
        self.assertEqual(self._facts(AARON, SHAFEN).room_class, "shared")
        self.assertEqual(self._facts(AARON, SHAFEN, PERSEPHONE).room_class, "shared")
        self.assertEqual(self._facts(AARON, SHAFEN, MAJIK).room_class, "shared")

    def test_a_guest_agent_makes_it_shared(self) -> None:
        guest_agent = _brigade("visitor-claude", kind="guest_agent")
        facts = self._facts(AARON, PERSEPHONE, guest_agent)
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual(facts.guests, 1)

    def test_a_guest_human_makes_it_shared_and_is_not_a_human(self) -> None:
        facts = self._facts(AARON, PERSEPHONE, _guest())
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual((facts.humans, facts.guests), (1, 1))

    def test_a_seat_with_no_owner_is_foreign(self) -> None:
        orphan = _seat("orphan", owner=None)
        facts = self._facts(AARON, PERSEPHONE, orphan)
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual((facts.own_seats, facts.foreign_seats), (0, 1))

    def test_the_asking_seats_own_ownership_counts_for_the_class(self) -> None:
        # Persephone (Aaron's) alone with Shafen: one human, but the seat is
        # not his → shared, even though there is no OTHER seat to count.
        facts = self._facts(SHAFEN, PERSEPHONE)
        self.assertEqual(facts.room_class, "shared")
        self.assertEqual((facts.own_seats, facts.foreign_seats), (0, 0))
        # Flow with Shafen: his own seat → private. Owner match is
        # case-insensitive on the username.
        self.assertEqual(self._facts(SHAFEN, FLOW, seat=FLOW).room_class, "private")

    def test_channel_room_type_is_channel(self) -> None:
        self.assertEqual(self._facts(AARON, PERSEPHONE, room_type=RoomType.CHANNEL).room_class, "channel")

    def test_human_side_view_counts_every_seat(self) -> None:
        # No asking seat (the PATCH path): both seats are counted, and the
        # class is judged the same way.
        facts = room_class_facts(RoomType.AGENT_HUB, _members(AARON, PERSEPHONE, ROOK))
        self.assertEqual(facts.room_class, "private")
        self.assertEqual((facts.own_seats, facts.foreign_seats, facts.runner_seats), (2, 0, 2))
        empty = room_class_facts(RoomType.AGENT_HUB, _members(AARON, MAJIK))
        self.assertEqual(empty.room_class, "private")
        self.assertEqual(empty.runner_seats, 0)

    def test_room_class_for_reads_room_members(self) -> None:
        room = SimpleNamespace(room_type=RoomType.DM, members=_members(AARON, PERSEPHONE))
        self.assertEqual(room_class_for(room, seat_participant_id=PERSEPHONE.id).room_class, "private")
        bare = SimpleNamespace(room_type=RoomType.DM)
        self.assertEqual(room_class_for(bare).room_class, "shared")

    def test_seat_owner_is_normalised(self) -> None:
        self.assertEqual(seat_owner(_seat("x", "  Aaron ")), "aaron")
        self.assertIsNone(seat_owner(_seat("x", owner=None)))
        self.assertIsNone(seat_owner(_seat("x", owner="")))


class SeatSettingShape(TestCase):
    def test_valid_shapes_are_normalised(self) -> None:
        self.assertEqual(
            validate_seat_setting({"model": "claude-opus-5-5", "effort": "medium"}),
            {"model": "claude-opus-5-5", "effort": "medium"},
        )
        self.assertEqual(validate_seat_setting({"model": None, "effort": "max"}), {"model": None, "effort": "max"})
        self.assertEqual(validate_seat_setting({}), {"model": None, "effort": None})
        self.assertEqual(validate_seat_setting(None), {"model": None, "effort": None})

    def test_bad_effort_is_refused(self) -> None:
        with self.assertRaises(SeatSettingError):
            validate_seat_setting({"model": None, "effort": "ultra"})
        with self.assertRaises(SeatSettingError):
            validate_seat_setting({"effort": 3})

    def test_bad_model_is_refused(self) -> None:
        for bad in ("Claude-Opus", "-leading", "has space", "x" * 82, 12):
            with self.assertRaises(SeatSettingError, msg=repr(bad)):
                validate_seat_setting({"model": bad})

    def test_unknown_keys_and_non_objects_are_refused(self) -> None:
        with self.assertRaises(SeatSettingError):
            validate_seat_setting({"model": "x", "tools": "all"})
        with self.assertRaises(SeatSettingError):
            validate_seat_setting("claude-opus-5-5")

    def test_reading_metadata_degrades_to_nulls(self) -> None:
        self.assertEqual(seat_setting_from_metadata(None), {"model": None, "effort": None})
        self.assertEqual(seat_setting_from_metadata({"seat": "junk"}), {"model": None, "effort": None})
        self.assertEqual(
            seat_setting_from_metadata({"seat": {"model": "claude-fable-5-1", "effort": "silly"}}),
            {"model": "claude-fable-5-1", "effort": None},
        )
