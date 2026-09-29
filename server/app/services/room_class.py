"""Room class + seat settings (Stable Nav v3, design §2.0 / §2.3 / C1 / C2).

Five kinds of agent live in Stable (design §2.0): Brigade agents, OUR seats
(runners on our computers, ``metadata.owner = <human username>``), OTHER
users' seats, guest agents (``metadata.kind = guest_agent``) and integrations
(``metadata.kind = integration``). **Ownership decides privacy.** A runner
seat decides its hands and its reply policy from a room class the server
computes, not from a YAML list:

  ``private``  exactly one human member (never a guest), and every agent
               member is either Brigade-backed or a runner seat OWNED by
               that human. A hub, a thread under it, a 1:1 DM with your own
               seats and house agents in it.
  ``shared``   anything else: two or more humans, a guest human, a guest
               agent, or a runner seat owned by someone else (or by nobody).
  ``channel``  ``room_type = channel``

Everything here is pure over the room's loaded members so the same rule
serves the gateway room list, the context mirror, the seat-settings PATCH
and the unit tests.

``metadata.seat = {model, effort}`` is the per-conversation brain (design
§2.4); :func:`validate_seat_setting` is its one shape check.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

from app.models.participant import ParticipantType
from app.services.agent_routing import participant_backend

ROOM_CLASS_PRIVATE = "private"
ROOM_CLASS_SHARED = "shared"
ROOM_CLASS_CHANNEL = "channel"
ROOM_CLASSES: tuple[str, ...] = (ROOM_CLASS_PRIVATE, ROOM_CLASS_SHARED, ROOM_CLASS_CHANNEL)

#: participants.metadata keys this module reads.
OWNER_KEY = "owner"
KIND_KEY = "kind"
GUEST_AGENT_KIND = "guest_agent"
INTEGRATION_KIND = "integration"

#: Thinking-effort levels a seat accepts (design §2.4).
SEAT_EFFORTS: tuple[str, ...] = ("low", "medium", "high", "max")
#: Model ids as the runner passes them on ``--model``.
SEAT_MODEL_RE = re.compile(r"^[a-z0-9][a-z0-9.:_/-]{0,80}$")
#: Room-metadata key carrying the seat setting.
SEAT_METADATA_KEY = "seat"


@dataclass(frozen=True)
class RoomClassFacts:
    """What the classifier saw — reported on ``GET /gateway/rooms`` and the
    context mirror (C1), gated on by the seat-settings PATCH (C2)."""

    room_class: str
    #: HUMAN members (guests are a third kind and are not counted here).
    humans: int
    #: OTHER runner seats owned by a human in the room (the asking seat is
    #: never counted). In a one-human room: seats owned by that human.
    own_seats: int
    #: OTHER runner seats owned by someone not in the room, or by nobody.
    foreign_seats: int
    #: Guest humans + guest agents. Any of them makes the room ``shared``.
    guests: int
    #: Every runner-backed agent member, the asking seat included — C2's
    #: 409 fires when this is zero.
    runner_seats: int


def _value(enum_or_str: Any) -> str:
    return str(getattr(enum_or_str, "value", enum_or_str) or "")


def _meta(participant: Any) -> dict[str, Any]:
    meta = getattr(participant, "metadata_", None)
    return meta if isinstance(meta, dict) else {}


def _norm(name: Any) -> str | None:
    if not isinstance(name, str):
        return None
    cleaned = name.strip().lower()
    return cleaned or None


def participant_kind(participant: Any) -> str | None:
    """``metadata.kind`` (``guest_agent`` / ``integration``) or None."""
    kind = _meta(participant).get(KIND_KEY)
    return kind if isinstance(kind, str) and kind else None


def seat_owner(participant: Any) -> str | None:
    """The username that owns a runner seat (``metadata.owner``), normalised."""
    return _norm(_meta(participant).get(OWNER_KEY))


def is_runner_seat(participant: Any) -> bool:
    """A runner-backed AGENT participant (``metadata.backend = runner``)."""
    return (
        _value(getattr(participant, "participant_type", None)) == ParticipantType.AGENT.value
        and participant_backend(participant) == "runner"
    )


def classify_room(room_type: Any, humans: int, foreign_seats: int, guests: int) -> str:
    """The §2.3 rule over counts, pure. ``foreign_seats`` here is every
    runner seat NOT owned by the room's single human (the asking seat
    included — its own ownership counts too); ``guests`` is guest humans
    plus guest agents."""
    if _value(room_type) == "channel":
        return ROOM_CLASS_CHANNEL
    if humans == 1 and foreign_seats == 0 and guests == 0:
        return ROOM_CLASS_PRIVATE
    return ROOM_CLASS_SHARED


def room_class_facts(
    room_type: Any,
    members: Iterable[Any],
    *,
    seat_participant_id: Any = None,
) -> RoomClassFacts:
    """Classify from the room's member rows (each with a ``.participant``).

    ``seat_participant_id`` names the seat asking; it is left out of the
    ``own_seats`` / ``foreign_seats`` counts but still decides the class
    (a seat Shafen owns, alone with Aaron, makes that room ``shared`` for
    that seat). Without one (the human-side PATCH) every seat is counted.
    """
    human_names: list[str | None] = []
    guests = 0
    runner: list[tuple[Any, str | None]] = []
    for member in members:
        participant = getattr(member, "participant", None)
        if participant is None:
            continue
        ptype = _value(getattr(participant, "participant_type", None))
        if ptype == ParticipantType.HUMAN.value:
            human_names.append(_norm(getattr(participant, "username", None)))
        elif ptype == ParticipantType.GUEST.value:
            guests += 1
        elif ptype == ParticipantType.AGENT.value:
            if participant_kind(participant) == GUEST_AGENT_KIND:
                guests += 1
            elif participant_backend(participant) == "runner":
                runner.append((getattr(participant, "id", None), seat_owner(participant)))
            # Brigade-backed agents never affect the class.

    humans = len(human_names)
    known_owners = {name for name in human_names if name}
    single_human = human_names[0] if humans == 1 else None
    foreign_for_class = sum(
        1
        for _pid, owner in runner
        if single_human is None or owner is None or owner != single_human
    )
    others = [
        (pid, owner)
        for pid, owner in runner
        if seat_participant_id is None or pid is None or str(pid) != str(seat_participant_id)
    ]
    own_seats = sum(1 for _pid, owner in others if owner is not None and owner in known_owners)
    return RoomClassFacts(
        room_class=classify_room(room_type, humans, foreign_for_class, guests),
        humans=humans,
        own_seats=own_seats,
        foreign_seats=len(others) - own_seats,
        guests=guests,
        runner_seats=len(runner),
    )


def room_class_for(room: Any, *, seat_participant_id: Any = None) -> RoomClassFacts:
    """:func:`room_class_facts` over ``room.members`` (selectin-loaded)."""
    return room_class_facts(
        getattr(room, "room_type", None),
        getattr(room, "members", None) or [],
        seat_participant_id=seat_participant_id,
    )


def seat_setting_from_metadata(metadata: Any) -> dict[str, str | None]:
    """The stored ``metadata.seat`` normalised to ``{model, effort}`` with
    nulls when absent or malformed — what C1 hands the runner."""
    meta = metadata if isinstance(metadata, dict) else {}
    raw = meta.get(SEAT_METADATA_KEY)
    raw = raw if isinstance(raw, dict) else {}
    model = raw.get("model")
    effort = raw.get("effort")
    return {
        "model": model if isinstance(model, str) and SEAT_MODEL_RE.match(model) else None,
        "effort": effort if isinstance(effort, str) and effort in SEAT_EFFORTS else None,
    }


class SeatSettingError(ValueError):
    """A client sent a ``seat`` that is not ``{model: str|null, effort: enum|null}``."""


def validate_seat_setting(value: Any) -> dict[str, str | None]:
    """Validate a client-supplied ``seat`` (C2) → the normalised dict to store.

    ``null`` / ``{}`` mean "back to the seat's defaults" (both fields null).
    Unknown keys, a non-object, a model outside :data:`SEAT_MODEL_RE` or an
    effort outside :data:`SEAT_EFFORTS` raise :class:`SeatSettingError`.
    """
    if value is None:
        return {"model": None, "effort": None}
    if not isinstance(value, dict):
        raise SeatSettingError("seat must be an object {model, effort}")
    unknown = set(value) - {"model", "effort"}
    if unknown:
        raise SeatSettingError(f"seat has unknown keys: {', '.join(sorted(unknown))}")
    model = value.get("model")
    effort = value.get("effort")
    if model is not None:
        if not isinstance(model, str) or not SEAT_MODEL_RE.match(model):
            raise SeatSettingError(
                "seat.model must be null or match ^[a-z0-9][a-z0-9.:_/-]{0,80}$"
            )
    if effort is not None:
        if not isinstance(effort, str) or effort not in SEAT_EFFORTS:
            raise SeatSettingError(
                f"seat.effort must be null or one of {', '.join(SEAT_EFFORTS)}"
            )
    return {"model": model, "effort": effort}


__all__ = [
    "GUEST_AGENT_KIND",
    "INTEGRATION_KIND",
    "KIND_KEY",
    "OWNER_KEY",
    "ROOM_CLASSES",
    "ROOM_CLASS_CHANNEL",
    "ROOM_CLASS_PRIVATE",
    "ROOM_CLASS_SHARED",
    "SEAT_EFFORTS",
    "SEAT_METADATA_KEY",
    "SEAT_MODEL_RE",
    "RoomClassFacts",
    "SeatSettingError",
    "classify_room",
    "is_runner_seat",
    "participant_kind",
    "room_class_facts",
    "room_class_for",
    "seat_owner",
    "seat_setting_from_metadata",
    "validate_seat_setting",
]
