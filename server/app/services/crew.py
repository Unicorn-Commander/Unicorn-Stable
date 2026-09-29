"""Crew — the roster of agents a human can talk to (Stable Nav v3, C3).

A messenger is a list of people you talk to. Crew is that list for agents,
built from the five kinds of design §2.0 rather than from whoever happens
to share a room:

* **own seats** — runner seats (``metadata.backend = runner``) that opted in
  with ``metadata.crew = true``, hold a live (non-revoked) gateway key, and
  carry ``metadata.owner`` = the caller's username. Listed whether or not a
  room is shared yet: they are yours.
* **house** — Brigade agents the caller has a hub (``agent_hub``) or an
  agent DM with.
* **partner** — someone else's runner seat (crew flag + live key, a
  different or missing owner) that shares a non-archived room with the
  caller.
* guest agents (``metadata.kind = guest_agent``) and integrations
  (``metadata.kind = integration``) never appear, whatever rooms they post in.

Ranking (design §2.1 as amended): own seats, then house agents with a
message in the last 14 days (most recent first), then partners, then the
rest alphabetically.

``build_crew`` runs the queries; ``assemble_crew`` / ``rank_crew`` are pure
over their inputs so the rules have unit tests. ``/home/summary`` and
``GET /crew`` both call ``build_crew`` — one roster, two shapes.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import httpx
import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent import AgentEvent
from app.models.agent_gateway_key import AgentGatewayKey
from app.models.message import Message
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import Room, RoomMember, RoomType
from app.services.agent_routing import participant_backend
from app.services.room_class import (
    GUEST_AGENT_KIND,
    INTEGRATION_KIND,
    participant_kind,
    seat_owner,
)

logger = structlog.get_logger(__name__)

#: A ``worker_heartbeat`` event this recent means the agent's process is up.
PRESENCE_HEARTBEAT_FRESH = timedelta(minutes=6)
#: A heartbeat this recent counts as "active since" on the home card.
HEARTBEAT_FRESH = timedelta(seconds=90)
#: A task-shaped event this recent is shown as the agent's current task.
TASK_FRESH = timedelta(minutes=15)
#: "Recent" for the ranking: a message from the agent inside this window.
RECENT_WINDOW = timedelta(days=14)
#: How far back the events scan reaches (heartbeats + tasks).
EVENTS_LOOKBACK = timedelta(hours=6)
EVENTS_LIMIT = 300

#: participants.metadata keys this module honours.
CREW_FLAG_KEY = "crew"
SEAT_CAPABILITIES_KEY = "seat_capabilities"
ROLE_LINE_KEYS = ("role_line", "description", "title")
#: ``metadata.kind`` values that are never on anyone's crew.
EXCLUDED_KINDS: frozenset[str] = frozenset({GUEST_AGENT_KIND, INTEGRATION_KIND})

PRESENCE_ONLINE = "online"
PRESENCE_OFFLINE = "offline"

KIND_SEAT = "seat"
KIND_BRIGADE = "brigade"
GROUP_OWN_SEAT = "own_seat"
GROUP_HOUSE = "house"
GROUP_PARTNER = "partner"


@dataclass
class CrewEntry:
    """One agent on the caller's crew — the C3 row plus the extras
    ``/home/summary`` has always shown (status, mode, current task)."""

    agent_id: str
    participant_id: str
    display_name: str
    avatar_url: str | None
    role_line: str | None
    backend: str
    #: ``seat`` (a runner) | ``brigade``.
    kind: str
    #: ``metadata.owner`` — the username that owns a seat; null otherwise.
    owner: str | None
    #: ``own_seat`` | ``house`` | ``partner``.
    group: str
    presence: str
    hub_room_id: str | None
    seat_capabilities: dict[str, Any] | None
    last_line: str | None
    last_at: datetime | None
    unread: int
    status: str
    agent_mode: str | None
    current_task: str | None
    since: datetime | None


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------


def _meta(participant: Any) -> dict[str, Any]:
    meta = getattr(participant, "metadata_", None)
    return meta if isinstance(meta, dict) else {}


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _clip(text: str | None, limit: int = 140) -> str:
    compact = " ".join((text or "").split())
    return compact if len(compact) <= limit else compact[: limit - 1].rstrip() + "…"


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return False


def _norm(name: Any) -> str | None:
    if not isinstance(name, str):
        return None
    cleaned = name.strip().lower()
    return cleaned or None


def agent_id_of(participant: Any) -> str:
    """The agent id a participant posts as: ``brigade:<id>`` → ``<id>``,
    else ``agent-<id>`` → ``<id>``, else the username."""
    sub = str(getattr(participant, "keycloak_sub", "") or "")
    if sub.startswith("brigade:"):
        return sub[len("brigade:") :]
    username = str(getattr(participant, "username", "") or "")
    if username.startswith("agent-"):
        return username[len("agent-") :]
    return username or sub


def is_excluded_kind(participant: Any) -> bool:
    """Guest agents and integrations are never on a crew."""
    return participant_kind(participant) in EXCLUDED_KINDS


def is_integration(participant: Any) -> bool:
    return participant_kind(participant) == INTEGRATION_KIND


def is_crew_flagged(participant: Any) -> bool:
    return _truthy(_meta(participant).get(CREW_FLAG_KEY))


def is_crew_runner_seat(participant: Any, live_key_agent_ids: set[str]) -> bool:
    """A runner seat that opted in (``crew = true``), holds a live key and is
    neither an integration nor a guest agent."""
    return (
        participant_backend(participant) == "runner"
        and is_crew_flagged(participant)
        and not is_excluded_kind(participant)
        and agent_id_of(participant) in live_key_agent_ids
    )


def role_line_of(participant: Any, brigade_roles: dict[str, str] | None = None) -> str | None:
    """Brigade title/description when the roster gave one, else what the
    participant's own metadata says (``role_line`` / ``description`` /
    ``title``), else None."""
    if brigade_roles:
        line = brigade_roles.get(agent_id_of(participant))
        if isinstance(line, str) and line.strip():
            return line.strip()
    meta = _meta(participant)
    for key in ROLE_LINE_KEYS:
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def seat_capabilities_of(participant: Any) -> dict[str, Any] | None:
    caps = _meta(participant).get(SEAT_CAPABILITIES_KEY)
    return caps if isinstance(caps, dict) else None


def event_matches(identity: str, agent_id: str, username: str, sub: str) -> bool:
    """Does an ``agent_events.agent_identity`` refer to this participant?"""
    ident = (identity or "").strip().lower()
    keys = {
        (agent_id or "").lower(),
        (username or "").lower(),
        (sub or "").lower(),
        f"brigade:{agent_id}".lower(),
        f"agent-{agent_id}".lower(),
    }
    keys.discard("")
    return ident in keys


def task_from_event(event_type: str, data: dict[str, Any] | None) -> str | None:
    payload = data if isinstance(data, dict) else {}
    for key in ("current_task", "task", "title"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return _clip(value.strip(), 140)
    if event_type == "tool_call":
        tool = payload.get("tool")
        if isinstance(tool, str) and tool.strip():
            return _clip(tool.strip(), 140)
    return None


def _status_value(participant: Any) -> str:
    status = getattr(participant, "status", None)
    return str(getattr(status, "value", status) or ParticipantStatus.OFFLINE.value)


def _room_type_value(room: Any) -> str:
    room_type = getattr(room, "room_type", None)
    return str(getattr(room_type, "value", room_type) or "")


# ---------------------------------------------------------------------------
# Pure assembly + ranking
# ---------------------------------------------------------------------------


def assemble_crew(
    *,
    now: datetime,
    caller_username: str | None,
    runner_seats: Iterable[Any],
    live_key_agent_ids: set[str],
    shared_rows: Iterable[tuple[Any, Any, Any]],
    last_messages: dict[str, Any],
    unread_by_room: dict[str, int],
    events: Iterable[Any],
    brigade_roles: dict[str, str] | None = None,
) -> list[CrewEntry]:
    """Turn the raw query results into crew entries (unranked).

    ``runner_seats``       every participant with ``backend = runner`` and
                           ``crew = true`` (live key / kind / owner decided
                           here);
    ``shared_rows``        ``(participant, membership, room)`` for every agent
                           member of a non-archived room the caller is in;
    ``last_messages``      participant id → the agent's latest message in a
                           room the caller is in;
    ``unread_by_room``     room id → the caller's unread count there;
    ``events``             recent agent_events (heartbeats, tasks).
    """
    now = _aware(now)
    caller = _norm(caller_username)
    slots: dict[str, dict[str, Any]] = {}

    def slot_for(participant: Any, group: str) -> dict[str, Any]:
        key = str(participant.id)
        slot = slots.get(key)
        if slot is None:
            backend = participant_backend(participant)
            slot = {
                "participant": participant,
                "agent_id": agent_id_of(participant),
                "backend": backend,
                "kind": KIND_SEAT if backend == "runner" else KIND_BRIGADE,
                "owner": seat_owner(participant),
                "group": group,
                "hub_room_id": None,
                "agent_mode": None,
                "mode_score": -1,
            }
            slots[key] = slot
        return slot

    for participant in runner_seats:
        if (
            is_crew_runner_seat(participant, live_key_agent_ids)
            and caller is not None
            and seat_owner(participant) == caller
        ):
            slot_for(participant, GROUP_OWN_SEAT)

    for participant, membership, room in shared_rows:
        if is_excluded_kind(participant):
            continue
        backend = participant_backend(participant)
        room_type = _room_type_value(room)
        is_hub = room_type == RoomType.AGENT_HUB.value
        if backend == "runner":
            if not is_crew_runner_seat(participant, live_key_agent_ids):
                # A runner seat without the crew flag / a live key is not on
                # the crew even when the caller shares a room with it.
                continue
            owner = seat_owner(participant)
            group = GROUP_OWN_SEAT if caller is not None and owner == caller else GROUP_PARTNER
        else:
            if room_type not in (RoomType.AGENT_HUB.value, RoomType.DM.value):
                # A house agent is on the crew through a hub or an agent DM,
                # not because it posts in a channel the caller reads.
                continue
            group = GROUP_HOUSE
        slot = slot_for(participant, group)
        mode = getattr(membership, "agent_mode", None)
        mode = mode if isinstance(mode, str) and mode else None
        # A hub membership's mode beats a DM's, which beats any other room's;
        # a set mode beats an unset one.
        score = (4 if is_hub else 2 if room_type == RoomType.DM.value else 0) + (1 if mode else 0)
        if score > slot["mode_score"]:
            slot["mode_score"] = score
            slot["agent_mode"] = mode or slot["agent_mode"]
        if is_hub and slot["hub_room_id"] is None:
            slot["hub_room_id"] = str(room.id)

    events = list(events)
    entries: list[CrewEntry] = []
    for key, slot in slots.items():
        participant = slot["participant"]
        agent_id = slot["agent_id"]
        username = str(getattr(participant, "username", "") or "")
        sub = str(getattr(participant, "keycloak_sub", "") or "")
        task: str | None = None
        since: datetime | None = None
        heartbeat_at: datetime | None = None
        for event in events:
            if not event_matches(getattr(event, "agent_identity", ""), agent_id, username, sub):
                continue
            occurred = _aware(event.occurred_at)
            if task is None:
                found = task_from_event(event.event_type, event.event_data)
                if found and now - occurred <= TASK_FRESH:
                    task = found
                    since = occurred
            if event.event_type == "worker_heartbeat" and (
                heartbeat_at is None or occurred > heartbeat_at
            ):
                heartbeat_at = occurred
        heartbeat_fresh = heartbeat_at is not None and now - heartbeat_at <= PRESENCE_HEARTBEAT_FRESH
        if since is None and heartbeat_at is not None and now - heartbeat_at <= HEARTBEAT_FRESH:
            since = heartbeat_at
        status = _status_value(participant)
        online = heartbeat_fresh or status == ParticipantStatus.ONLINE.value
        presence = PRESENCE_ONLINE if online else PRESENCE_OFFLINE
        if online and status == ParticipantStatus.OFFLINE.value:
            status = ParticipantStatus.ONLINE.value

        last = last_messages.get(key)
        last_at = _aware(last.created_at) if last is not None and getattr(last, "created_at", None) else None
        hub_room_id = slot["hub_room_id"]
        entries.append(
            CrewEntry(
                agent_id=agent_id,
                participant_id=key,
                display_name=getattr(participant, "display_name", None) or username or agent_id,
                avatar_url=getattr(participant, "avatar_url", None),
                role_line=role_line_of(participant, brigade_roles),
                backend=slot["backend"],
                kind=slot["kind"],
                owner=slot["owner"],
                group=slot["group"],
                presence=presence,
                hub_room_id=hub_room_id,
                seat_capabilities=seat_capabilities_of(participant),
                last_line=_clip(getattr(last, "content", None), 140) if last is not None else None,
                last_at=last_at,
                unread=int(unread_by_room.get(hub_room_id, 0) or 0) if hub_room_id else 0,
                status=status,
                agent_mode=slot["agent_mode"],
                current_task=task,
                since=since,
            )
        )
    return entries


def rank_crew(entries: Iterable[CrewEntry], now: datetime) -> list[CrewEntry]:
    """§2.1 as amended: own seats → house agents heard from in the last 14
    days (most recent first) → partners → the rest alphabetically."""
    now = _aware(now)

    def key(entry: CrewEntry) -> tuple[int, float, str]:
        recent = entry.last_at is not None and now - entry.last_at <= RECENT_WINDOW
        if entry.group == GROUP_OWN_SEAT:
            group = 0
        elif entry.group == GROUP_HOUSE and recent:
            group = 1
        elif entry.group == GROUP_PARTNER:
            group = 2
        else:
            group = 3
        stamp = -entry.last_at.timestamp() if (group < 3 and entry.last_at is not None) else 0.0
        return (group, stamp, (entry.display_name or "").lower())

    return sorted(entries, key=key)


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------


async def live_key_agent_ids(db: AsyncSession) -> set[str]:
    rows = (
        await db.execute(
            select(AgentGatewayKey.agent_id)
            .where(AgentGatewayKey.revoked_at.is_(None))
            .distinct()
        )
    ).scalars().all()
    return {str(agent_id) for agent_id in rows if agent_id}


async def crew_flagged_runner_seats(db: AsyncSession) -> list[Participant]:
    """Every runner seat that opted in with ``metadata.crew = true``
    (JSON ``true`` or the string). Kind / key / owner filtering happens in
    Python."""
    rows = (
        await db.execute(
            select(Participant).where(
                Participant.participant_type == ParticipantType.AGENT,
                Participant.metadata_["backend"].astext == "runner",
                Participant.metadata_[CREW_FLAG_KEY].astext.in_(["true", "1", "yes"]),
            )
        )
    ).scalars().all()
    return list(rows)


async def list_crew_runner_seats(db: AsyncSession) -> list[Participant]:
    """Every runner seat on ANY crew: crew flag, live key, not an excluded
    kind. The caller-agnostic fallback for the New picker."""
    live = await live_key_agent_ids(db)
    seats = await crew_flagged_runner_seats(db)
    out = [seat for seat in seats if is_crew_runner_seat(seat, live)]
    out.sort(key=lambda seat: (seat.display_name or seat.username or "").lower())
    return out


async def build_crew(
    db: AsyncSession,
    participant_id: uuid.UUID,
    now: datetime,
    *,
    caller_username: str | None = None,
    brigade_roles: dict[str, str] | None = None,
) -> list[CrewEntry]:
    """The caller's ranked crew (see module docstring). ``caller_username``
    is looked up when not given — it is what ``metadata.owner`` is matched
    against."""

    def caller_rooms():
        return select(RoomMember.room_id).where(RoomMember.participant_id == participant_id)

    if caller_username is None:
        caller_username = (
            await db.execute(select(Participant.username).where(Participant.id == participant_id))
        ).scalar_one_or_none()

    live = await live_key_agent_ids(db)
    runner_seats = await crew_flagged_runner_seats(db)
    shared_rows = (
        await db.execute(
            select(Participant, RoomMember, Room)
            .join(RoomMember, RoomMember.participant_id == Participant.id)
            .join(Room, Room.id == RoomMember.room_id)
            .where(
                Participant.participant_type == ParticipantType.AGENT,
                Room.is_archived.is_(False),
                Room.id.in_(caller_rooms()),
            )
        )
    ).all()

    entries = assemble_crew(
        now=now,
        caller_username=caller_username,
        runner_seats=runner_seats,
        live_key_agent_ids=live,
        shared_rows=shared_rows,
        last_messages={},
        unread_by_room={},
        events=[],
        brigade_roles=brigade_roles,
    )
    if not entries:
        return []

    # Second pass with the per-agent facts, now that membership is settled.
    by_pid = {entry.participant_id: entry for entry in entries}
    agent_pids = [uuid.UUID(key) for key in by_pid]
    line_rows = (
        await db.execute(
            select(Message)
            .where(
                Message.sender_id.in_(agent_pids),
                Message.is_deleted.is_(False),
                Message.room_id.in_(caller_rooms()),
            )
            .distinct(Message.sender_id)
            .order_by(Message.sender_id, Message.created_at.desc())
        )
    ).scalars().all()
    last_messages = {str(message.sender_id): message for message in line_rows}

    hub_ids = [uuid.UUID(entry.hub_room_id) for entry in entries if entry.hub_room_id]
    unread_by_room: dict[str, int] = {}
    if hub_ids:
        unread_rows = (
            await db.execute(
                select(Message.room_id, func.count())
                .select_from(Message)
                .join(
                    RoomMember,
                    (RoomMember.room_id == Message.room_id)
                    & (RoomMember.participant_id == participant_id),
                )
                .where(
                    Message.room_id.in_(hub_ids),
                    Message.is_deleted.is_(False),
                    Message.sender_id != participant_id,
                    or_(
                        RoomMember.last_read_at.is_(None),
                        Message.created_at > RoomMember.last_read_at,
                    ),
                )
                .group_by(Message.room_id)
            )
        ).all()
        unread_by_room = {str(rid): int(cnt) for rid, cnt in unread_rows}

    participants_by_pid: dict[str, Any] = {str(seat.id): seat for seat in runner_seats}
    for participant, _m, _r in shared_rows:
        participants_by_pid.setdefault(str(participant.id), participant)
    identities: list[str] = []
    for key in by_pid:
        participant = participants_by_pid.get(key)
        if participant is None:
            continue
        agent_id = agent_id_of(participant)
        identities.extend(
            [agent_id, participant.username, participant.keycloak_sub, f"agent-{agent_id}"]
        )
    identities = [item for item in identities if item]
    events: list[AgentEvent] = []
    if identities:
        events = list(
            (
                await db.execute(
                    select(AgentEvent)
                    .where(
                        AgentEvent.agent_identity.in_(identities),
                        AgentEvent.received_at > now - EVENTS_LOOKBACK,
                    )
                    .order_by(AgentEvent.received_at.desc())
                    .limit(EVENTS_LIMIT)
                )
            ).scalars().all()
        )

    entries = assemble_crew(
        now=now,
        caller_username=caller_username,
        runner_seats=runner_seats,
        live_key_agent_ids=live,
        shared_rows=shared_rows,
        last_messages=last_messages,
        unread_by_room=unread_by_room,
        events=events,
        brigade_roles=brigade_roles,
    )
    return rank_crew(entries, now)


async def crew_runner_seats_for(
    db: AsyncSession, participant_id: uuid.UUID, now: datetime | None = None
) -> list[CrewEntry]:
    """The caller's own seats + partner seats (the runner half of the New →
    Talk to an agent picker), ranked as the crew is."""
    entries = await build_crew(db, participant_id, now or datetime.now(timezone.utc))
    return [entry for entry in entries if entry.kind == KIND_SEAT]


# ---------------------------------------------------------------------------
# Brigade role lines (title / bio), cached, best-effort
# ---------------------------------------------------------------------------

_ROLES_CACHE_KEY = "stable:brigade:roster_roles"
_ROLES_CACHE_TTL = 300
_ROLES_FAIL_TTL = 30
_BRIGADE_TIMEOUT = httpx.Timeout(5.0, connect=3.0)


def role_lines_from_roster(items: Any) -> dict[str, str]:
    """Pure: Brigade ``/agents`` payload → ``{agent_id: "title — bio"}``."""
    if isinstance(items, dict):
        items = items.get("agents", [])
    out: dict[str, str] = {}
    for item in items or []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        title = str(item.get("title") or "").strip()
        bio = str(item.get("bio") or item.get("description") or "").strip()
        line = " — ".join(part for part in (title, bio) if part)
        if line:
            out[str(item["id"])] = _clip(line, 140)
    return out


async def load_brigade_role_lines(redis: Any) -> dict[str, str]:
    """Brigade's title/bio per agent, cached in Redis. Never raises: an
    unreachable Brigade means role lines fall back to participant metadata."""
    try:
        cached = await redis.get(_ROLES_CACHE_KEY)
    except Exception:
        cached = None
    if cached is not None:
        try:
            raw = cached.decode("utf-8") if isinstance(cached, bytes) else str(cached)
            payload = json.loads(raw)
            roles = payload.get("roles") if isinstance(payload, dict) else None
            return {str(k): str(v) for k, v in roles.items()} if isinstance(roles, dict) else {}
        except Exception:
            logger.debug("brigade_roles_cache_unreadable", exc_info=True)

    roles: dict[str, str] = {}
    ok = False
    try:
        from app.config import get_settings

        settings = get_settings()
        if settings.brigade_api_key:
            base = settings.brigade_base_url.rstrip("/")
            if base.endswith("/openai/v1"):
                base = base[: -len("/openai/v1")]
            async with httpx.AsyncClient(timeout=_BRIGADE_TIMEOUT) as client:
                resp = await client.get(
                    base + "/agents",
                    headers={"Authorization": f"Bearer {settings.brigade_api_key}"},
                )
                resp.raise_for_status()
                roles = role_lines_from_roster(resp.json())
                ok = True
    except Exception as exc:
        logger.info("brigade_roles_fetch_failed", error=str(exc))

    try:
        await redis.set(
            _ROLES_CACHE_KEY,
            json.dumps({"ok": ok, "roles": roles}),
            ex=_ROLES_CACHE_TTL if ok else _ROLES_FAIL_TTL,
        )
    except Exception:
        logger.debug("brigade_roles_cache_write_failed", exc_info=True)
    return roles


__all__ = [
    "CREW_FLAG_KEY",
    "EXCLUDED_KINDS",
    "GROUP_HOUSE",
    "GROUP_OWN_SEAT",
    "GROUP_PARTNER",
    "HEARTBEAT_FRESH",
    "KIND_BRIGADE",
    "KIND_SEAT",
    "PRESENCE_HEARTBEAT_FRESH",
    "PRESENCE_OFFLINE",
    "PRESENCE_ONLINE",
    "RECENT_WINDOW",
    "TASK_FRESH",
    "CrewEntry",
    "agent_id_of",
    "assemble_crew",
    "build_crew",
    "crew_runner_seats_for",
    "event_matches",
    "is_crew_runner_seat",
    "is_excluded_kind",
    "is_integration",
    "list_crew_runner_seats",
    "load_brigade_role_lines",
    "rank_crew",
    "role_line_of",
    "role_lines_from_roster",
    "seat_capabilities_of",
    "task_from_event",
]
