"""Room class + seat settings (Stable Nav v3, design §2.0 / §2.3 / C1 / C2).

Five kinds of agent live in Stable (design §2.0): Brigade (house) agents,
OUR seats (runners on our computers, ``metadata.owner`` = the human's
username, or a list of usernames), OTHER users' seats, guest agents
(``metadata.kind = guest_agent``) and integrations (``metadata.kind =
integration``). **Ownership decides privacy**, and the class is the one
fact full shell hands depend on, so it is computed the paranoid way:

* **House is an allowlist, never a default** (R1). An agent is house only
  when its ``keycloak_sub`` starts with ``brigade:``, its agent id is not in
  the ``dev-`` namespace (JWT-path identities never have a key row), it
  carries no ``owner``, its ``metadata.backend`` is absent or exactly
  ``brigade``, its ``metadata.kind`` is null, its metadata is an object or
  null, and no ``agent_gateway_keys`` row exists for its agent id (revoked
  or not — keys are only ever revoked). Everything else is foreign unless it
  is a runner seat owned by the room's single human.
* **Private means every line the seat can read came from the owner, the
  owner's seats or house agents** (R2 as amended). The class is computed
  over the union of the current members, every distinct historical sender
  in the room (deleted lines included) and the true author of a thread's
  seed. A NULL sender is foreign unless it is one of Stable's own SYSTEM
  notices (``metadata.kind = "recording"``). A thread is judged on its own
  lines only — its context and its poll never hold a parent line.
* **Floors are a cache of the history verdict** — monotone and
  viewer-independent. ``rooms.metadata.class_floor = "shared"`` is written
  only when the class judged WITHOUT the asking seat is shared (members +
  history + seed), or at insert time when a line's author is foreign to
  the room; never on a membership removal; never cleared. A floored room
  skips the history aggregate.
* **The asking seat reads a room as private only when the single human IS
  its owner** (R3); its own ownership is applied only to the class returned
  to that caller (``room_class``), never to the cached floor (``base_class``).

  ``private``  one human, no guest, every runner seat owned by that human,
               every other agent house, every historical sender one of
               those, no floor.
  ``shared``   anything else.
  ``channel``  ``room_type = channel``.

The pure layer (``room_class_facts``) takes plain actors so the rules have
unit tests; ``compute_room_classes`` runs the queries for a batch of rooms
(one grouped history query, skipped for channels and floored rooms) and is
what the gateway uses.

``metadata.seats = {"<agent_id>": {model, effort}}`` is the per-seat brain
(design §2.4, R6); :func:`validate_seats_setting` is its one shape check.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable

from sqlalchemy import and_, cast, distinct, func, not_, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm.attributes import set_committed_value

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
#: JWT-path gateway identities (``derive_agent_id``) — never house.
JWT_AGENT_ID_PREFIX = "dev-"

#: rooms.metadata keys.
CLASS_FLOOR_KEY = "class_floor"
SEATS_METADATA_KEY = "seats"
THREAD_META_KEY = "thread"
#: messages.metadata.kind of Stable's own NULL-sender SYSTEM notices
#: (services/call_recording.py) — house, not foreign.
SYSTEM_NOTICE_KINDS: tuple[str, ...] = ("recording",)

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

    #: The class as the ASKING seat reads it (R3 applied).
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
    #: The viewer-INDEPENDENT class (asking seat left out): what the floor
    #: caches. Never more private than ``room_class`` is for the owner.
    base_class: str = ""


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
    metadata_: Any = None
    avatar_url: str | None = None


def _value(enum_or_str: Any) -> str:
    return str(getattr(enum_or_str, "value", enum_or_str) or "")


def _meta(participant: Any) -> dict[str, Any]:
    meta = getattr(participant, "metadata_", None)
    return meta if isinstance(meta, dict) else {}


def _meta_is_sane(participant: Any) -> bool:
    """Metadata is an object or null; anything else was written by hand
    and fails closed (P2-10)."""
    meta = getattr(participant, "metadata_", None)
    return meta is None or isinstance(meta, dict)


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
        and _meta_is_sane(participant)
        and participant_backend(participant) == "runner"
        and participant_kind(participant) not in EXCLUDED_KINDS
    )


def is_house_agent(participant: Any, key_agent_ids: Iterable[str]) -> bool:
    """R1 — the house allowlist. ``key_agent_ids`` is every agent id that has
    ANY ``agent_gateway_keys`` row (revoked or not): a key-holder is an
    external process, whatever its participant row says. A row that carries
    an ``owner``, or lives in the ``dev-`` namespace, is somebody's seat even
    when a stale ``backend`` says otherwise (P1-C)."""
    if not _is_agent(participant) or not _meta_is_sane(participant):
        return False
    agent_id = agent_id_of_sub(getattr(participant, "keycloak_sub", None))
    if agent_id is None or agent_id.startswith(JWT_AGENT_ID_PREFIX):
        return False
    meta = _meta(participant)
    backend = meta.get("backend")
    if backend is not None and backend != "brigade":
        return False
    if participant_kind(participant) is not None:
        return False
    if OWNER_KEY in meta and meta.get(OWNER_KEY) not in (None, "", []):
        return False
    return agent_id not in set(key_agent_ids)


def classify_room(
    room_type: Any,
    humans: int,
    foreign: int,
    guests: int,
    *,
    floor: str | None = None,
) -> str:
    """The rule over counts, pure. ``foreign`` is every foreign runner seat
    plus every other foreign actor; ``guests`` is guest humans plus guest
    agents."""
    if _value(room_type) == "channel":
        return ROOM_CLASS_CHANNEL
    if floor == ROOM_CLASS_SHARED:
        return ROOM_CLASS_SHARED
    if humans == 1 and foreign == 0 and guests == 0:
        return ROOM_CLASS_PRIVATE
    return ROOM_CLASS_SHARED


def _judge(
    room_type: Any,
    actors: list[Any],
    *,
    key_ids: set[str],
    asking_seat: Any,
    floor: str | None,
) -> RoomClassFacts:
    """One pass over de-duplicated actors. ``asking_seat`` (if present in
    ``actors``) is counted for the class and left out of the OTHER counts."""
    asking_id = None
    if asking_seat is not None and getattr(asking_seat, "id", None) is not None:
        asking_id = str(asking_seat.id)

    human_names: list[str | None] = []
    guests = 0
    seats: list[tuple[frozenset[str], bool]] = []  # (owners, is_asking)
    foreign_actors = 0
    reasons: list[str] = []
    for actor in actors:
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
                is_asking = actor is asking_seat or (
                    asking_id is not None and pid is not None and str(pid) == asking_id
                )
                seats.append((seat_owners(actor), is_asking))
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
        1 for owners, _asking in seats if single_human is None or single_human not in owners
    )
    others = [(owners, asking) for owners, asking in seats if not asking]
    own_seats = sum(1 for owners, _a in others if owners & known_owners)
    foreign_seats = len(others) - own_seats
    if foreign_for_class:
        reasons.append("foreign_seat")
    if humans != 1:
        reasons.append("humans_%d" % humans)
    if floor == ROOM_CLASS_SHARED:
        reasons.append("floor")

    room_class = classify_room(
        room_type, humans, foreign_for_class + foreign_actors, guests, floor=floor
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
        base_class=room_class,
    )


def _dedupe_actors(actors: Iterable[Any]) -> list[Any]:
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
    return unique


def room_class_facts(
    room_type: Any,
    members: Iterable[Any],
    *,
    key_agent_ids: Iterable[str] = (),
    asking_seat: Any = None,
    historical: Iterable[Any] = (),
    has_seed: bool = False,
    seed_sender: Any = None,
    floor: str | None = None,
) -> RoomClassFacts:
    """Classify from member rows (each with a ``.participant``, None when it
    failed to load), the historical senders (participants, None for a
    foreign NULL sender), the thread seed's true author (``has_seed`` with a
    None ``seed_sender`` is foreign) and the asking seat's own participant.

    ``base_class`` is judged WITHOUT the asking seat (what a floor may
    cache); ``room_class`` adds the asking seat's own ownership (R3) and is
    what that caller is told."""
    key_ids = set(key_agent_ids)
    base_actors: list[Any] = [getattr(member, "participant", None) for member in members]
    base_actors.extend(historical)
    if has_seed:
        base_actors.append(seed_sender)
    base_unique = _dedupe_actors(base_actors)
    base = _judge(room_type, base_unique, key_ids=key_ids, asking_seat=None, floor=floor)
    if asking_seat is None:
        return base

    asking_present = any(
        actor is asking_seat
        or (
            getattr(asking_seat, "id", None) is not None
            and actor is not None
            and getattr(actor, "id", None) is not None
            and str(actor.id) == str(asking_seat.id)
        )
        for actor in base_unique
    )
    view_actors = list(base_unique) if asking_present else list(base_unique) + [asking_seat]
    view = _judge(room_type, view_actors, key_ids=key_ids, asking_seat=asking_seat, floor=floor)
    return RoomClassFacts(
        room_class=view.room_class,
        humans=view.humans,
        own_seats=view.own_seats,
        foreign_seats=view.foreign_seats,
        guests=view.guests,
        foreign_actors=view.foreign_actors,
        runner_seats=view.runner_seats,
        floor=floor,
        reasons=view.reasons,
        base_class=base.room_class,
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
        floor=class_floor_of(getattr(room, "metadata_", None)),
    )


def insert_makes_room_shared(
    room_type: Any,
    member_participants: Iterable[Any],
    author: Any,
    *,
    floor: str | None = None,
    key_agent_ids: Iterable[str] = (),
) -> bool:
    """Insert-time floor rule (P2-2): is the room ``shared`` once ``author``'s
    line is in it, judged viewer-independently over the current members plus
    the author (no history read)? Channels and already-floored rooms never
    need a floor. Without ``key_agent_ids`` a key-holder wearing a brigade
    sub is not caught here — the read path's history aggregate still is."""
    if _value(room_type) == "channel" or floor == ROOM_CLASS_SHARED:
        return False
    actors = _dedupe_actors(list(member_participants) + [author])
    verdict = _judge(room_type, actors, key_ids=set(key_agent_ids), asking_seat=None, floor=None)
    return verdict.room_class == ROOM_CLASS_SHARED


# ---------------------------------------------------------------------------
# Queries: key holders, history, actors, floors
# ---------------------------------------------------------------------------


async def load_key_agent_ids(db: Any) -> set[str]:
    """Every agent id with ANY gateway key row (revoked or not) — R1's
    "no agent_gateway_keys row exists". Deliberately no ``revoked_at``
    filter: a persona that once had a key was an external process."""
    from app.models.agent_gateway_key import AgentGatewayKey

    rows = (await db.execute(select(AgentGatewayKey.agent_id).distinct())).scalars().all()
    return {str(agent_id) for agent_id in rows if agent_id}


@dataclass
class RoomHistory:
    #: Distinct non-NULL sender ids, deleted lines included.
    senders: list[Any] = field(default_factory=list)
    #: True when a NULL-sender line exists that is not one of Stable's own
    #: SYSTEM notices (recording) — foreign, fail closed.
    foreign_null: bool = False


def history_statement(room_ids: list[Any]):
    """The one grouped history query (P2-2): every distinct sender per room
    (``array_agg(DISTINCT sender_id)``, deleted lines INCLUDED — a deleted
    line was still read) and whether any NULL-sender line is not a Stable
    system notice."""
    from app.models.message import ContentType, Message

    system_notice = and_(
        Message.content_type == ContentType.SYSTEM,
        Message.metadata_[KIND_KEY].astext.in_(list(SYSTEM_NOTICE_KINDS)),
    )
    return (
        select(
            Message.room_id,
            func.array_agg(distinct(Message.sender_id)).filter(Message.sender_id.isnot(None)),
            func.bool_or(and_(Message.sender_id.is_(None), not_(system_notice))),
        )
        .where(Message.room_id.in_(room_ids))
        .group_by(Message.room_id)
    )


async def load_room_history(db: Any, room_ids: Iterable[Any]) -> dict[str, RoomHistory]:
    """``{room_id: RoomHistory}`` — one grouped query."""
    ids = list(room_ids)
    if not ids:
        return {}
    rows = (await db.execute(history_statement(ids))).all()
    return {
        str(room_id): RoomHistory(senders=list(senders or []), foreign_null=bool(foreign_null))
        for room_id, senders, foreign_null in rows
    }


def _actor_from_columns(row: Any) -> Actor:
    return Actor(
        id=row[0],
        participant_type=row[1],
        username=row[2],
        keycloak_sub=row[3],
        display_name=row[4],
        metadata_=row[5],
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


def _needs_history(room: Any) -> bool:
    """Channels are channels whatever the history says, and a floored room
    is already cached shared — neither pays for the aggregate (P2-2)."""
    if _value(getattr(room, "room_type", None)) == "channel":
        return False
    return class_floor_of(getattr(room, "metadata_", None)) is None


async def compute_room_classes(
    db: Any,
    rooms: Iterable[Any],
    *,
    asking_seat: Any = None,
    key_agent_ids: Iterable[str] | None = None,
) -> dict[str, RoomClassFacts]:
    """Classify a batch of rooms (objects with ``id``, ``room_type``,
    ``metadata_`` and ``members`` — ORM rooms or :class:`RoomLite`) the R2
    way: members, history, seed, floor. Key agent ids are loaded once per
    call unless given. Returns ``{room_id: facts}``; the caller decides
    whether to write floors (:func:`apply_class_floors`, from ``base_class``)."""
    room_list = list(rooms)
    if not room_list:
        return {}
    keys = set(key_agent_ids) if key_agent_ids is not None else await load_key_agent_ids(db)

    history = await load_room_history(db, [room.id for room in room_list if _needs_history(room)])
    loaded_by_id: dict[str, Any] = {}
    for room in room_list:
        for member in getattr(room, "members", None) or []:
            participant = getattr(member, "participant", None)
            if participant is not None and getattr(participant, "id", None) is not None:
                loaded_by_id[str(participant.id)] = participant
    if asking_seat is not None and getattr(asking_seat, "id", None) is not None:
        loaded_by_id.setdefault(str(asking_seat.id), asking_seat)
    wanted: set[Any] = set()
    for room in room_list:
        for sender in history.get(str(room.id), RoomHistory()).senders:
            if sender is not None and str(sender) not in loaded_by_id:
                wanted.add(sender)
        if _needs_history(room):
            _has_seed, seed_id = thread_seed_of(getattr(room, "metadata_", None))
            if seed_id and seed_id not in loaded_by_id:
                try:
                    wanted.add(uuid.UUID(seed_id))
                except ValueError:
                    pass
    loaded_by_id.update(await load_actors(db, wanted))

    out: dict[str, RoomClassFacts] = {}
    for room in room_list:
        record = history.get(str(room.id), RoomHistory())
        historical: list[Any] = [loaded_by_id.get(str(s)) for s in record.senders]
        if record.foreign_null:
            historical.append(None)
        has_seed, seed_id = thread_seed_of(getattr(room, "metadata_", None))
        seed_sender = loaded_by_id.get(seed_id) if seed_id else None
        out[str(room.id)] = room_class_facts(
            getattr(room, "room_type", None),
            getattr(room, "members", None) or [],
            key_agent_ids=keys,
            asking_seat=asking_seat,
            historical=historical,
            has_seed=has_seed,
            seed_sender=seed_sender,
            floor=class_floor_of(getattr(room, "metadata_", None)),
        )
    return out


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


def _mirror_floor(room: Any) -> None:
    """Show the floor on the in-memory room without scheduling an ORM write:
    ``set_committed_value`` on a mapped Room (so the flush never rewrites the
    whole column over a concurrent ``seats`` PATCH — P2-11), plain
    assignment on a :class:`RoomLite`."""
    merged = {**(getattr(room, "metadata_", None) or {}), CLASS_FLOOR_KEY: ROOM_CLASS_SHARED}
    if hasattr(room, "_sa_instance_state"):
        set_committed_value(room, "metadata_", merged)
    else:
        room.metadata_ = merged


async def apply_class_floors(db: Any, rooms: Iterable[Any], facts: dict[str, RoomClassFacts]) -> list[Any]:
    """Write the sticky floor on every room whose VIEWER-INDEPENDENT class
    (``base_class``) is shared and that has no floor yet; mirrors it onto the
    in-memory room so the response already shows it. Returns the ids
    stamped. The caller commits."""
    to_stamp: list[Any] = []
    for room in rooms:
        fact = facts.get(str(room.id))
        if fact is None or fact.base_class != ROOM_CLASS_SHARED:
            continue
        if _value(getattr(room, "room_type", None)) == "channel":
            continue
        if class_floor_of(getattr(room, "metadata_", None)) == ROOM_CLASS_SHARED:
            continue
        to_stamp.append(room.id)
        _mirror_floor(room)
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
    "JWT_AGENT_ID_PREFIX",
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
    "SYSTEM_NOTICE_KINDS",
    "THREAD_META_KEY",
    "Actor",
    "MemberLite",
    "RoomClassFacts",
    "RoomHistory",
    "RoomLite",
    "SeatSettingError",
    "agent_id_of_sub",
    "apply_class_floors",
    "class_floor_of",
    "classify_room",
    "compute_room_classes",
    "history_statement",
    "insert_makes_room_shared",
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
