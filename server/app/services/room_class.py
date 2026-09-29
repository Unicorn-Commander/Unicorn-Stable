"""Room class + seat settings (Stable Nav v3, design §2.0 / §2.3 / C1 / C2).

Five kinds of agent live in Stable (design §2.0): Brigade (house) agents,
OUR seats (runners on our computers, ``metadata.owner`` = the human's
username, or a list of usernames), OTHER users' seats, guest agents
(``metadata.kind = guest_agent``) and integrations (``metadata.kind =
integration``). **Ownership decides privacy**, and the class is the one
fact full shell hands depend on, so it is computed the paranoid way:

* **House is an allowlist, never a default** (R1). An agent is house only
  when its ``keycloak_sub`` starts with ``brigade:``, its ``metadata.backend``
  is absent or exactly ``brigade``, its ``metadata.kind`` is null, and no
  ``agent_gateway_keys`` row exists for its agent id. Everything else is
  foreign unless it is a runner seat owned by the room's single human. A
  webhook row (``webhook:<room>``, metadata NULL), a Project-Ops sender, a
  typo'd backend, a member whose participant failed to load: all foreign.
* **Private means every line the seat can read came from the owner, the
  owner's seats or house agents** (R2). The class is computed over the union
  of the current members, every distinct historical sender in the room
  (deleted lines included; a NULL sender is foreign), and the true author of
  a thread's seed. A thread is never more private than its parent. Once a
  room has been ``shared`` — or any member has been removed — a sticky
  ``rooms.metadata.class_floor = "shared"`` keeps it shared for good.
* **The asking seat reads a room as private only when the single human IS
  its owner** (R3); its own participant always counts.

  ``private``  one human, no guest, every runner seat (the asking one
               included) owned by that human, every other agent house,
               every historical sender one of those, no floor, parent not
               shared.
  ``shared``   anything else.
  ``channel``  ``room_type = channel``.

The pure layer (``room_class_facts``) takes plain actors so the rules have
unit tests; ``compute_room_classes`` runs the queries for a batch of rooms
(one grouped history query) and is what the gateway uses.

``metadata.seats = {"<agent_id>": {model, effort}}`` is the per-seat brain
(design §2.4, R6); :func:`validate_seats_setting` is its one shape check.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable

from sqlalchemy import cast, distinct, func, select, update
from sqlalchemy.dialects.postgresql import JSONB

from app.models.participant import ParticipantType
from app.services.agent_routing import participant_backend

ROOM_CLASS_PRIVATE = "private"
ROOM_CLASS_SHARED = "shared"
ROOM_CLASS_CHANNEL = "channel"
ROOM_CLASSES: tuple[str, ...] = (ROOM_CLASS_PRIVATE, ROOM_CLASS_SHARED, ROOM_CLASS_CHANNEL)

#: participants.metadata keys this module reads / writes.
OWNER_KEY = "owner"
KIND_KEY = "kind"
CREW_FLAG_KEY = "crew"
SEAT_CAPABILITIES_KEY = "seat_capabilities"
GUEST_AGENT_KIND = "guest_agent"
INTEGRATION_KIND = "integration"
#: ``metadata.kind`` values that are foreign everywhere and on nobody's crew.
EXCLUDED_KINDS: frozenset[str] = frozenset({GUEST_AGENT_KIND, INTEGRATION_KIND})

#: rooms.metadata keys.
CLASS_FLOOR_KEY = "class_floor"
SEATS_METADATA_KEY = "seats"
THREAD_META_KEY = "thread"

#: Thinking-effort levels a seat accepts (design §2.4).
SEAT_EFFORTS: tuple[str, ...] = ("low", "medium", "high", "max")
#: Model ids as the runner passes them on ``--model`` (fullmatch, so no
#: trailing newline slips through the way ``$`` would let it).
SEAT_MODEL_RE = re.compile(r"[a-z0-9][a-z0-9.:_/-]{0,80}")
#: Agent ids as keys of ``metadata.seats``.
AGENT_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
BRIGADE_SUB_PREFIX = "brigade:"


@dataclass(frozen=True)
class RoomClassFacts:
    """What the classifier saw — reported on ``GET /gateway/rooms`` and the
    context / messages envelopes (C1), gated on by the seat-settings PATCH
    (C2). Counts are over the UNION the class was judged on (current
    members plus historical senders), so a ``shared`` verdict always has a
    visible reason."""

    room_class: str
    #: HUMAN actors (guests are a third kind and are not counted here).
    humans: int
    #: OTHER runner seats owned by a human in the room (the asking seat is
    #: never counted).
    own_seats: int
    #: OTHER runner seats owned by someone not in the room, or by nobody.
    foreign_seats: int
    #: Guest humans + guest agents. Any of them makes the room ``shared``.
    guests: int
    #: Foreign non-seat actors: integrations, webhook / Project-Ops senders,
    #: unknown backends, NULL senders, members that failed to load.
    foreign_actors: int = 0
    #: Every runner-backed agent member (asking seat included) — C2's 409
    #: fires when this is zero.
    runner_seats: int = 0
    #: The sticky floor that applied (``"shared"``) or None.
    floor: str | None = None
    #: Why the verdict is ``shared`` (short tags, for logs / the runner).
    reasons: tuple[str, ...] = ()


@dataclass
class Actor:
    """A participant reduced to the columns the classifier reads. Built
    from column selects so no relationship (memberships, agent_config)
    is loaded along the way."""

    id: Any
    participant_type: Any
    username: str | None = None
    keycloak_sub: str | None = None
    display_name: str | None = None
    metadata_: dict | None = None
    avatar_url: str | None = None


def _value(enum_or_str: Any) -> str:
    return str(getattr(enum_or_str, "value", enum_or_str) or "")


def _meta(participant: Any) -> dict[str, Any]:
    meta = getattr(participant, "metadata_", None)
    return meta if isinstance(meta, dict) else {}


def norm_username(name: Any) -> str | None:
    """Usernames compare case-insensitively and trimmed, everywhere."""
    if not isinstance(name, str):
        return None
    cleaned = name.strip().lower()
    return cleaned or None


def participant_kind(participant: Any) -> str | None:
    """``metadata.kind`` (``guest_agent`` / ``integration``) or None."""
    kind = _meta(participant).get(KIND_KEY)
    return kind if isinstance(kind, str) and kind else None


def is_excluded_kind_participant(participant: Any) -> bool:
    """Guest agents and integrations: foreign everywhere, on nobody's crew."""
    return participant_kind(participant) in EXCLUDED_KINDS


def seat_owners(participant: Any) -> frozenset[str]:
    """The usernames that own a seat (``metadata.owner``: a string or a list
    — Shafen has rows ``shafen`` and ``shafenkhan``), normalised."""
    raw = _meta(participant).get(OWNER_KEY)
    values = raw if isinstance(raw, (list, tuple)) else [raw]
    return frozenset(name for name in (norm_username(v) for v in values) if name)


def seat_owner(participant: Any) -> str | None:
    """First owner (for display); use :func:`seat_owners` to authorise."""
    owners = sorted(seat_owners(participant))
    return owners[0] if owners else None


def agent_id_of_sub(sub: Any) -> str | None:
    if isinstance(sub, str) and sub.startswith(BRIGADE_SUB_PREFIX):
        return sub[len(BRIGADE_SUB_PREFIX) :] or None
    return None


def _is_agent(participant: Any) -> bool:
    return _value(getattr(participant, "participant_type", None)) == ParticipantType.AGENT.value


def is_runner_seat(participant: Any) -> bool:
    """A runner-backed AGENT participant (``metadata.backend = runner``) that
    is not an integration / guest agent."""
    return (
        _is_agent(participant)
        and participant_backend(participant) == "runner"
        and participant_kind(participant) not in EXCLUDED_KINDS
    )


def is_house_agent(participant: Any, key_agent_ids: Iterable[str]) -> bool:
    """R1 — the house allowlist. ``key_agent_ids`` is every agent id that has
    ANY ``agent_gateway_keys`` row (revoked or not): a key-holder is an
    external process, whatever its participant row says."""
    if not _is_agent(participant):
        return False
    agent_id = agent_id_of_sub(getattr(participant, "keycloak_sub", None))
    if agent_id is None:
        return False
    meta = _meta(participant)
    backend = meta.get("backend")
    if backend is not None and backend != "brigade":
        return False
    if participant_kind(participant) is not None:
        return False
    return agent_id not in set(key_agent_ids)


def classify_room(
    room_type: Any,
    humans: int,
    foreign: int,
    guests: int,
    *,
    floor: str | None = None,
    parent_class: str | None = None,
) -> str:
    """The rule over counts, pure. ``foreign`` is every foreign runner seat
    (the asking seat included — its own ownership counts) plus every other
    foreign actor; ``guests`` is guest humans plus guest agents."""
    if _value(room_type) == "channel":
        return ROOM_CLASS_CHANNEL
    if floor == ROOM_CLASS_SHARED or parent_class == ROOM_CLASS_SHARED:
        return ROOM_CLASS_SHARED
    if humans == 1 and foreign == 0 and guests == 0:
        return ROOM_CLASS_PRIVATE
    return ROOM_CLASS_SHARED


def room_class_facts(
    room_type: Any,
    members: Iterable[Any],
    *,
    key_agent_ids: Iterable[str] = (),
    asking_seat: Any = None,
    historical: Iterable[Any] = (),
    has_seed: bool = False,
    seed_sender: Any = None,
    parent_class: str | None = None,
    floor: str | None = None,
) -> RoomClassFacts:
    """Classify from member rows (each with a ``.participant``, None when it
    failed to load), the historical senders (participants, None for a NULL
    sender), the thread seed's true author (``has_seed`` with a None
    ``seed_sender`` is foreign) and the asking seat's own participant, which
    always counts (R3) but is left out of the OTHER-seat counts."""
    key_ids = set(key_agent_ids)
    actors: list[Any] = []
    for member in members:
        actors.append(getattr(member, "participant", None))
    actors.extend(historical)
    if has_seed:
        actors.append(seed_sender)
    if asking_seat is not None:
        actors.append(asking_seat)

    # De-duplicate by participant id; actors without an id (None) each count.
    seen: set[str] = set()
    unique: list[Any] = []
    for actor in actors:
        pid = getattr(actor, "id", None) if actor is not None else None
        if pid is not None:
            key = str(pid)
            if key in seen:
                continue
            seen.add(key)
        unique.append(actor)

    asking_id = str(getattr(asking_seat, "id", "")) if asking_seat is not None else None
    human_names: list[str | None] = []
    guests = 0
    seats: list[tuple[str | None, frozenset[str]]] = []  # (pid, owners)
    foreign_actors = 0
    reasons: list[str] = []
    for actor in unique:
        if actor is None:
            foreign_actors += 1
            reasons.append("unattributed_actor")
            continue
        ptype = _value(getattr(actor, "participant_type", None))
        if ptype == ParticipantType.HUMAN.value:
            human_names.append(norm_username(getattr(actor, "username", None)))
        elif ptype == ParticipantType.GUEST.value:
            guests += 1
            reasons.append("guest_human")
        elif ptype == ParticipantType.AGENT.value:
            if participant_kind(actor) == GUEST_AGENT_KIND:
                guests += 1
                reasons.append("guest_agent")
            elif is_runner_seat(actor):
                pid = getattr(actor, "id", None)
                seats.append((str(pid) if pid is not None else None, seat_owners(actor)))
            elif is_house_agent(actor, key_ids):
                continue
            else:
                foreign_actors += 1
                reasons.append(
                    "integration" if participant_kind(actor) == INTEGRATION_KIND else "foreign_agent"
                )
        else:
            foreign_actors += 1
            reasons.append("unknown_participant_type")

    humans = len(human_names)
    known_owners = {name for name in human_names if name}
    single_human = human_names[0] if humans == 1 else None
    foreign_for_class = sum(
        1 for _pid, owners in seats if single_human is None or single_human not in owners
    )
    others = [(pid, owners) for pid, owners in seats if asking_id is None or pid != asking_id]
    own_seats = sum(1 for _pid, owners in others if owners & known_owners)
    foreign_seats = len(others) - own_seats
    if foreign_for_class:
        reasons.append("foreign_seat")
    if humans != 1:
        reasons.append("humans_%d" % humans)
    if floor == ROOM_CLASS_SHARED:
        reasons.append("floor")
    if parent_class == ROOM_CLASS_SHARED:
        reasons.append("parent_shared")

    room_class = classify_room(
        room_type,
        humans,
        foreign_for_class + foreign_actors,
        guests,
        floor=floor,
        parent_class=parent_class,
    )
    return RoomClassFacts(
        room_class=room_class,
        humans=humans,
        own_seats=own_seats,
        foreign_seats=foreign_seats,
        guests=guests,
        foreign_actors=foreign_actors,
        runner_seats=len(seats),
        floor=floor,
        reasons=tuple(dict.fromkeys(reasons)) if room_class == ROOM_CLASS_SHARED else (),
    )


def class_floor_of(metadata: Any) -> str | None:
    meta = metadata if isinstance(metadata, dict) else {}
    floor = meta.get(CLASS_FLOOR_KEY)
    return ROOM_CLASS_SHARED if floor == ROOM_CLASS_SHARED else None


def thread_seed_of(metadata: Any) -> tuple[bool, str | None]:
    """``(has_seed, seed_sender_id)`` from ``rooms.metadata.thread``. A seed
    with no recorded author (threads made before R2, or a NULL sender) is
    ``(True, None)`` — foreign, fail closed."""
    meta = metadata if isinstance(metadata, dict) else {}
    thread = meta.get(THREAD_META_KEY)
    thread = thread if isinstance(thread, dict) else {}
    if not thread.get("seed_message_id"):
        return False, None
    sender = thread.get("seed_sender_id")
    return True, (sender if isinstance(sender, str) and sender else None)


def room_class_for(
    room: Any,
    *,
    key_agent_ids: Iterable[str] = (),
    asking_seat: Any = None,
    historical: Iterable[Any] = (),
    seed_sender: Any = None,
    parent_class: str | None = None,
) -> RoomClassFacts:
    """:func:`room_class_facts` over a loaded room (``members``, ``metadata_``).
    The seed's presence comes from the room's metadata; the caller supplies
    the seed sender it loaded (None → foreign)."""
    has_seed, _seed_id = thread_seed_of(getattr(room, "metadata_", None))
    return room_class_facts(
        getattr(room, "room_type", None),
        getattr(room, "members", None) or [],
        key_agent_ids=key_agent_ids,
        asking_seat=asking_seat,
        historical=historical,
        has_seed=has_seed,
        seed_sender=seed_sender,
        parent_class=parent_class,
        floor=class_floor_of(getattr(room, "metadata_", None)),
    )


# ---------------------------------------------------------------------------
# Queries: key holders, history, actors, floors
# ---------------------------------------------------------------------------


async def load_key_agent_ids(db: Any) -> set[str]:
    """Every agent id with ANY gateway key row (revoked or not) — R1's
    "no agent_gateway_keys row exists"."""
    from app.models.agent_gateway_key import AgentGatewayKey

    rows = (await db.execute(select(AgentGatewayKey.agent_id).distinct())).scalars().all()
    return {str(agent_id) for agent_id in rows if agent_id}


async def load_room_history(db: Any, room_ids: Iterable[Any]) -> dict[str, list[Any]]:
    """``{room_id: [distinct sender ids, None for NULL]}`` — one grouped
    query (``array_agg(DISTINCT sender_id)``), deleted lines included."""
    from app.models.message import Message

    ids = list(room_ids)
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(Message.room_id, func.array_agg(distinct(Message.sender_id)))
            .where(Message.room_id.in_(ids))
            .group_by(Message.room_id)
        )
    ).all()
    return {str(room_id): list(senders or []) for room_id, senders in rows}


def _actor_from_columns(row: Any) -> Actor:
    return Actor(
        id=row[0],
        participant_type=row[1],
        username=row[2],
        keycloak_sub=row[3],
        display_name=row[4],
        metadata_=row[5] if isinstance(row[5], dict) else None,
        avatar_url=row[6] if len(row) > 6 else None,
    )


async def load_actors(db: Any, participant_ids: Iterable[Any]) -> dict[str, Actor]:
    """Participants by id as lightweight :class:`Actor` rows — a column
    select, so nothing eager (memberships, agent_config) rides along."""
    from app.models.participant import Participant

    ids = [pid for pid in participant_ids if pid is not None]
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(
                Participant.id,
                Participant.participant_type,
                Participant.username,
                Participant.keycloak_sub,
                Participant.display_name,
                Participant.metadata_,
                Participant.avatar_url,
            ).where(Participant.id.in_(ids))
        )
    ).all()
    return {str(row[0]): _actor_from_columns(row) for row in rows}


@dataclass
class RoomLite:
    """A room reduced to what the classifier and the gateway row need."""

    id: Any
    name: str = ""
    livekit_room_name: str = ""
    display_name: str = ""
    room_type: Any = None
    parent_room_id: Any = None
    metadata_: dict | None = None
    updated_at: Any = None
    is_archived: bool = False
    members: list[Any] = field(default_factory=list)


@dataclass
class MemberLite:
    participant_id: Any
    participant: Any
    agent_mode: str | None = None


async def load_members(db: Any, room_ids: Iterable[Any]) -> dict[str, list[MemberLite]]:
    """``{room_id: [MemberLite]}`` by column select (participant columns
    joined in; a membership whose participant is gone yields ``participant
    = None`` → foreign)."""
    from app.models.participant import Participant
    from app.models.room import RoomMember

    ids = list(room_ids)
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(
                RoomMember.room_id,
                RoomMember.participant_id,
                RoomMember.agent_mode,
                Participant.id,
                Participant.participant_type,
                Participant.username,
                Participant.keycloak_sub,
                Participant.display_name,
                Participant.metadata_,
            )
            .outerjoin(Participant, Participant.id == RoomMember.participant_id)
            .where(RoomMember.room_id.in_(ids))
        )
    ).all()
    out: dict[str, list[MemberLite]] = {}
    for row in rows:
        room_id, participant_id, agent_mode = row[0], row[1], row[2]
        actor = _actor_from_columns(row[3:9]) if row[3] is not None else None
        out.setdefault(str(room_id), []).append(
            MemberLite(participant_id=participant_id, participant=actor, agent_mode=agent_mode)
        )
    return out


async def load_rooms_lite(db: Any, room_ids: Iterable[Any]) -> dict[str, RoomLite]:
    """Rooms by id as :class:`RoomLite` (column select, members attached)."""
    from app.models.room import Room

    ids = list(room_ids)
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(
                Room.id,
                Room.name,
                Room.livekit_room_name,
                Room.display_name,
                Room.room_type,
                Room.parent_room_id,
                Room.metadata_,
                Room.updated_at,
                Room.is_archived,
            ).where(Room.id.in_(ids))
        )
    ).all()
    rooms = {
        str(row[0]): RoomLite(
            id=row[0],
            name=row[1],
            livekit_room_name=row[2],
            display_name=row[3],
            room_type=row[4],
            parent_room_id=row[5],
            metadata_=row[6] if isinstance(row[6], dict) else None,
            updated_at=row[7],
            is_archived=bool(row[8]),
        )
        for row in rows
    }
    members = await load_members(db, [room.id for room in rooms.values()])
    for key, room in rooms.items():
        room.members = members.get(key, [])
    return rooms


async def compute_room_classes(
    db: Any,
    rooms: Iterable[Any],
    *,
    asking_seat: Any = None,
    key_agent_ids: Iterable[str] | None = None,
) -> dict[str, RoomClassFacts]:
    """Classify a batch of rooms (objects with ``id``, ``room_type``,
    ``parent_room_id``, ``metadata_`` and ``members`` — ORM rooms or
    :class:`RoomLite`) the R2 way: history, seeds, parents, floors. Parents
    missing from the batch are loaded. Returns ``{room_id: facts}``; the
    caller decides whether to write floors (:func:`apply_class_floors`)."""
    room_list = list(rooms)
    by_id: dict[str, Any] = {str(room.id): room for room in room_list}
    parent_ids = {
        room.parent_room_id
        for room in room_list
        if getattr(room, "parent_room_id", None) is not None
        and str(room.parent_room_id) not in by_id
    }
    if parent_ids:
        by_id.update(await load_rooms_lite(db, parent_ids))
    keys = set(key_agent_ids) if key_agent_ids is not None else await load_key_agent_ids(db)

    history = await load_room_history(db, [room.id for room in by_id.values()])
    member_ids = {
        str(getattr(member, "participant_id", None))
        for room in by_id.values()
        for member in (getattr(room, "members", None) or [])
    }
    loaded_by_id: dict[str, Any] = {}
    for room in by_id.values():
        for member in getattr(room, "members", None) or []:
            participant = getattr(member, "participant", None)
            if participant is not None and getattr(participant, "id", None) is not None:
                loaded_by_id[str(participant.id)] = participant
    wanted: set[Any] = set()
    for room in by_id.values():
        for sender in history.get(str(room.id), []):
            if sender is not None and str(sender) not in loaded_by_id:
                wanted.add(sender)
        _has_seed, seed_id = thread_seed_of(getattr(room, "metadata_", None))
        if seed_id and seed_id not in loaded_by_id:
            try:
                wanted.add(uuid.UUID(seed_id))
            except ValueError:
                pass
    if asking_seat is not None and getattr(asking_seat, "id", None) is not None:
        loaded_by_id.setdefault(str(asking_seat.id), asking_seat)
    loaded_by_id.update(await load_actors(db, wanted))
    del member_ids

    def facts_for(room: Any, parent_class: str | None) -> RoomClassFacts:
        senders = history.get(str(room.id), [])
        historical = [loaded_by_id.get(str(s)) if s is not None else None for s in senders]
        has_seed, seed_id = thread_seed_of(getattr(room, "metadata_", None))
        seed_sender = loaded_by_id.get(seed_id) if seed_id else None
        return room_class_facts(
            getattr(room, "room_type", None),
            getattr(room, "members", None) or [],
            key_agent_ids=keys,
            asking_seat=asking_seat,
            historical=historical,
            has_seed=has_seed,
            seed_sender=seed_sender,
            parent_class=parent_class,
            floor=class_floor_of(getattr(room, "metadata_", None)),
        )

    out: dict[str, RoomClassFacts] = {}
    # Parents first (top-level rooms), then threads against their parent.
    for key, room in by_id.items():
        if getattr(room, "parent_room_id", None) is None:
            out[key] = facts_for(room, None)
    for key, room in by_id.items():
        if key in out:
            continue
        parent = out.get(str(room.parent_room_id))
        # A parent that could not be loaded is unknown → shared (fail closed).
        parent_class = parent.room_class if parent is not None else ROOM_CLASS_SHARED
        out[key] = facts_for(room, parent_class)
    return {key: out[key] for key in out if key in {str(r.id) for r in room_list}}


async def stamp_class_floor_shared(db: Any, room_ids: Iterable[Any]) -> int:
    """``rooms.metadata.class_floor = "shared"`` for ``room_ids`` — an SQL
    ``||`` merge, so nothing else in the JSONB is touched and a concurrent
    write is not lost. Never cleared. The caller commits."""
    from app.models.room import Room

    ids = [rid for rid in room_ids if rid is not None]
    if not ids:
        return 0
    result = await db.execute(
        update(Room)
        .where(Room.id.in_(ids))
        .values(
            metadata_=func.coalesce(Room.metadata_, cast({}, JSONB)).op("||")(
                cast({CLASS_FLOOR_KEY: ROOM_CLASS_SHARED}, JSONB)
            )
        )
    )
    return int(getattr(result, "rowcount", 0) or 0)


async def apply_class_floors(db: Any, rooms: Iterable[Any], facts: dict[str, RoomClassFacts]) -> list[Any]:
    """Write the sticky floor on every room whose computed class is shared
    and that has no floor yet; mirrors it onto the in-memory metadata so the
    response already shows it. Returns the ids stamped. The caller commits."""
    to_stamp: list[Any] = []
    for room in rooms:
        fact = facts.get(str(room.id))
        if fact is None or fact.room_class != ROOM_CLASS_SHARED:
            continue
        if _value(getattr(room, "room_type", None)) == "channel":
            continue
        if class_floor_of(getattr(room, "metadata_", None)) == ROOM_CLASS_SHARED:
            continue
        to_stamp.append(room.id)
        room.metadata_ = {**(getattr(room, "metadata_", None) or {}), CLASS_FLOOR_KEY: ROOM_CLASS_SHARED}
    if to_stamp:
        await stamp_class_floor_shared(db, to_stamp)
    return to_stamp


# ---------------------------------------------------------------------------
# Seat settings (metadata.seats)
# ---------------------------------------------------------------------------


def seat_setting_from_metadata(metadata: Any, agent_id: str | None) -> dict[str, str | None]:
    """The stored ``metadata.seats[agent_id]`` normalised to ``{model, effort}``
    with nulls when absent or malformed — what C1 hands the asking seat."""
    meta = metadata if isinstance(metadata, dict) else {}
    seats = meta.get(SEATS_METADATA_KEY)
    seats = seats if isinstance(seats, dict) else {}
    raw = seats.get(agent_id) if agent_id else None
    raw = raw if isinstance(raw, dict) else {}
    model = raw.get("model")
    effort = raw.get("effort")
    return {
        "model": model if isinstance(model, str) and SEAT_MODEL_RE.fullmatch(model) else None,
        "effort": effort if isinstance(effort, str) and effort in SEAT_EFFORTS else None,
    }


class SeatSettingError(ValueError):
    """A client sent a seat setting that is not ``{model: str|null, effort: enum|null}``."""


def validate_seat_setting(value: Any) -> dict[str, str | None]:
    """Validate one seat's ``{model, effort}`` → the normalised dict to store.
    ``null`` / ``{}`` mean "back to the seat's defaults"."""
    if value is None:
        return {"model": None, "effort": None}
    if not isinstance(value, dict):
        raise SeatSettingError("seat setting must be an object {model, effort}")
    unknown = set(value) - {"model", "effort"}
    if unknown:
        raise SeatSettingError(f"seat setting has unknown keys: {', '.join(sorted(unknown))}")
    model = value.get("model")
    effort = value.get("effort")
    if model is not None:
        if not isinstance(model, str) or not SEAT_MODEL_RE.fullmatch(model):
            raise SeatSettingError(
                "model must be null or match ^[a-z0-9][a-z0-9.:_/-]{0,80}$"
            )
    if effort is not None:
        if not isinstance(effort, str) or effort not in SEAT_EFFORTS:
            raise SeatSettingError(f"effort must be null or one of {', '.join(SEAT_EFFORTS)}")
    return {"model": model, "effort": effort}


def validate_seats_setting(value: Any) -> dict[str, dict[str, str | None]]:
    """Validate a client-supplied ``seats`` map (R6): ``{"<agent_id>":
    {model, effort}}``, agent ids as slugs, at least one entry."""
    if not isinstance(value, dict) or not value:
        raise SeatSettingError('seats must be a non-empty object {"<agent_id>": {model, effort}}')
    out: dict[str, dict[str, str | None]] = {}
    for agent_id, setting in value.items():
        if not isinstance(agent_id, str) or not AGENT_ID_RE.fullmatch(agent_id):
            raise SeatSettingError(f"seats: invalid agent id {agent_id!r}")
        try:
            out[agent_id] = validate_seat_setting(setting)
        except SeatSettingError as exc:
            raise SeatSettingError(f"seats[{agent_id}]: {exc}") from None
    return out


__all__ = [
    "AGENT_ID_RE",
    "BRIGADE_SUB_PREFIX",
    "CLASS_FLOOR_KEY",
    "CREW_FLAG_KEY",
    "EXCLUDED_KINDS",
    "GUEST_AGENT_KIND",
    "INTEGRATION_KIND",
    "KIND_KEY",
    "OWNER_KEY",
    "ROOM_CLASSES",
    "ROOM_CLASS_CHANNEL",
    "ROOM_CLASS_PRIVATE",
    "ROOM_CLASS_SHARED",
    "SEATS_METADATA_KEY",
    "SEAT_CAPABILITIES_KEY",
    "SEAT_EFFORTS",
    "SEAT_MODEL_RE",
    "THREAD_META_KEY",
    "Actor",
    "MemberLite",
    "RoomClassFacts",
    "RoomLite",
    "SeatSettingError",
    "agent_id_of_sub",
    "apply_class_floors",
    "class_floor_of",
    "classify_room",
    "compute_room_classes",
    "is_excluded_kind_participant",
    "is_house_agent",
    "is_runner_seat",
    "load_actors",
    "load_key_agent_ids",
    "load_members",
    "load_room_history",
    "load_rooms_lite",
    "norm_username",
    "participant_kind",
    "room_class_facts",
    "room_class_for",
    "seat_owner",
    "seat_owners",
    "seat_setting_from_metadata",
    "stamp_class_floor_shared",
    "thread_seed_of",
    "validate_seat_setting",
    "validate_seats_setting",
]
