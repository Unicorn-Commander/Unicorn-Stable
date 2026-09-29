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
  notices — ``content_type = system`` AND ``metadata.kind = "recording"``,
  judged NULL-safe: a missing kind is "not a notice". A notice that names
  who caused it (``metadata.started_by``, a participant id) counts that
  participant as an AUTHOR of the room, in the union and in the floor
  verdict; an id that does not load is foreign. A thread is judged on its
  own lines only — its context and its poll never hold a parent line.
* **Floors are written ONLY from what was written** — a monotone,
  viewer-independent cache of "this history cannot be one party's".
  ``rooms.metadata.class_floor = "shared"`` is written when the historical
  authors plus a thread's seed author are foreign to each other (two
  humans wrote, seats of different owners wrote, a guest / integration /
  unattributed line exists), or at insert time when a line's AUTHOR is
  foreign by nature. Never from current membership, never from the asking
  row, never by or because of a seat nobody has claimed yet (no ``owner``:
  unprovisioned, which reads ``shared`` live and writes nothing); never on
  a membership removal; never cleared. A member who never writes leaves no
  trace: the class is ``shared`` while they are in the room and ``private``
  again when they leave. A floored room skips the history read.
* **The asking seat reads a room as private only when the single human IS
  its owner** (R3); its own ownership, like current membership, shapes only
  the class returned to that caller (``room_class``).

  ``private``  one human, no guest, every runner seat owned by that human,
               every other agent house, every historical sender one of
               those, no floor.
  ``shared``   anything else.
  ``channel``  ``room_type = channel``.

The pure layer (``room_class_facts``) takes plain actors so the rules have
unit tests; ``compute_room_classes`` runs the queries for a batch of rooms
(one history statement of two index-friendly subplans per room, skipped —
together with the key-id lookup — for channels and floored rooms) and is
what the gateway uses.

``metadata.seats = {"<agent_id>": {model, effort}}`` is the per-seat brain
(design §2.4, R6); :func:`validate_seats_setting` is its one shape check.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable

from sqlalchemy import and_, cast, distinct, func, literal, not_, select, update
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
#: messages.metadata key naming the participant who caused a notice (the
#: person who started the recording). Counted as an author of the room.
NOTICE_STARTER_KEY = "started_by"

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
    #: True when what was WRITTEN (historical authors + the seed's author)
    #: cannot be one party's. The ONLY thing a floor caches — never derived
    #: from current membership or from the asking seat.
    history_shared: bool = False
    #: Why the history is shared (``parties``, ``guest_human``, …).
    history_reasons: tuple[str, ...] = ()


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
    )


#: Authors that are foreign by nature — whoever else wrote, whoever is in the room.
_INTRINSIC_FOREIGN = frozenset(
    {"unattributed_actor", "guest_human", "guest_agent", "integration", "foreign_agent", "unknown_participant_type"}
)


def is_seat_shaped(participant: Any, key_agent_ids: Iterable[str] = ()) -> bool:
    """Somebody's seat — or nobody's YET. For the FLOOR verdict only (the
    live class keeps R1's stricter reading): a row that is runner-backed, or
    carries an ``owner``, or is a ``brigade:`` id that holds a gateway key or
    lives in the ``dev-`` namespace. Guest agents and integrations never are.

    Such a row is judged by its OWNER. With no owner it is unprovisioned:
    the operator has not yet said whose it is, which is a gap in the
    paperwork and not a foreign author."""
    if not _is_agent(participant) or not _meta_is_sane(participant):
        return False
    if participant_kind(participant) in EXCLUDED_KINDS:
        return False
    if participant_backend(participant) == "runner" or seat_owners(participant):
        return True
    agent_id = agent_id_of_sub(getattr(participant, "keycloak_sub", None))
    if agent_id is None:
        return False
    return agent_id.startswith(JWT_AGENT_ID_PREFIX) or agent_id in set(key_agent_ids)


def author_tag(actor: Any, key_agent_ids: Iterable[str] = ()) -> str:
    """What kind of AUTHOR this is, for the floor verdict: ``human``,
    ``seat`` (:func:`is_seat_shaped`), ``house`` or one of the intrinsically
    foreign tags."""
    if actor is None:
        return "unattributed_actor"
    ptype = _value(getattr(actor, "participant_type", None))
    if ptype == ParticipantType.HUMAN.value:
        return "human"
    if ptype == ParticipantType.GUEST.value:
        return "guest_human"
    if ptype == ParticipantType.AGENT.value:
        kind = participant_kind(actor)
        if kind == GUEST_AGENT_KIND:
            return "guest_agent"
        if is_seat_shaped(actor, key_agent_ids):
            return "seat"
        if is_house_agent(actor, key_agent_ids):
            return "house"
        return "integration" if kind == INTEGRATION_KIND else "foreign_agent"
    return "unknown_participant_type"


def author_floors_room(author: Any, *, key_agent_ids: Iterable[str] = ()) -> bool:
    """Insert-time floor rule: only an AUTHOR that is foreign by nature
    floors a room the moment its line lands — a guest, an integration, an
    agent that is neither house nor anybody's seat, an unattributed line. A
    human's or a seat's line is never judged here: whether it makes the
    history two parties' is decided by the history verdict on the next read,
    never by who happens to be a member."""
    return author_tag(author, key_agent_ids) in _INTRINSIC_FOREIGN


def history_verdict(
    authors: Iterable[Any], *, key_agent_ids: Iterable[str] = ()
) -> tuple[bool, tuple[str, ...]]:
    """P1-2 — is what was WRITTEN more than one party's? Pure over the
    authors (historical senders plus a thread's seed author; None = an
    unattributed line). Membership and the asking seat are not inputs.

    One party means: there is a username every human author IS and every
    owned seat author belongs to. House agents belong to everyone. An
    UNOWNED seat is unprovisioned, not foreign: its lines never floor a room
    (they become the owner's the moment the row is stamped) — the LIVE class
    still reads ``shared`` while such a line is in the history."""
    key_ids = set(key_agent_ids)
    parties: list[frozenset[str]] = []
    reasons: list[str] = []
    for actor in _dedupe_actors(authors):
        tag = author_tag(actor, key_ids)
        if tag == "human":
            name = norm_username(getattr(actor, "username", None))
            parties.append(frozenset({name}) if name else frozenset())
        elif tag == "seat":
            owners = seat_owners(actor)
            if owners:
                parties.append(owners)
        elif tag == "house":
            continue
        else:
            reasons.append(tag)
    if parties and not frozenset.intersection(*parties):
        reasons.append("parties")
    return bool(reasons), tuple(dict.fromkeys(reasons))


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

    ``room_class`` is the LIVE class: members, authors, seed and asker
    together (R3). ``history_shared`` is the floor verdict: authors and seed
    only (:func:`history_verdict`)."""
    key_ids = set(key_agent_ids)
    authors: list[Any] = list(historical)
    if has_seed:
        authors.append(seed_sender)
    actors: list[Any] = [getattr(member, "participant", None) for member in members]
    actors.extend(authors)
    unique = _dedupe_actors(actors)
    if asking_seat is not None:
        present = any(
            actor is asking_seat
            or (
                getattr(asking_seat, "id", None) is not None
                and actor is not None
                and getattr(actor, "id", None) is not None
                and str(actor.id) == str(asking_seat.id)
            )
            for actor in unique
        )
        if not present:
            unique = unique + [asking_seat]
    live = _judge(room_type, unique, key_ids=key_ids, asking_seat=asking_seat, floor=floor)
    history_shared, history_reasons = history_verdict(authors, key_agent_ids=key_ids)
    room_class, reasons = live.room_class, live.reasons
    if history_shared and room_class == ROOM_CLASS_PRIVATE:
        # Cannot happen (every author is in the live union) — kept as a
        # fail-closed invariant rather than an assumption.
        room_class, reasons = ROOM_CLASS_SHARED, tuple(dict.fromkeys(reasons + history_reasons))
    return RoomClassFacts(
        room_class=room_class,
        humans=live.humans,
        own_seats=live.own_seats,
        foreign_seats=live.foreign_seats,
        guests=live.guests,
        foreign_actors=live.foreign_actors,
        runner_seats=live.runner_seats,
        floor=floor,
        reasons=reasons,
        history_shared=history_shared,
        history_reasons=history_reasons,
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


def insert_floors_room(
    room_type: Any,
    author: Any,
    *,
    floor: str | None = None,
    key_agent_ids: Iterable[str] = (),
) -> bool:
    """Should this insert stamp the floor? Only when the room can still be
    floored (not a channel, not floored yet) and the AUTHOR is foreign by
    nature (:func:`author_floors_room`). Current membership is not an input."""
    if _value(room_type) == "channel" or floor == ROOM_CLASS_SHARED:
        return False
    return author_floors_room(author, key_agent_ids=key_agent_ids)


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
    #: Distinct ``metadata.started_by`` of Stable's own notices, as the text
    #: that was stored: whoever caused a notice is an author of the room.
    starters: list[str] = field(default_factory=list)


def foreign_null_line(
    sender_id: Any,
    content_type: Any,
    kind_text: Any,
    *,
    system_value: Any,
    notice_kinds: Iterable[str] = SYSTEM_NOTICE_KINDS,
) -> Any:
    """SQL predicate: a NULL-sender line that is NOT one of Stable's own
    SYSTEM notices — i.e. unattributed text, foreign. NULL-SAFE (P2-1): a
    NULL-sender SYSTEM line with no ``kind``, a null ``kind`` or NULL
    metadata makes ``kind = 'recording'`` NULL, and ``COALESCE(…, false)``
    turns that into "not a notice" instead of letting three-valued logic
    hide the row. House ONLY when content_type is system AND kind is a
    notice kind; anything else is foreign.

    Takes column expressions so the same predicate runs against
    ``messages`` in production and against a plain table in the tests."""
    is_notice = and_(content_type == system_value, kind_text.in_(list(notice_kinds)))
    return and_(sender_id.is_(None), not_(func.coalesce(is_notice, False)))


def notice_with_starter(
    sender_id: Any,
    content_type: Any,
    kind_text: Any,
    starter_text: Any,
    *,
    system_value: Any,
    notice_kinds: Iterable[str] = SYSTEM_NOTICE_KINDS,
) -> Any:
    """SQL predicate: one of Stable's own NULL-sender SYSTEM notices that
    names who caused it (``metadata.started_by`` is not NULL). The notice is
    house; the person it names is not necessarily the owner, and rows
    written before REVIEW-4 carry that person's chosen display name in
    their text — so they count as an author. Column expressions, like
    :func:`foreign_null_line`, so the tests run it on a real SQL engine."""
    return and_(
        sender_id.is_(None),
        content_type == system_value,
        kind_text.in_(list(notice_kinds)),
        starter_text.isnot(None),
    )


def history_statement(room_ids: list[Any]):
    """One statement for a batch of rooms (P2-2), three index-friendly
    subplans per room:

    * the distinct non-NULL sender ids — ``array_agg(DISTINCT sender_id)``
      over ``room_id`` + ``sender_id`` only, so it is an index-only scan of
      ``ix_messages_room_id_sender_id``. Deleted lines are INCLUDED on
      purpose: a deleted line was still read.
    * a bounded ``EXISTS`` for a foreign NULL-sender line
      (:func:`foreign_null_line`): it visits NULL-sender rows only and stops
      at the first hit.
    * the distinct ``metadata.started_by`` of Stable's own notices
      (:func:`notice_with_starter`): NULL-sender rows only, the same few
      rows the EXISTS reads."""
    from app.models.message import ContentType, Message
    from app.models.room import Room

    senders = (
        select(func.array_agg(distinct(Message.sender_id)))
        .where(Message.room_id == Room.id, Message.sender_id.isnot(None))
        .correlate(Room)
        .scalar_subquery()
    )
    foreign_null = (
        select(literal(1))
        .where(
            Message.room_id == Room.id,
            foreign_null_line(
                Message.sender_id,
                Message.content_type,
                Message.metadata_[KIND_KEY].astext,
                system_value=ContentType.SYSTEM,
            ),
        )
        .correlate(Room)
        .exists()
    )
    starter_text = Message.metadata_[NOTICE_STARTER_KEY].astext
    starters = (
        select(func.array_agg(distinct(starter_text)))
        .where(
            Message.room_id == Room.id,
            notice_with_starter(
                Message.sender_id,
                Message.content_type,
                Message.metadata_[KIND_KEY].astext,
                starter_text,
                system_value=ContentType.SYSTEM,
            ),
        )
        .correlate(Room)
        .scalar_subquery()
    )
    return select(Room.id, senders, foreign_null, starters).where(Room.id.in_(room_ids))


async def load_room_history(db: Any, room_ids: Iterable[Any]) -> dict[str, RoomHistory]:
    """``{room_id: RoomHistory}`` — one statement (:func:`history_statement`)."""
    ids = list(room_ids)
    if not ids:
        return {}
    rows = (await db.execute(history_statement(ids))).all()
    out: dict[str, RoomHistory] = {}
    for row in rows:
        starters = row[3] if len(row) > 3 else None
        out[str(row[0])] = RoomHistory(
            senders=list(row[1] or []),
            foreign_null=bool(row[2]),
            starters=[str(s) for s in (starters or []) if s is not None],
        )
    return out


def _participant_key(value: Any) -> str | None:
    """A participant id as the key members and senders are stored under
    (the canonical UUID text), or None when the value is not a UUID."""
    if value is None:
        return None
    try:
        return str(value if isinstance(value, uuid.UUID) else uuid.UUID(str(value).strip()))
    except (ValueError, AttributeError, TypeError):
        return None


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
    #: Newest line in the room (per-room top-1), filled by the rooms list.
    last_message_at: Any = None


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
    whether to write floors (:func:`apply_class_floors`, from
    ``history_shared`` — what was written, never who is a member)."""
    room_list = list(rooms)
    if not room_list:
        return {}
    needing = [room for room in room_list if _needs_history(room)]
    if key_agent_ids is not None:
        keys = set(key_agent_ids)
    elif needing:
        keys = await load_key_agent_ids(db)
    else:
        # Every room is a channel or already floored: the class is decided
        # without telling house from key-holder, so the lookup is skipped
        # (the counts on those rows treat brigade-shaped rows as house).
        keys = set()

    history = await load_room_history(db, [room.id for room in needing])
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
        record = history.get(str(room.id), RoomHistory())
        for sender in record.senders:
            if sender is not None and str(sender) not in loaded_by_id:
                wanted.add(sender)
        for starter in record.starters:
            key = _participant_key(starter)
            if key is not None and key not in loaded_by_id:
                wanted.add(uuid.UUID(key))
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
        # Whoever caused a notice is an author too (REVIEW-4 P1-1). An id
        # that is not a UUID, or names no participant, loads as None:
        # unattributed, foreign.
        for starter in record.starters:
            key = _participant_key(starter)
            historical.append(loaded_by_id.get(key) if key is not None else None)
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
    """Write the sticky floor on every room whose HISTORY is shared
    (``history_shared``: authors and seed author only) and that has no floor
    yet; mirrors it onto the in-memory room so the response already shows
    it. A room that is shared only because of who is a member, or who is
    asking, is left untouched. Returns the ids stamped. The caller commits."""
    to_stamp: list[Any] = []
    for room in rooms:
        fact = facts.get(str(room.id))
        if fact is None or not fact.history_shared:
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
    "NOTICE_STARTER_KEY",
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
    "author_floors_room",
    "author_tag",
    "class_floor_of",
    "classify_room",
    "compute_room_classes",
    "foreign_null_line",
    "history_statement",
    "history_verdict",
    "insert_floors_room",
    "is_excluded_kind_participant",
    "is_house_agent",
    "is_runner_seat",
    "is_seat_shaped",
    "load_actors",
    "load_key_agent_ids",
    "load_members",
    "load_room_history",
    "load_rooms_lite",
    "norm_username",
    "notice_with_starter",
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
