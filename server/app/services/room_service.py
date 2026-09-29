from __future__ import annotations

import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import HTTPException, status
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.agent import AgentConfig
from app.models.message import ContentType, Message
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import (
    AGENT_MODES,
    RECORDING_KINDS,
    RECORDING_POLICIES,
    ROOM_VISIBILITIES,
    MemberRole,
    Room,
    RoomMember,
    RoomType,
)
from app.services.agent_routing import participant_backend, find_agent_participant
from app.services.agent_availability import UNKNOWN, get_agent_availability
from app.services.livekit_service import LiveKitService
from app.services.mentions import parse_mentions
from app.services.presence_service import PresenceService
from app.services.room_class import (
    CLASS_FLOOR_KEY,
    SEATS_METADATA_KEY,
    SeatSettingError,
    agent_id_of_sub,
    insert_floors_room,
    is_runner_seat,
    norm_username,
    participant_kind,
    seat_owner,
    seat_owners,
    validate_seats_setting,
)

logger = structlog.get_logger(__name__)

# Room-metadata keys a client PATCH may write. Everything else in metadata_
# is server-owned wiring (brigade_agent_id, conference, dm_pair, …) that a
# room admin's browser must not be able to rewrite through the generic
# update endpoint. ``seats`` (Nav v3 C2 / R6: per-seat {model, effort},
# keyed by agent id) is validated and separately authorised in
# ``update_room`` — see ``_authorize_seats_setting``.
CLIENT_MUTABLE_METADATA_KEYS: frozenset[str] = frozenset({"auto_titled", SEATS_METADATA_KEY})

#: Room slugs may not wear the LiveKit prefix: LiveKit names are
#: ``stable-<slug>``, so a room NAMED ``stable-persephone`` would collide with
#: #persephone's LiveKit name in every by-name lookup and key scope.
RESERVED_ROOM_NAME_PREFIX = "stable-"

#: Threads nested under a parent row in GET /rooms are capped per parent; the
#: rest come from GET /rooms/{id}/threads (which pages by include_archived).
NESTED_THREADS_PER_PARENT = 25

#: Room-slug shape shared by channels and converted groups (RoomCreate.name).
ROOM_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


@dataclass
class ThreadCreation:
    """What ``create_thread`` made: the thread room, the parent's system
    line ("<name> started a thread: <title>"), the quoted seed (when a
    ``seed_message_id`` was given) and every member it seeded — so the API
    layer can fan the two messages out and push the room to each member."""

    room: Room
    system_message: Message | None = None
    seed_message: Message | None = None
    member_ids: list[uuid.UUID] = field(default_factory=list)


def dm_pair_key(a: uuid.UUID | str, b: uuid.UUID | str) -> str:
    """Canonical 1:1 human-DM key: sorted participant UUIDs joined by ``:``.

    Used as ``room.metadata_['dm_pair']`` and as the basis for the deterministic
    room slug so concurrent ensures collide on the same unique index / name
    instead of creating two rooms.
    """
    left, right = sorted((str(a), str(b)))
    return f"{left}:{right}"


def dm_room_slug(pair_key: str) -> str:
    """Deterministic internal room name for a human DM pair (≤100 chars)."""
    left, right = pair_key.split(":", 1)
    return f"dm-{left}-{right}"


def group_slug_base(display_name: str) -> str:
    """Internal slug candidate for a group DM, derived from its label.

    Mirrors the client's createRoom slugification (lowercase, runs of
    non-alphanumerics collapse to ``-``) so server-minted group rooms look like
    the ones CreateDmModal has been minting all along. Collisions are fine —
    create paths uniquify with a hex suffix.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", display_name.lower()).strip("-")[:80]
    return slug or "group"


def group_display_name(labels: Sequence[str]) -> str:
    """Default group-DM label: ``Group: `` + first three member names.

    Same formula CreateDmModal uses when a user assembles a group by hand, so
    a group started FROM a DM is named exactly like one started from scratch.
    """
    parts = [l.strip() for l in labels if l and l.strip()][:3]
    return "Group: " + ", ".join(parts) if parts else "Group chat"


@dataclass(frozen=True)
class GroupSeed:
    """Pure composition plan for converting a 1:1 DM into a NEW group room.

    ``member_ids``            — every participant to write a member row for, in
                                order (source members first, then extras),
                                deduplicated.
    ``agent_ids_to_create``   — brigade agent ids that need a Participant/member
                                bound because they are NOT already resident in
                                the source DM.
    ``canonical_agent_id``    — who answers by default in the new room
                                (metadata.brigade_agent_id). Last-invited wins,
                                matching the existing multi-agent convention:
                                the last NEW selection, else the source DM's
                                resident agent.
    ``metadata``              — the new room's server-owned metadata, including
                                ``origin_dm_id`` (provenance) and a carried
                                ``model_override`` so the conversation keeps
                                speaking through the model the DM had picked.
    """

    member_ids: tuple[str, ...]
    agent_ids_to_create: tuple[str, ...]
    canonical_agent_id: str | None
    metadata: dict[str, Any]


def compose_group_seed(
    source_room_id: str,
    source_member_ids: Sequence[str],
    source_agent_ids: Sequence[str],
    source_metadata: Mapping[str, Any] | None,
    extra_participant_ids: Sequence[str],
    new_agent_ids: Sequence[str],
) -> GroupSeed:
    """Decide exactly who seeds the new group room (pure — no I/O).

    The source DM's members are the non-negotiable core: BOTH sides of the
    1:1 (plus any resident agent member rows) come along, then the extra
    selections. The source room itself is never touched.
    """
    meta = dict(source_metadata or {})

    member_ids: list[str] = []
    seen: set[str] = set()
    for pid in [*source_member_ids, *extra_participant_ids]:
        key = str(pid)
        if key in seen:
            continue
        seen.add(key)
        member_ids.append(key)

    resident = {str(a) for a in source_agent_ids}
    to_create: list[str] = []
    for agent_id in new_agent_ids:
        aid = str(agent_id)
        if aid in resident or aid in to_create:
            continue
        to_create.append(aid)

    # Last-invited wins — computed over the RAW selection order (before the
    # resident-dedup) so re-picking the resident agent keeps it canonical.
    canonical: str | None = (
        str(new_agent_ids[-1]) if new_agent_ids else None
    ) or (str(meta["brigade_agent_id"]) if meta.get("brigade_agent_id") else None)

    new_meta: dict[str, Any] = {"origin_dm_id": str(source_room_id)}
    if canonical:
        new_meta["brigade_agent_id"] = canonical
    if meta.get("model_override"):
        new_meta["model_override"] = meta["model_override"]

    return GroupSeed(
        member_ids=tuple(member_ids),
        agent_ids_to_create=tuple(to_create),
        canonical_agent_id=canonical,
        metadata=new_meta,
    )


class RoomService:
    """Business logic for room operations."""

    def __init__(
        self,
        db: AsyncSession,
        livekit: LiveKitService,
        presence: PresenceService,
    ) -> None:
        self._db = db
        self._livekit = livekit
        self._presence = presence

    async def create_room(
        self,
        name: str,
        display_name: str,
        room_type: str,
        creator_id: uuid.UUID,
        description: str | None = None,
        max_participants: int = 50,
        metadata: dict | None = None,
        org_id: str | None = None,
    ) -> Room:
        """Create a new room in the database and LiveKit.

        ``name`` is the internal slug (it also seeds ``livekit_room_name``), so
        it must be globally unique. Channels are uniquely *named* on purpose
        (they're shared and browsable), so a collision there is a real
        "name taken" error the creator should see and resolve. DM / group-DM
        names, by contrast, are auto-derived (e.g. "Chat with Majik") and many
        legitimately coexist — the same user starting a second chat, or two
        users each chatting the same agent. For those we uniquify the slug
        instead of rejecting; otherwise the very first such room makes every
        later "New chat" fail with 409 forever (the user can't start a new
        conversation at all).
        """
        existing = (
            await self._db.execute(select(Room).where(Room.name == name))
        ).scalar_one_or_none()
        if existing is not None:
            if RoomType(room_type) == RoomType.CHANNEL:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Room with name '{name}' already exists",
                )
            # Preserve the human label, uniquify only the internal slug.
            if not display_name:
                display_name = name
            base = name
            name = f"{base}-{uuid.uuid4().hex[:8]}"
            while (
                await self._db.execute(select(Room).where(Room.name == name))
            ).scalar_one_or_none() is not None:
                name = f"{base}-{uuid.uuid4().hex[:8]}"

        # Create in LiveKit first
        lk_room_name = f"stable-{name}"
        lk_room = await self._livekit.create_room(
            name=lk_room_name,
            max_participants=max_participants,
        )

        # Create in database
        room = Room(
            name=name,
            display_name=display_name,
            description=description,
            room_type=RoomType(room_type),
            livekit_room_name=lk_room_name,
            livekit_sid=lk_room.sid if lk_room.sid else None,
            max_participants=max_participants,
            created_by=creator_id,
            org_id=org_id,
            metadata_=metadata or {},
        )
        self._db.add(room)
        await self._db.flush()

        # Add creator as owner
        membership = RoomMember(
            room_id=room.id,
            participant_id=creator_id,
            role=MemberRole.OWNER,
        )
        self._db.add(membership)
        await self._db.commit()
        await self._db.refresh(room)

        logger.info("room_created", room_id=str(room.id), name=name, creator=str(creator_id))
        return room

    async def ensure_human_dm(
        self,
        caller_id: uuid.UUID,
        target_id: uuid.UUID,
        org_id: str | None = None,
    ) -> tuple[Room, bool]:
        """Idempotently get-or-create a 1:1 human DM between caller and target.

        Race-safety strategy (all layers reinforce each other):
        1. Canonical ``dm_pair`` key = sorted ``participant_id`` UUIDs.
        2. Transaction-scoped ``pg_advisory_xact_lock(hashtext(dm_pair))`` so
           concurrent ensures for the same pair serialize on one DB connection
           set — double-check after lock sees the winner's room.
        3. Deterministic room ``name`` (``dm-{uuid}-{uuid}``) hits the existing
           unique constraint on ``rooms.name`` if two creators slip past the
           lock (different DBs / failed advisory).
        4. Durable partial unique index on ``metadata->>'dm_pair'`` for DM rooms
           (migration 010) so IntegrityError is the final backstop.
        5. Both memberships are written in the same transaction as the room row
           so we never return a half-created DM missing the target.

        Returns ``(room, created)`` where ``created`` is True only when this
        call inserted the room.
        """
        if caller_id == target_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot start a DM with yourself",
            )

        target = (
            await self._db.execute(select(Participant).where(Participant.id == target_id))
        ).scalar_one_or_none()
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )
        if target.participant_type != ParticipantType.HUMAN:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Target must be a human participant",
            )

        pair_key = dm_pair_key(caller_id, target_id)
        slug = dm_room_slug(pair_key)

        # Serialize concurrent ensures for this pair for the rest of the txn.
        await self._db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
            {"k": f"stable:dm_pair:{pair_key}"},
        )

        existing = await self._find_human_dm(caller_id, target_id, pair_key, slug)
        if existing is not None:
            await self._maybe_backfill_dm_pair(existing, pair_key)
            return existing, False

        display_name = f"DM with {target.display_name or target.username}"
        lk_room_name = f"stable-{slug}"
        try:
            lk_room = await self._livekit.create_room(
                name=lk_room_name,
                max_participants=2,
            )
        except Exception:
            # LiveKit may already have the room from a prior half-finished attempt.
            logger.warning(
                "ensure_human_dm_livekit_create_retry",
                slug=slug,
                exc_info=True,
            )
            try:
                existing_lk = await self._livekit.list_rooms(names=[lk_room_name])
                lk_room = existing_lk[0] if existing_lk else None
            except Exception:
                lk_room = None
            if lk_room is None:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Could not provision DM media room",
                )

        room = Room(
            name=slug,
            display_name=display_name,
            description=None,
            room_type=RoomType.DM,
            livekit_room_name=lk_room_name,
            livekit_sid=getattr(lk_room, "sid", None) or None,
            max_participants=2,
            created_by=caller_id,
            org_id=org_id,
            metadata_={"dm_pair": pair_key},
        )
        self._db.add(room)
        try:
            await self._db.flush()
        except IntegrityError:
            # Lost a race on name / dm_pair unique constraint — return winner.
            await self._db.rollback()
            # Re-acquire lock after rollback (xact lock was released).
            await self._db.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                {"k": f"stable:dm_pair:{pair_key}"},
            )
            existing = await self._find_human_dm(caller_id, target_id, pair_key, slug)
            if existing is None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="DM already exists but could not be loaded",
                )
            return existing, False

        # Both members in the same transaction — no half-created DM.
        self._db.add(
            RoomMember(
                room_id=room.id,
                participant_id=caller_id,
                role=MemberRole.OWNER,
            )
        )
        self._db.add(
            RoomMember(
                room_id=room.id,
                participant_id=target_id,
                role=MemberRole.MEMBER,
            )
        )

        try:
            await self._db.commit()
        except IntegrityError:
            await self._db.rollback()
            await self._db.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                {"k": f"stable:dm_pair:{pair_key}"},
            )
            existing = await self._find_human_dm(caller_id, target_id, pair_key, slug)
            if existing is None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="DM already exists but could not be loaded",
                )
            return existing, False

        await self._db.refresh(room)
        logger.info(
            "human_dm_ensured",
            room_id=str(room.id),
            pair=pair_key,
            created=True,
            caller=str(caller_id),
            target=str(target_id),
        )
        return room, True

    async def start_group_from_dm(
        self,
        source_room_id: uuid.UUID,
        caller_id: uuid.UUID | str,
        extra_participant_ids: Sequence[uuid.UUID] = (),
        new_agent_ids: Sequence[str] = (),
        agent_names: Mapping[str, str] | None = None,
        display_name: str | None = None,
        org_id: str | None = None,
    ) -> Room:
        """Start a NEW group DM seeded from an existing 1:1 DM.

        The explicit "start a group with <peer>" conversion: the new
        ``group_dm`` contains BOTH sides of the source DM (including any
        resident agent's member row), plus ``extra_participant_ids`` (humans)
        and ``new_agent_ids`` (brigade agents). The source DM is NEVER
        mutated — its history stays private to its two members.

        Atomicity: the room row and EVERY membership (both DM principals,
        extras, and agent participants) commit in one transaction, mirroring
        ensure_human_dm's invariant — we never mint a group that claims the
        peer is in it without the peer actually being in it. Only the LiveKit
        media room is created beforehand (an orphaned empty LiveKit room is
        harmless; a half-seeded Stable room is a lie).

        ``new_agent_ids`` must already be validated against Brigade by the
        caller (the API layer does), exactly like invite-brigade-agent.
        ``agent_names`` maps those ids to display names for participant rows
        created here; avatar backfill happens post-commit via the existing
        _ensure_agent_member path.
        """
        source = (
            await self._db.execute(
                select(Room).where(Room.id == source_room_id)
            )
        ).scalar_one_or_none()
        if source is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found",
            )
        if source.room_type != RoomType.DM:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only a 1:1 DM can be turned into a group",
            )

        member_rows = (
            await self._db.execute(
                select(RoomMember, Participant)
                .join(Participant, Participant.id == RoomMember.participant_id)
                .where(RoomMember.room_id == source.id)
                .order_by(RoomMember.joined_at.asc())
            )
        ).all()
        if not any(
            str(p.id) == str(caller_id) for _m, p in member_rows
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You must be a member of this DM to start a group from it",
            )

        # A runner cannot hear a newly created room until BOTH its profile
        # and gateway scope are provisioned. Group conversion does neither.
        for _member, participant in member_rows:
            if participant.participant_type == ParticipantType.AGENT and participant_backend(participant) != "brigade":
                raise HTTPException(409, "New runner rooms require administrator provisioning")
        for agent_id in new_agent_ids or []:
            participant = await find_agent_participant(self._db, agent_id)
            if participant_backend(participant) != "brigade":
                raise HTTPException(409, "New runner rooms require administrator provisioning")

        # Validate the extra humans BEFORE creating anything: all-or-nothing,
        # so a stale pick fails the whole call cleanly instead of minting a
        # group missing someone it claims to include.
        extras: list[Participant] = []
        if extra_participant_ids:
            found = (
                await self._db.execute(
                    select(Participant).where(
                        Participant.id.in_(list(extra_participant_ids))
                    )
                )
            ).scalars().all()
            by_id = {str(p.id): p for p in found}
            for pid in extra_participant_ids:
                target = by_id.get(str(pid))
                if target is None:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=f"User not found: {pid}",
                    )
                if target.participant_type != ParticipantType.HUMAN:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Agents are added via agent_ids, not participant_ids",
                    )
                extras.append(target)

        source_agent_ids = [
            p.keycloak_sub[len("brigade:"):]
            for _m, p in member_rows
            if p.participant_type == ParticipantType.AGENT
            and (p.keycloak_sub or "").startswith("brigade:")
        ]
        seed = compose_group_seed(
            source_room_id=str(source.id),
            source_member_ids=[str(p.id) for _m, p in member_rows],
            source_agent_ids=source_agent_ids,
            source_metadata=source.metadata_,
            extra_participant_ids=[str(pid) for pid in extra_participant_ids],
            new_agent_ids=[str(a) for a in new_agent_ids],
        )

        # Default label = the same "Group: A, B, C" formula CreateDmModal uses,
        # over everyone who ISN'T the caller: DM peers first, then extras, then
        # agents. Clients normally pass their own computed label.
        names = dict(agent_names or {})
        label = (display_name or "").strip()[:255]
        if not label:
            labels = [
                (p.display_name or p.username or "")
                for _m, p in member_rows
                if str(p.id) != str(caller_id)
                and p.participant_type != ParticipantType.AGENT
            ]
            labels += [(p.display_name or p.username or "") for p in extras]
            labels += [
                (p.display_name or p.username or "")
                for _m, p in member_rows
                if p.participant_type == ParticipantType.AGENT
            ]
            labels += [
                names.get(a) or a.replace("-", " ").title()
                for a in seed.agent_ids_to_create
            ]
            label = group_display_name(labels)

        # Resolve-or-create the NEW agents' Participant rows (same pseudo-sub
        # contract as brigade._ensure_agent_member; created inside the SAME
        # transaction as the room so agent membership is atomic too).
        new_agent_participants: list[Participant] = []
        for agent_id in seed.agent_ids_to_create:
            pseudo_sub = f"brigade:{agent_id}"
            agent_p = (
                await self._db.execute(
                    select(Participant).where(Participant.keycloak_sub == pseudo_sub)
                )
            ).scalar_one_or_none()
            if agent_p is None:
                agent_p = Participant(
                    # Explicit id (same uuid4 the column defaults to) so the
                    # member row below can reference it without waiting on
                    # flush-time default assignment.
                    id=uuid.uuid4(),
                    keycloak_sub=pseudo_sub,
                    username=f"agent-{agent_id}",
                    display_name=names.get(agent_id)
                    or agent_id.replace("-", " ").title(),
                    participant_type=ParticipantType.AGENT,
                    status=ParticipantStatus.ONLINE,
                )
                self._db.add(agent_p)
            new_agent_participants.append(agent_p)

        # Internal slug, uniquified exactly like create_room's non-channel path.
        base = group_slug_base(label)
        slug = base
        while (
            await self._db.execute(select(Room).where(Room.name == slug))
        ).scalar_one_or_none() is not None:
            slug = f"{base[:80]}-{uuid.uuid4().hex[:8]}"

        # Media room first — DB rows only exist if this succeeded.
        lk_room_name = f"stable-{slug}"
        try:
            lk_room = await self._livekit.create_room(
                name=lk_room_name,
                max_participants=50,
            )
        except Exception:
            logger.warning(
                "start_group_livekit_create_failed", slug=slug, exc_info=True
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Could not provision the group's media room",
            )

        room = Room(
            name=slug,
            display_name=label,
            description=None,
            room_type=RoomType.GROUP_DM,
            livekit_room_name=lk_room_name,
            livekit_sid=getattr(lk_room, "sid", None) or None,
            max_participants=50,
            created_by=caller_id,
            org_id=org_id,
            metadata_=seed.metadata,
        )
        self._db.add(room)
        try:
            # One flush gives the room AND any new agent participants their ids.
            await self._db.flush()
            new_agent_pids = {str(p.id) for p in new_agent_participants}
            for pid in [*seed.member_ids, *sorted(new_agent_pids)]:
                self._db.add(
                    RoomMember(
                        room_id=room.id,
                        participant_id=uuid.UUID(str(pid)),
                        role=(
                            MemberRole.OWNER
                            if str(pid) == str(caller_id)
                            else MemberRole.MEMBER
                        ),
                    )
                )
            await self._db.commit()
        except IntegrityError:
            await self._db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Could not create the group — please try again",
            )

        await self._db.refresh(room)
        logger.info(
            "group_started_from_dm",
            room_id=str(room.id),
            source_room_id=str(source.id),
            caller=str(caller_id),
            member_count=len(seed.member_ids) + len(new_agent_participants),
            canonical_agent=seed.canonical_agent_id,
        )
        return room

    @staticmethod
    def _is_pure_human_dm_room(room: Room) -> bool:
        """Reject DMs that were agent chats or still carry agent residency.

        Legacy "New chat with agent" and "invite Perry into this DM" rooms often
        keep ``room_type=dm`` and exactly two *human* members after the agent
        leaves, but ``metadata.brigade_agent_id`` still points at the agent.
        Returning those from ensureHumanDm opens "DM with Shafen" that is really
        an old agent thread — the bug dogfood hit for Shafen + Perrywinkle.
        """
        meta = room.metadata_ if isinstance(getattr(room, "metadata_", None), dict) else {}
        if not meta and isinstance(getattr(room, "metadata", None), dict):
            meta = room.metadata  # type: ignore[assignment]
        if meta.get("brigade_agent_id"):
            return False
        if meta.get("agent_id"):
            return False
        # The multi-agent SET form (resident_agents.py) marks residency the
        # same way the scalar does — a dm carrying it is an agent thread.
        if meta.get("brigade_agent_ids"):
            return False
        return True

    def _accept_human_dm_candidate(self, room: Room | None) -> Room | None:
        """Metadata + type gate (no extra round-trip). Agent members filtered in SQL."""
        if room is None:
            return None
        if room.room_type != RoomType.DM or room.is_archived:
            return None
        if not self._is_pure_human_dm_room(room):
            return None
        return room

    async def _verify_or_reclaim_canonical_dm(
        self,
        room: Room,
        caller_id: uuid.UUID,
        target_id: uuid.UUID,
    ) -> Room | None:
        """Verify — and when needed repair in place — a room that holds this
        pair's canonical DM key.

        A room found by the pair stamp or the deterministic slug IS this
        pair's DM by construction — but writers that bypass the API (the ops
        bridge's add-member script writes RoomMember rows straight into the
        DB) can leave an agent member row or agent metadata on it, and
        archiving strands the key. Rejecting such a room used to wedge ensure
        permanently: _find refused to return it while its unique name / pair
        stamp blocked creating a replacement, so every click was a 409
        (the 2026-08-27 Aaron↔Shafen incident — an agent was added to their
        1:1 DM mid-show and "Message" errored from then on).

        Membership is checked HERE, not in SQL exclusions, because a
        member-only taint (agent row, clean metadata) must be healed too —
        filtering the room out of the query would just re-create the wedge.

        Rules, deliberately narrow:
          * the room must still be a DM (a promoted group_dm is NOT touched);
          * its HUMAN members must be exactly {caller, target} — never touch a
            room we are not certain belongs to this pair;
          * heal = delete agent member rows, strip agent residency metadata
            (brigade_agent_id / agent_id / brigade_agent_ids), un-archive;
          * an already-clean room returns as-is with no writes.
        """
        if room.room_type != RoomType.DM:
            return None
        rows = (
            await self._db.execute(
                select(RoomMember, Participant)
                .join(Participant, Participant.id == RoomMember.participant_id)
                .where(RoomMember.room_id == room.id)
            )
        ).all()
        humans = {
            p.id for _m, p in rows if p.participant_type == ParticipantType.HUMAN
        }
        agent_rows = [
            (m, p) for m, p in rows if p.participant_type != ParticipantType.HUMAN
        ]
        if humans != {caller_id, target_id}:
            return None

        meta = dict(room.metadata_ or {})
        stripped_meta = [
            key
            for key in ("brigade_agent_id", "agent_id", "brigade_agent_ids")
            if meta.pop(key, None) is not None
        ]
        was_archived = bool(room.is_archived)
        if not agent_rows and not stripped_meta and not was_archived:
            # Already a pure, live human DM — the common fast path.
            return room

        for member, _p in agent_rows:
            await self._db.delete(member)
        if stripped_meta:
            room.metadata_ = meta
        if was_archived:
            room.is_archived = False
        try:
            await self._db.commit()
            await self._db.refresh(room)
        except Exception:
            await self._db.rollback()
            logger.warning(
                "human_dm_reclaim_failed", room_id=str(room.id), exc_info=True
            )
            return None
        logger.info(
            "human_dm_reclaimed",
            room_id=str(room.id),
            stripped_agents=[p.username for _m, p in agent_rows],
            stripped_metadata=stripped_meta,
            unarchived=was_archived,
        )
        return room

    async def _clear_stale_dm_pair(self, room: Room, pair_key: str) -> None:
        """Drop a dm_pair stamp that pointed at an agent-tainted room."""
        meta = dict(room.metadata_ or {})
        if meta.get("dm_pair") != pair_key:
            return
        meta.pop("dm_pair", None)
        room.metadata_ = meta
        try:
            await self._db.commit()
            await self._db.refresh(room)
            logger.info(
                "cleared_stale_dm_pair",
                room_id=str(room.id),
                pair=pair_key,
                reason="agent_tainted_room",
            )
        except Exception:
            await self._db.rollback()
            logger.warning("clear_stale_dm_pair_failed", room_id=str(room.id), exc_info=True)

    async def _find_human_dm(
        self,
        caller_id: uuid.UUID,
        target_id: uuid.UUID,
        pair_key: str,
        slug: str,
    ) -> Room | None:
        """Locate an existing true 1:1 *human-only* DM for this pair, if any.

        Canonical hits (pair stamp, deterministic slug) are queried WITHOUT
        the agent-member / archived exclusions on purpose: a canonical room in
        bad state must be repaired (or have its key freed), never merely
        skipped — a skipped room still holds the unique name, so the create
        that follows hits IntegrityError and the endpoint wedges into 409s.
        """
        # 1. Canonical metadata key (post-ensure rooms + backfilled legacy).
        by_pair = (
            await self._db.execute(
                select(Room).where(
                    Room.room_type == RoomType.DM,
                    Room.metadata_["dm_pair"].astext == pair_key,
                )
            )
        ).scalar_one_or_none()
        if by_pair is not None:
            healed = await self._verify_or_reclaim_canonical_dm(
                by_pair, caller_id, target_id
            )
            if healed is not None:
                return healed
            # Pair key sits on a room this pair cannot use — free the key so a
            # clean ensure can create (or find) a pure human DM.
            await self._clear_stale_dm_pair(by_pair, pair_key)

        # 2. Deterministic slug (unique rooms.name).
        by_name = (
            await self._db.execute(
                select(Room).where(Room.name == slug)
            )
        ).scalar_one_or_none()
        if by_name is not None:
            healed = await self._verify_or_reclaim_canonical_dm(
                by_name, caller_id, target_id
            )
            if healed is not None:
                return healed
            # The canonical name is held by a room this pair cannot reclaim
            # (e.g. a dm silently promoted to group_dm). Creation below will
            # conflict on rooms.name — log the blocker so the resulting 409
            # is diagnosable instead of a dead end.
            logger.warning(
                "ensure_human_dm_slug_blocked",
                room_id=str(by_name.id),
                slug=slug,
                room_type=str(by_name.room_type),
                is_archived=bool(by_name.is_archived),
            )

        # 3. Legacy membership: exactly two members, both humans, both the pair,
        #    no agent members, no agent metadata. Prefer most recently active.
        both_members = (
            select(RoomMember.room_id)
            .where(RoomMember.participant_id.in_([caller_id, target_id]))
            .group_by(RoomMember.room_id)
            .having(func.count(func.distinct(RoomMember.participant_id)) == 2)
        )
        member_count = (
            select(func.count())
            .select_from(RoomMember)
            .where(RoomMember.room_id == Room.id)
            .correlate(Room)
            .scalar_subquery()
        )
        agent_member_rooms = (
            select(RoomMember.room_id)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(Participant.participant_type == ParticipantType.AGENT)
        )
        legacy_rows = (
            await self._db.execute(
                select(Room)
                .where(
                    Room.room_type == RoomType.DM,
                    Room.is_archived == False,  # noqa: E712
                    Room.id.in_(both_members),
                    member_count == 2,
                    Room.id.notin_(agent_member_rooms),
                )
                .order_by(Room.updated_at.desc())
            )
        ).scalars().all()
        for candidate in legacy_rows:
            accepted = self._accept_human_dm_candidate(candidate)
            if accepted is not None:
                return accepted
        return None

    async def _maybe_backfill_dm_pair(self, room: Room, pair_key: str) -> None:
        """Stamp dm_pair on a pure human 1:1 DM so future lookups hit the key."""
        if not self._is_pure_human_dm_room(room):
            return
        meta = dict(room.metadata_ or {})
        if meta.get("dm_pair") == pair_key:
            return
        meta["dm_pair"] = pair_key
        # Ensure we never keep an agent residency flag on a "pure" human DM.
        meta.pop("brigade_agent_id", None)
        meta.pop("agent_id", None)
        meta.pop("brigade_agent_ids", None)
        room.metadata_ = meta
        try:
            await self._db.commit()
            await self._db.refresh(room)
        except IntegrityError:
            # Another room already owns this pair key — leave legacy alone.
            await self._db.rollback()

    async def get_room(self, room_id: uuid.UUID) -> dict[str, Any]:
        """Get a room with member list and online status."""
        result = await self._db.execute(
            select(Room).where(Room.id == room_id)
        )
        room = result.scalar_one_or_none()
        if room is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found",
            )

        # Get member count
        member_count_result = await self._db.execute(
            select(func.count()).select_from(RoomMember).where(RoomMember.room_id == room_id)
        )
        member_count = member_count_result.scalar() or 0

        # Get online count from presence
        online_ids = await self._presence.get_online_in_room(str(room_id))
        online_count = len(online_ids)

        return {
            "room": room,
            "member_count": member_count,
            "online_count": online_count,
        }

    async def list_rooms_for_user(
        self,
        participant_id: uuid.UUID,
        cursor: str | None = None,
        limit: int = 50,
        is_archived: bool = False,
        nested: bool = False,
    ) -> dict[str, Any]:
        """List rooms the user is a member of, with pagination.

        ``is_archived`` selects which shelf you're looking at: the default
        (False) is the live sidebar and excludes archived rooms, exactly as
        before; True returns ONLY the caller's archived rooms (the sidebar's
        "Archived" disclosure). It is a filter on the same membership-scoped
        query — never a way to see someone else's rooms.

        ``nested`` (``GET /rooms?view=nested``, design §3) hangs each parent's
        live threads under its row (``threads``, ``latest_thread_id``) and
        keeps threads out of the top level. The DEFAULT is today's FLAT shape:
        every room the caller is in — a thread parented by the 022 backfill
        included — is an ordinary row, so a client that predates the
        conversation model keeps showing all of them.
        """
        query = (
            select(Room)
            .join(RoomMember, RoomMember.room_id == Room.id)
            .where(
                RoomMember.participant_id == participant_id,
                Room.is_archived == is_archived,
            )
            .order_by(Room.updated_at.desc())
        )
        if nested:
            # Threads (parent_room_id set) never appear at the top level of
            # the nested view: they hang under their parent row.
            query = query.where(Room.parent_room_id.is_(None))

        if cursor:
            try:
                cursor_uuid = uuid.UUID(cursor)
                cursor_room_result = await self._db.execute(
                    select(Room.updated_at).where(Room.id == cursor_uuid)
                )
                cursor_ts = cursor_room_result.scalar_one_or_none()
                if cursor_ts:
                    query = query.where(Room.updated_at < cursor_ts)
            except (ValueError, TypeError):
                pass

        query = query.limit(limit + 1)
        result = await self._db.execute(query)
        rooms = list(result.scalars().all())

        next_cursor: str | None = None
        if len(rooms) > limit:
            rooms = rooms[:limit]
            next_cursor = str(rooms[-1].id)

        # Get total count (same shelf as the page: archived or live).
        count_query = (
            select(func.count())
            .select_from(RoomMember)
            .where(RoomMember.participant_id == participant_id)
            .join(Room, Room.id == RoomMember.room_id)
            .where(Room.is_archived == is_archived)
        )
        if nested:
            count_query = count_query.where(Room.parent_room_id.is_(None))
        total_result = await self._db.execute(count_query)
        total = total_result.scalar() or 0

        # Batch the conversation-list extras for the whole page in two queries
        # (avoids an N+1 and lets the sidebar/home feed show previews + unread
        # badges on cold load). Keyed by str(room_id) so UUID vs str column
        # typing can't cause a lookup miss.
        room_ids = [room.id for room in rooms]
        last_msg_by_room: dict[str, Message] = {}
        unread_by_room: dict[str, int] = {}
        mention_by_room: dict[str, tuple[int, bool]] = {}
        # Nested view only: live threads under this page's rooms, hung under
        # their parent rows (design §3). Fetched before the batches so their
        # previews / unread badges ride the same three queries as their
        # parents. The flat default never runs this query.
        threads: list[Room] = []
        if nested and room_ids:
            thread_rows = await self._db.execute(
                select(Room)
                .where(
                    Room.parent_room_id.in_(room_ids),
                    Room.is_archived == False,  # noqa: E712
                )
                .order_by(Room.updated_at.desc())
            )
            threads = list(thread_rows.scalars().all())
        thread_ids = [t.id for t in threads]
        batch_ids = room_ids + thread_ids
        if room_ids:
            # Latest non-deleted message per room (Postgres DISTINCT ON; the
            # leading ORDER BY column must match the DISTINCT column).
            lm_rows = await self._db.execute(
                select(Message)
                .where(
                    Message.room_id.in_(batch_ids),
                    Message.is_deleted == False,  # noqa: E712
                )
                .order_by(Message.room_id, Message.created_at.desc())
                .distinct(Message.room_id)
                .options(selectinload(Message.sender))
            )
            for m in lm_rows.scalars().all():
                last_msg_by_room[str(m.room_id)] = m

            # Unread = messages after the caller's last_read_at, excluding the
            # caller's own. One grouped query across the page.
            unread_rows = await self._db.execute(
                select(Message.room_id, func.count())
                .select_from(Message)
                .join(
                    RoomMember,
                    (RoomMember.room_id == Message.room_id)
                    & (RoomMember.participant_id == participant_id),
                )
                .where(
                    Message.room_id.in_(batch_ids),
                    Message.is_deleted == False,  # noqa: E712
                    Message.sender_id != participant_id,
                    or_(
                        RoomMember.last_read_at.is_(None),
                        Message.created_at > RoomMember.last_read_at,
                    ),
                )
                .group_by(Message.room_id)
            )
            for rid, cnt in unread_rows.all():
                unread_by_room[str(rid)] = cnt
            mention_rows = await self._db.execute(
                select(
                    RoomMember.room_id,
                    RoomMember.mention_count,
                    RoomMember.has_unread_mention,
                ).where(
                    RoomMember.participant_id == participant_id,
                    RoomMember.room_id.in_(batch_ids),
                )
            )
            for rid, count, unread in mention_rows.all():
                mention_by_room[str(rid)] = (count, unread)

        # Conversation-model extras (design §3): thread counts, the 1:1
        # counterpart and the agent members with their modes — batched for the
        # whole page (parents AND their nested threads) so the sidebar never
        # guesses whose face to draw.
        extras = await self._conversation_extras(rooms + threads) if room_ids else {}

        # Nested thread rows, newest activity first, capped per parent. A
        # thread the caller is not a member of (someone else's thread in a
        # channel they share) is listed with is_member=False and no badges;
        # opening it joins them (join_room's parent-member rule).
        def _activity(t: Room) -> Any:
            lm = last_msg_by_room.get(str(t.id))
            return (lm.created_at if lm is not None else None) or t.updated_at or t.created_at

        threads_by_parent: dict[str, list[dict[str, Any]]] = {}
        for t in sorted(threads, key=_activity, reverse=True):
            bucket = threads_by_parent.setdefault(str(t.parent_room_id), [])
            if len(bucket) >= NESTED_THREADS_PER_PARENT:
                continue
            is_member = str(t.id) in mention_by_room
            bucket.append({
                "room": t,
                "member_count": len(getattr(t, "members", None) or []),
                "online_count": 0,
                "last_message": last_msg_by_room.get(str(t.id)),
                "unread_count": unread_by_room.get(str(t.id), 0) if is_member else 0,
                "mention_count": mention_by_room.get(str(t.id), (0, False))[0],
                "has_unread_mention": mention_by_room.get(str(t.id), (0, False))[1],
                "is_member": is_member,
                **extras.get(str(t.id), {}),
            })

        # Enrich rooms with member/online counts + conversation-list extras
        enriched_rooms: list[dict[str, Any]] = []
        for room in rooms:
            mc_result = await self._db.execute(
                select(func.count()).select_from(RoomMember).where(RoomMember.room_id == room.id)
            )
            mc = mc_result.scalar() or 0
            # Presence is decoration; the room list is the product. A redis
            # outage here used to 500 the ENTIRE rooms endpoint — the sidebar
            # rendered empty and users read it as "my history is gone"
            # (2026-08-05..07, corrupt-AOF crash loop). Fail open to zero.
            try:
                online_ids = await self._presence.get_online_in_room(str(room.id))
            except Exception:
                online_ids = set()
            nested = threads_by_parent.get(str(room.id), [])
            enriched_rooms.append({
                "room": room,
                "member_count": mc,
                "online_count": len(online_ids),
                "last_message": last_msg_by_room.get(str(room.id)),
                "unread_count": unread_by_room.get(str(room.id), 0),
                "mention_count": mention_by_room.get(str(room.id), (0, False))[0],
                "has_unread_mention": mention_by_room.get(str(room.id), (0, False))[1],
                "is_member": True,
                "threads": nested,
                "latest_thread_id": nested[0]["room"].id if nested else None,
                **extras.get(str(room.id), {}),
            })

        return {
            "rooms": enriched_rooms,
            "total": total,
            "cursor": next_cursor,
        }

    # ------------------------------------------------------------------
    # Conversation model (design §3, migration 021/022): hubs, threads,
    # per-member agent mode, list extras.
    # ------------------------------------------------------------------

    @staticmethod
    def hub_slug(human_id: uuid.UUID | str, agent_id: str) -> str:
        """Deterministic hub slug — MUST match 022_agent_hubs_backfill so a
        backfilled hub and an API-ensured hub land on the same name."""
        import hashlib

        digest = hashlib.md5(f"{human_id}:{agent_id}".encode()).hexdigest()
        return f"hub-{digest[:12]}"

    async def _conversation_extras(self, rooms: Sequence[Room]) -> dict[str, dict[str, Any]]:
        """Batched ``thread_count`` / ``counterpart`` / ``agents`` for a page
        of rooms. Keyed by ``str(room.id)``."""
        room_ids = [r.id for r in rooms]
        out: dict[str, dict[str, Any]] = {
            str(r.id): {"thread_count": 0, "counterpart": None, "agents": []}
            for r in rooms
        }
        if not room_ids:
            return out

        thread_rows = await self._db.execute(
            select(Room.parent_room_id, func.count())
            .where(
                Room.parent_room_id.in_(room_ids),
                Room.is_archived == False,  # noqa: E712
            )
            .group_by(Room.parent_room_id)
        )
        for parent_id, cnt in thread_rows.all():
            if str(parent_id) in out:
                out[str(parent_id)]["thread_count"] = int(cnt or 0)

        member_rows = await self._db.execute(
            select(RoomMember, Participant)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(RoomMember.room_id.in_(room_ids))
            .order_by(RoomMember.joined_at.asc())
        )
        by_room: dict[str, list[tuple[RoomMember, Participant]]] = {}
        for membership, participant in member_rows.all():
            by_room.setdefault(str(membership.room_id), []).append((membership, participant))

        for room in rooms:
            rows = by_room.get(str(room.id), [])
            agents: list[dict[str, Any]] = []
            counterpart: dict[str, Any] | None = None
            for membership, participant in rows:
                if participant.participant_type == ParticipantType.AGENT:
                    sub = participant.keycloak_sub or ""
                    agents.append({
                        "participant_id": participant.id,
                        "agent_id": sub[len("brigade:"):] if sub.startswith("brigade:") else None,
                        "display_name": participant.display_name or participant.username,
                        "avatar_url": participant.avatar_url,
                        "agent_mode": getattr(membership, "agent_mode", None),
                    })
            if room.room_type == RoomType.AGENT_HUB and agents:
                a = agents[0]
                counterpart = {
                    "participant_id": a["participant_id"],
                    "kind": "agent",
                    "display_name": a["display_name"],
                    "username": None,
                    "avatar_url": a["avatar_url"],
                    "avatar_emoji": None,
                    "agent_id": a["agent_id"],
                }
                for _m, p in rows:
                    if p.id == a["participant_id"]:
                        counterpart["username"] = p.username
                        counterpart["avatar_emoji"] = p.avatar_emoji
            elif room.room_type == RoomType.DM:
                creator = str(room.created_by) if room.created_by else None
                # The "other" side: prefer the non-creator human; a DM whose
                # creator left still has exactly one human left to show.
                humans = [p for _m, p in rows if p.participant_type != ParticipantType.AGENT]
                other = next((p for p in humans if str(p.id) != creator), None) or (
                    humans[0] if humans else None
                )
                if other is not None:
                    counterpart = {
                        "participant_id": other.id,
                        "kind": other.participant_type.value,
                        "display_name": other.display_name or other.username,
                        "username": other.username,
                        "avatar_url": other.avatar_url,
                        "avatar_emoji": other.avatar_emoji,
                        "agent_id": None,
                    }
            out[str(room.id)]["agents"] = agents
            out[str(room.id)]["counterpart"] = counterpart
        return out

    async def room_extras(self, room: Room) -> dict[str, Any]:
        """``_conversation_extras`` for one room (GET /rooms/{id})."""
        return (await self._conversation_extras([room])).get(
            str(room.id), {"thread_count": 0, "counterpart": None, "agents": []}
        )

    async def ensure_agent_hub(
        self,
        *,
        human_id: uuid.UUID,
        agent_id: str,
        org_id: str | None = None,
    ) -> tuple[Room, bool]:
        """Find-or-create THE hub room for (human, agent). Idempotent.

        The hub is what "Talk to <agent>" opens; threads (child rooms) hang
        under it. Exactly one exists per pair — enforced by the partial unique
        index ``uq_rooms_agent_hub`` (022) — so a concurrent double-call
        resolves to the same row. Returns ``(room, created)``.
        """
        agent_id = (agent_id or "").strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", agent_id):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Invalid agent id",
            )

        def _existing_stmt():
            return select(Room).where(
                Room.room_type == RoomType.AGENT_HUB,
                Room.metadata_["agent_hub"]["human_id"].astext == str(human_id),
                Room.metadata_["agent_hub"]["agent_id"].astext == agent_id,
            )

        room = (await self._db.execute(_existing_stmt())).scalar_one_or_none()
        created = False

        agent_p = await find_agent_participant(self._db, agent_id)
        if agent_p is None or getattr(agent_p, "id", None) is None:
            # Mirror agent_chat_responder's bootstrap: an agent the roster names
            # but nobody has talked to yet gets its Participant on first use.
            # (find_agent_participant hands back a TRANSIENT placeholder for a
            # provisioned-but-silent runner seat — keep its backend fact.)
            placeholder_meta = getattr(agent_p, "metadata_", None) if agent_p is not None else None
            agent_p = Participant(
                keycloak_sub=f"brigade:{agent_id}",
                username=f"agent-{agent_id}",
                display_name=agent_id.replace("-", " ").title(),
                participant_type=ParticipantType.AGENT,
                status=ParticipantStatus.ONLINE,
                metadata_=dict(placeholder_meta) if isinstance(placeholder_meta, dict) else None,
            )
            self._db.add(agent_p)
            await self._db.commit()
            await self._db.refresh(agent_p)

        if room is None:
            slug = self.hub_slug(human_id, agent_id)
            hub_meta: dict[str, Any] = {
                "agent_hub": {"human_id": str(human_id), "agent_id": agent_id},
                "brigade_agent_id": agent_id,
                # Voice settings a NEW hub starts with (L2 item 1); an
                # existing hub keeps whatever its owner set.
                **(await self._hub_voice_defaults(human_id, agent_id)),
            }
            try:
                room = await self.create_room(
                    name=slug,
                    display_name=agent_p.display_name or agent_id,
                    room_type=RoomType.AGENT_HUB.value,
                    creator_id=human_id,
                    metadata=hub_meta,
                    org_id=org_id,
                )
                created = True
            except IntegrityError:
                # Lost the race to a concurrent ensure — take theirs.
                await self._db.rollback()
                room = (await self._db.execute(_existing_stmt())).scalar_one_or_none()
                if room is None:
                    raise

        # Seed / repair memberships: the human owns the hub, the agent answers
        # everything in it. Both idempotent.
        human_m = await self._get_membership(room.id, human_id)
        if human_m is None:
            self._db.add(RoomMember(room_id=room.id, participant_id=human_id, role=MemberRole.OWNER))
        agent_m = await self._get_membership(room.id, agent_p.id)
        if agent_m is None:
            self._db.add(
                RoomMember(
                    room_id=room.id,
                    participant_id=agent_p.id,
                    role=MemberRole.MEMBER,
                    agent_mode="answers_all",
                )
            )
        elif getattr(agent_m, "agent_mode", None) is None:
            agent_m.agent_mode = "answers_all"
        await self._db.commit()
        await self._db.refresh(room)

        logger.info(
            "agent_hub_ensured",
            room_id=str(room.id),
            agent_id=agent_id,
            human_id=str(human_id),
            created=created,
        )
        return room, created

    #: Parent metadata keys a thread INHERITS. Everything else (agent_hub,
    #: dm_pair, conference, pinned_message_ids, backfill_022…) stays with the
    #: parent — those are identity facts, not conversation settings.
    THREAD_INHERITED_METADATA_PREFIXES: tuple[str, ...] = ("voice_relay_",)
    THREAD_INHERITED_METADATA_KEYS: frozenset[str] = frozenset(
        {"brigade_agent_id", "brigade_agent_ids", "model_override", "voice_primary_agent_id"}
    )

    #: A thread titled from its seed message keeps this many characters.
    THREAD_TITLE_FROM_SEED_CHARS = 60

    @classmethod
    def thread_title_from_seed(cls, content: str | None) -> str:
        compact = " ".join((content or "").split())
        if len(compact) <= cls.THREAD_TITLE_FROM_SEED_CHARS:
            return compact
        return compact[: cls.THREAD_TITLE_FROM_SEED_CHARS - 1].rstrip() + "…"

    async def create_thread(
        self,
        *,
        parent_id: uuid.UUID,
        creator_id: uuid.UUID,
        title: str | None = None,
        seed_message_id: uuid.UUID | None = None,
    ) -> ThreadCreation:
        """Create a THREAD: a child room under ``parent_id`` (design §3).

        Works on ANY room — dm, group_dm, agent_hub, channel (incl. project
        channels) — for any member of the parent. Inherits the parent's
        ``room_type`` (so a thread under a hub auto-answers, one under a
        channel answers when named), ``org_id``, ``visibility``, recording
        policy and the conversation-relevant metadata. One level only.

        Members: the creator (OWNER), the parent's agent members with the same
        ``agent_mode``, and every human @-mentioned in the title or the seed
        message who is ALSO a member of the parent (a mention never widens a
        private room's audience).

        ``seed_message_id`` quotes that message as the thread's first entry —
        a SYSTEM-styled message whose ``metadata.seed_message_id`` /
        ``seed_room_id`` link back to the original, which is not moved. The
        parent gets a SYSTEM line "<name> started a thread: <title>" carrying
        ``metadata.thread_room_id``. ``thread_count`` on the parent is derived
        (``_conversation_extras``), so nothing else needs maintaining.
        """
        parent = (await self._db.execute(select(Room).where(Room.id == parent_id))).scalar_one_or_none()
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
        if await self._get_membership(parent.id, creator_id) is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this room")
        if getattr(parent, "parent_room_id", None) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Threads cannot be nested; start the thread from the parent room",
            )
        if parent.is_archived:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This room is archived")

        seed: Message | None = None
        if seed_message_id is not None:
            seed = (
                await self._db.execute(
                    select(Message).where(
                        Message.id == seed_message_id,
                        Message.room_id == parent.id,
                        Message.is_deleted == False,  # noqa: E712
                    )
                )
            ).scalar_one_or_none()
            if seed is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Seed message not found in this room",
                )

        creator = (
            await self._db.execute(select(Participant).where(Participant.id == creator_id))
        ).scalar_one_or_none()
        creator_name = (
            (getattr(creator, "display_name", None) or getattr(creator, "username", None) or "Someone")
            if creator is not None
            else "Someone"
        )

        parent_meta = dict(parent.metadata_ or {})
        meta: dict[str, Any] = {
            k: v
            for k, v in parent_meta.items()
            if k in self.THREAD_INHERITED_METADATA_KEYS
            or any(k.startswith(p) for p in self.THREAD_INHERITED_METADATA_PREFIXES)
        }
        meta["thread"] = {
            "parent_room_id": str(parent.id),
            "seed_message_id": str(seed.id) if seed is not None else None,
            # R2: the seed's TRUE author, so the class of a thread started
            # from a stranger's line counts that stranger. None when the
            # seed's sender is gone (NULL) — foreign, fail closed.
            "seed_sender_id": (
                str(seed.sender_id) if seed is not None and seed.sender_id else None
            ),
        }
        display = (title or "").strip()
        if not display and seed is not None:
            display = self.thread_title_from_seed(seed.content)
        display = display or "New thread"
        slug = f"{parent.name[:80]}-t-{uuid.uuid4().hex[:8]}"

        # Seed members from the parent's roster in one query: agents keep
        # their mode; humans come along only when @-mentioned.
        handles: set[str] = set(parse_mentions(display).handles)
        if seed is not None:
            handles |= set(parse_mentions(seed.content).handles)
        member_rows = await self._db.execute(
            select(RoomMember, Participant)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(RoomMember.room_id == parent.id)
        )
        parent_members = list(member_rows.all())
        if seed is not None and insert_floors_room(
            parent.room_type, getattr(seed, "sender", None)
        ):
            # The seed's AUTHOR is foreign by nature (a guest, an
            # integration, an unattributed line): the thread is shared from
            # birth. A human's or a seat's line as the seed never floors
            # here — the thread's members are not an input (REVIEW-3 P1-2);
            # the read path judges the history.
            meta[CLASS_FLOOR_KEY] = "shared"

        room = await self.create_room(
            name=slug,
            display_name=display,
            room_type=parent.room_type.value,
            creator_id=creator_id,
            metadata=meta,
            org_id=parent.org_id,
            max_participants=parent.max_participants,
        )
        room.parent_room_id = parent.id
        room.visibility = getattr(parent, "visibility", "public")
        room.recording_policy = getattr(parent, "recording_policy", "off")
        room.recording_kind = getattr(parent, "recording_kind", "audio")
        # A thread in a project channel is part of that project: the chip,
        # the Tasks panel and promote-to-task pre-fill keep working inside it.
        room.project_number = getattr(parent, "project_number", None)

        member_ids: list[uuid.UUID] = [creator_id]
        for membership, participant in parent_members:
            if participant.id == creator_id:
                continue
            if participant.participant_type == ParticipantType.AGENT:
                self._db.add(
                    RoomMember(
                        room_id=room.id,
                        participant_id=participant.id,
                        role=MemberRole.MEMBER,
                        agent_mode=getattr(membership, "agent_mode", None),
                    )
                )
                member_ids.append(participant.id)
            elif handles and (participant.username or "").casefold() in handles:
                self._db.add(
                    RoomMember(room_id=room.id, participant_id=participant.id, role=MemberRole.MEMBER)
                )
                member_ids.append(participant.id)

        seed_message: Message | None = None
        if seed is not None:
            seed_sender = getattr(seed, "sender", None)
            # The quoted line keeps its TRUE author (R2): a stranger's words
            # are never re-attributed to the creator, so the room's class —
            # and anyone reading the history — sees who really wrote them.
            # SYSTEM styling marks it as a quote, not a new line.
            seed_message = Message(
                room_id=room.id,
                sender_id=seed.sender_id,
                content=seed.content,
                content_type=ContentType.SYSTEM,
                metadata_={
                    "kind": "thread_seed",
                    "seed_message_id": str(seed.id),
                    "seed_room_id": str(parent.id),
                    "seed_sender_id": str(seed.sender_id) if seed.sender_id else None,
                    "seed_sender_name": (
                        getattr(seed_sender, "display_name", None)
                        or getattr(seed_sender, "username", None)
                    ),
                    "seed_created_at": seed.created_at.isoformat() if seed.created_at else None,
                },
            )
            self._db.add(seed_message)

        system_message = Message(
            room_id=parent.id,
            sender_id=creator_id,
            content=f"{creator_name} started a thread: {display}",
            content_type=ContentType.SYSTEM,
            metadata_={
                "kind": "thread_started",
                "thread_room_id": str(room.id),
                "thread_title": display,
            },
        )
        self._db.add(system_message)
        # A new thread is activity on the parent: float it in the sidebar.
        parent.updated_at = datetime.now(timezone.utc)

        await self._db.commit()
        await self._db.refresh(room)
        logger.info(
            "thread_created",
            room_id=str(room.id),
            parent_room_id=str(parent.id),
            parent_type=parent.room_type.value,
            seeded=len(member_ids),
            from_seed=seed is not None,
        )
        return ThreadCreation(
            room=room,
            system_message=system_message,
            seed_message=seed_message,
            member_ids=member_ids,
        )

    async def list_threads(
        self, parent_id: uuid.UUID, *, include_archived: bool = False
    ) -> list[Room]:
        stmt = select(Room).where(Room.parent_room_id == parent_id)
        if not include_archived:
            stmt = stmt.where(Room.is_archived == False)  # noqa: E712
        stmt = stmt.order_by(Room.updated_at.desc())
        return list((await self._db.execute(stmt)).scalars().all())

    async def set_member_settings(
        self,
        *,
        room_id: uuid.UUID,
        actor_id: uuid.UUID | None,
        target_participant_id: uuid.UUID,
        agent_mode: str | None = None,
        context_depth: int | None = None,
        actor_is_controller: bool = False,
    ) -> RoomMember:
        """Set an agent member's ``agent_mode`` and/or any member's
        ``context_depth``. Owner/admin, or a room-control gateway key
        (``actor_is_controller``)."""
        if not actor_is_controller:
            if actor_id is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized")
            await self._require_role(room_id, actor_id, ["owner", "admin"])
        membership = await self._get_membership(room_id, target_participant_id)
        if membership is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
        if agent_mode is not None:
            if agent_mode not in AGENT_MODES:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Invalid agent_mode: {agent_mode}",
                )
            participant = (
                await self._db.execute(select(Participant).where(Participant.id == target_participant_id))
            ).scalar_one_or_none()
            if participant is None or participant.participant_type != ParticipantType.AGENT:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="agent_mode applies to agent members only",
                )
            membership.agent_mode = agent_mode
        if context_depth is not None:
            membership.context_depth = None if context_depth == 0 else int(context_depth)
        await self._db.commit()
        await self._db.refresh(membership)
        logger.info(
            "member_settings_updated",
            room_id=str(room_id),
            participant_id=str(target_participant_id),
            agent_mode=membership.agent_mode,
            context_depth=membership.context_depth,
        )
        return membership

    async def _hub_voice_defaults(self, human_id: uuid.UUID, agent_id: str) -> dict[str, Any]:
        """Voice settings a NEW hub starts with (L2 item 1): the relay speaks
        the human's lines (``voice_relay_source`` = their username), the agent
        answers everything said (``voice_relay_activation = always``) and wears
        its preset voice from the server TTS preset table
        (``api/tts.AGENT_VOICES``). Keys match ``webhooks._VOICE_META_KEYS`` so
        they reach the LiveKit room metadata the workers read."""
        username = (
            await self._db.execute(select(Participant.username).where(Participant.id == human_id))
        ).scalar_one_or_none()
        meta: dict[str, Any] = {
            "voice_relay_agent_id": agent_id,
            "voice_primary_agent_id": agent_id,
            "voice_relay_activation": "always",
        }
        if isinstance(username, str) and username.strip():
            meta["voice_relay_source"] = username.strip()
        voice: str | None = None
        try:
            from app.api.tts import resolve_agent_voice

            voice = resolve_agent_voice(agent_id)
        except Exception:  # pragma: no cover - the preset table is static
            logger.warning("hub_voice_preset_lookup_failed", agent_id=agent_id, exc_info=True)
        if voice:
            meta["voice_relay_voices"] = {agent_id: voice}
        return meta

    async def thread_member_ids(self, room_id: uuid.UUID) -> list[uuid.UUID]:
        rows = await self._db.execute(
            select(RoomMember.participant_id).where(RoomMember.room_id == room_id)
        )
        return [pid for (pid,) in rows.all()]

    # ------------------------------------------------------------------
    # Project channels (design §3, L2 item 5)
    # ------------------------------------------------------------------

    async def ensure_project_channel(
        self,
        *,
        creator_id: uuid.UUID,
        project_number: str,
        project: Mapping[str, Any],
        org_id: str | None = None,
    ) -> tuple[Room, bool]:
        """Find-or-create THE private channel bound to ``project_number``.

        Slug ``p-<number>-<slug>``, display ``P-00115 · <title>``, visibility
        private, creator OWNER. A later caller for the same project joins the
        existing channel as MEMBER (the project is visible to them in the
        Project-Ops picker; the channel is where its work is discussed).
        Returns ``(room, created)``.
        """
        from app.services.project_channels import (
            normalize_project_number,
            project_channel_display_name,
            project_channel_slug,
        )

        # Bound numbers are stored canonical ("P-00115"); accept any spelling
        # here too so a service caller cannot mint a second channel for
        # "p-115".
        canonical = normalize_project_number(project_number)
        if canonical is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="project_number must look like P-00115",
            )
        project_number = canonical

        stmt = select(Room).where(
            Room.project_number == project_number,
            Room.room_type == RoomType.CHANNEL,
            Room.parent_room_id.is_(None),
            Room.is_archived == False,  # noqa: E712
        )
        if org_id is not None:
            stmt = stmt.where(or_(Room.org_id == org_id, Room.org_id.is_(None)))
        room = (
            await self._db.execute(stmt.order_by(Room.created_at.asc()).limit(1))
        ).scalars().first()

        if room is not None:
            if await self._get_membership(room.id, creator_id) is None:
                self._db.add(RoomMember(room_id=room.id, participant_id=creator_id, role=MemberRole.MEMBER))
                await self._db.commit()
                await self._db.refresh(room)
                logger.info(
                    "project_channel_joined",
                    room_id=str(room.id),
                    project_number=project_number,
                    participant_id=str(creator_id),
                )
            return room, False

        title = str(project.get("title") or project_number)
        slug = project_channel_slug(project_number, title)
        meta = {
            "project": {
                "number": project_number,
                "id": project.get("id"),
                "title": title,
                "status": project.get("status"),
                "due_date": project.get("dueDate"),
                "bound_at": datetime.now(timezone.utc).isoformat(),
            }
        }
        try:
            room = await self.create_room(
                name=slug,
                display_name=project_channel_display_name(project_number, title),
                room_type=RoomType.CHANNEL.value,
                creator_id=creator_id,
                description=f"Project channel for {project_number}",
                metadata=meta,
                org_id=org_id,
            )
        except HTTPException as exc:
            if exc.status_code != status.HTTP_409_CONFLICT:
                raise
            # A stale (archived / re-bound) channel holds the slug; channels
            # refuse silent uniquification, so pick the suffix here.
            room = await self.create_room(
                name=f"{slug[:90]}-{uuid.uuid4().hex[:6]}",
                display_name=project_channel_display_name(project_number, title),
                room_type=RoomType.CHANNEL.value,
                creator_id=creator_id,
                description=f"Project channel for {project_number}",
                metadata=meta,
                org_id=org_id,
            )
        room.visibility = "private"
        room.project_number = project_number
        await self._db.commit()
        await self._db.refresh(room)
        logger.info(
            "project_channel_created",
            room_id=str(room.id),
            project_number=project_number,
            creator=str(creator_id),
        )
        return room, True

    # ------------------------------------------------------------------
    # Group DM → private channel (design §3, L2 item 6)
    # ------------------------------------------------------------------

    async def convert_group_to_channel(
        self,
        *,
        room_id: uuid.UUID,
        actor_id: uuid.UUID,
        name: str | None = None,
        display_name: str | None = None,
        visibility: str = "private",
    ) -> Room:
        """Explicit, owner-only: a ``group_dm`` becomes a ``channel``.

        Renames (slug + label) and retypes in place — members, messages,
        calls and the LiveKit room all stay. Private by default (the group
        was private by membership; a public channel is a deliberate second
        step through PATCH visibility). Records ``metadata.converted_from``
        so the audit line and the UI can say where the channel came from.
        """
        await self._require_role(room_id, actor_id, ["owner"])
        room = (await self._db.execute(select(Room).where(Room.id == room_id))).scalar_one_or_none()
        if room is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
        if room.room_type != RoomType.GROUP_DM:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Only a group conversation can be converted to a channel",
            )
        if getattr(room, "parent_room_id", None) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A thread cannot be converted; convert its parent",
            )
        if visibility not in ROOM_VISIBILITIES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid visibility: {visibility}",
            )

        new_display = " ".join((display_name or "").split()) or room.display_name
        new_name = (name or "").strip().lower() or group_slug_base(new_display)
        if new_name.startswith(RESERVED_ROOM_NAME_PREFIX):
            # Client-supplied names only (P2-5): thread slugs and server-made
            # rooms are exempt, this one comes from the request.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Room names may not start with '{RESERVED_ROOM_NAME_PREFIX}'",
            )
        if not ROOM_SLUG_RE.fullmatch(new_name) or len(new_name) > 100:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Channel name must be lowercase letters, digits, '.', '_' or '-'",
            )
        if new_name != room.name:
            taken = (
                await self._db.execute(select(Room.id).where(Room.name == new_name, Room.id != room.id))
            ).scalar_one_or_none()
            if taken is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Room with name '{new_name}' already exists",
                )

        meta = dict(room.metadata_ or {})
        meta["converted_from"] = {
            "room_type": RoomType.GROUP_DM.value,
            "name": room.name,
            "display_name": room.display_name,
            "by": str(actor_id),
            "at": datetime.now(timezone.utc).isoformat(),
        }
        room.room_type = RoomType.CHANNEL
        room.name = new_name
        room.display_name = new_display
        room.visibility = visibility
        room.metadata_ = meta
        await self._db.commit()
        await self._db.refresh(room)
        logger.info(
            "group_converted_to_channel",
            room_id=str(room.id),
            name=new_name,
            visibility=visibility,
            by=str(actor_id),
        )
        return room

    async def join_room(
        self,
        room_id: uuid.UUID,
        participant_id: uuid.UUID,
        role: str = "member",
        self_join: bool = False,
    ) -> RoomMember:
        """Add a participant to a room.

        ``self_join`` distinguishes a user joining themselves (the public
        ``POST /rooms/{id}/join`` endpoint) from an authorized add — invite,
        agent residency, webhook bot. Only ``channel`` rooms are open to
        self-join; DMs and group DMs are invite-only, so a self-join into one
        is rejected. Internal callers (invite/agent/webhook) leave
        ``self_join`` False and may add members to any room type.
        """
        # Check room exists
        room_result = await self._db.execute(select(Room).where(Room.id == room_id))
        room = room_result.scalar_one_or_none()
        if room is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found",
            )

        # THREAD rule (design §3): a member of the parent may open any live
        # thread under it — the thread inherited the parent's type and
        # visibility, and the parent's membership is the audience. Checked
        # first so a private parent's own members are not bounced by the
        # visibility gate below; a non-member of the parent gets the same
        # uniform 403 as any private room.
        parent_member = False
        if self_join and getattr(room, "parent_room_id", None) is not None:
            parent_member = await self._get_membership(room.parent_room_id, participant_id) is not None

        # Private/invite-only gate: a user may only self-join public channels.
        # DM / group_dm / agent_hub membership comes exclusively from an invite
        # (or being the original DM counterpart), never by knowing the room
        # UUID. A PRIVATE channel (rooms.visibility, design §3) is invite-only
        # too — same uniform 403 so the response does not distinguish "exists
        # but private" from "not for you".
        if self_join and not parent_member and room.room_type != RoomType.CHANNEL:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This room is invite-only",
            )
        if self_join and not parent_member and getattr(room, "visibility", "public") == "private":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This room is invite-only",
            )

        # B6: cross-org gate. On a per-org instance a user may only self-join a
        # channel belonging to their org (or an org-less/community channel).
        # Blocks discovering + joining another org's channel by UUID. An invite
        # (self_join=False) still works cross-org for explicit collaboration.
        if self_join and not parent_member:
            from app.config import get_settings as _get_settings

            org = _get_settings().instance_org_id
            if org is not None and room.org_id is not None and str(
                room.org_id
            ) != str(org):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="This room belongs to another organization",
                )

        # Archived channels are closed to new self-joins.
        if self_join and room.is_archived:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This room is archived",
            )

        # Check not already a member
        existing = await self._db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.participant_id == participant_id,
            )
        )
        if existing.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Already a member of this room",
            )

        # Check max participants
        count_result = await self._db.execute(
            select(func.count()).select_from(RoomMember).where(RoomMember.room_id == room_id)
        )
        current_count = count_result.scalar() or 0
        if current_count >= room.max_participants:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Room is at maximum capacity",
            )

        membership = RoomMember(
            room_id=room_id,
            participant_id=participant_id,
            role=MemberRole(role),
        )
        self._db.add(membership)
        await self._db.commit()
        await self._db.refresh(membership)

        logger.info(
            "participant_joined_room",
            room_id=str(room_id),
            participant_id=str(participant_id),
        )
        return membership

    async def leave_room(
        self,
        room_id: uuid.UUID,
        participant_id: uuid.UUID,
    ) -> None:
        """Remove a participant from a room."""
        result = await self._db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.participant_id == participant_id,
            )
        )
        membership = result.scalar_one_or_none()
        if membership is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Not a member of this room",
            )

        await self._db.delete(membership)
        await self._db.commit()

        logger.info(
            "participant_left_room",
            room_id=str(room_id),
            participant_id=str(participant_id),
        )

    async def update_room(
        self,
        room_id: uuid.UUID,
        participant_id: uuid.UUID,
        display_name: str | None = None,
        description: str | None = None,
        is_archived: bool | None = None,
        metadata: dict[str, Any] | None = None,
        visibility: str | None = None,
        project_number: str | None = None,
        recording_policy: str | None = None,
        recording_kind: str | None = None,
    ) -> Room:
        """Update room details. Requires admin or owner role.

        ``metadata`` is MERGED into the room's existing metadata, and only
        allowlisted keys (CLIENT_MUTABLE_METADATA_KEYS) are applied — room
        metadata also carries server-owned facts (``brigade_agent_id``,
        ``conference``, ``dm_pair``) that a PATCH body must never stomp.
        Non-allowlisted keys are silently dropped, matching the endpoint's
        lenient contract.

        ``visibility`` applies to CHANNEL rooms only (422 otherwise);
        ``project_number`` binds a channel to a Project-Ops project (an empty
        string clears it); ``recording_policy`` / ``recording_kind`` are the
        recording contract (design §8) — stored here, enforced by the
        recording service.

        ``metadata.seats`` (Nav v3 C2 / R6: ``{"<agent_id>": {model,
        effort}}``) is the exception to the owner/admin rule: validated
        first (422), then each entry is allowed only for that seat's OWNER
        (``participants.metadata.owner``) — in any room — and refused with
        409 when that agent is not a runner seat in the room, or the room is
        archived. A PATCH that ONLY carries ``seats`` takes that path (any
        member); anything else in the body still needs owner/admin.
        """
        seats_patch = bool(metadata) and SEATS_METADATA_KEY in metadata
        seats_value: dict[str, dict[str, str | None]] | None = None
        if seats_patch:
            try:
                seats_value = validate_seats_setting(metadata[SEATS_METADATA_KEY])
            except SeatSettingError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=str(exc),
                ) from None
        other_changes = any(
            value is not None
            for value in (
                display_name,
                description,
                is_archived,
                visibility,
                project_number,
                recording_policy,
                recording_kind,
            )
        ) or bool(metadata and set(metadata) - {SEATS_METADATA_KEY})

        if other_changes or not seats_patch:
            membership = await self._require_role(room_id, participant_id, ["owner", "admin"])
        else:
            membership = await self._get_membership(room_id, participant_id)
            if membership is None:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Not a member of this room",
                )

        result = await self._db.execute(select(Room).where(Room.id == room_id))
        room = result.scalar_one_or_none()
        if room is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found",
            )

        if seats_patch:
            await self._authorize_seats_setting(room, membership, seats_value or {})

        if display_name is not None:
            room.display_name = display_name
        if description is not None:
            room.description = description
        if is_archived is not None:
            room.is_archived = is_archived
            if getattr(room, "parent_room_id", None) is not None:
                # Threads carry their archive time so a later message can
                # unarchive them (services/room_archive.py); reassigned, not
                # mutated, for JSONB change detection.
                from app.services.room_archive import THREAD_ARCHIVED_AT_KEY, archive_stamp

                stamped = dict(room.metadata_ or {})
                if is_archived:
                    stamped.update(archive_stamp(datetime.now(timezone.utc), "manual"))
                else:
                    stamped.pop(THREAD_ARCHIVED_AT_KEY, None)
                room.metadata_ = stamped
        if visibility is not None:
            if visibility not in ROOM_VISIBILITIES:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Invalid visibility: {visibility}",
                )
            if room.room_type != RoomType.CHANNEL:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Only channels have a visibility; DMs, groups and hubs are private by membership",
                )
            room.visibility = visibility
        if project_number is not None:
            cleaned = project_number.strip()
            room.project_number = cleaned or None
        if recording_policy is not None:
            if recording_policy not in RECORDING_POLICIES:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Invalid recording_policy: {recording_policy}",
                )
            room.recording_policy = recording_policy
        if recording_kind is not None:
            if recording_kind not in RECORDING_KINDS:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Invalid recording_kind: {recording_kind}",
                )
            room.recording_kind = recording_kind
        if metadata:
            allowed = {
                k: v
                for k, v in metadata.items()
                if k in CLIENT_MUTABLE_METADATA_KEYS
            }
            if seats_patch:
                # Per-seat merge of the validated, normalised form — never the
                # raw client value, and never another owner's entry.
                existing = (room.metadata_ or {}).get(SEATS_METADATA_KEY)
                existing = existing if isinstance(existing, dict) else {}
                allowed[SEATS_METADATA_KEY] = {**existing, **(seats_value or {})}
            if allowed:
                # Reassign (never mutate in place) so SQLAlchemy's JSONB
                # change detection sees the update.
                merged = dict(room.metadata_ or {})
                merged.update(allowed)
                room.metadata_ = merged

        await self._db.commit()
        await self._db.refresh(room)

        logger.info("room_updated", room_id=str(room_id))
        return room

    async def _authorize_seats_setting(
        self, room: Room, membership: RoomMember, seats: dict[str, Any]
    ) -> None:
        """R6's gate for ``metadata.seats``, in the design's ladder (422 →
        403 → 409): the caller must be each seat's OWNER
        (``participants.metadata.owner``) — 403 otherwise, whoever owns the
        room — judged from the member row when the seat is in the room and
        from the seat's own row when it is not; then the seat must be a
        runner seat that is a member of a live room (409 otherwise)."""
        from app.services.agent_access import owned_seat_owners

        caller = getattr(membership, "participant", None)
        me = norm_username(getattr(caller, "username", None))
        seats_in_room: dict[str, Any] = {}
        for member in getattr(room, "members", None) or []:
            participant = getattr(member, "participant", None)
            if participant is None or not is_runner_seat(participant):
                continue
            agent_id = agent_id_of_sub(getattr(participant, "keycloak_sub", None))
            if agent_id:
                seats_in_room[agent_id] = participant

        def refuse_not_owner(agent_id: str) -> HTTPException:
            return HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Only the owner of '{agent_id}' can set that seat's model "
                    "and effort — ask the seat's owner"
                ),
            )

        for agent_id in seats:
            seat = seats_in_room.get(agent_id)
            if seat is not None:
                if me is None or me not in seat_owners(seat):
                    raise refuse_not_owner(agent_id)
                continue
            owners = await owned_seat_owners(self._db, agent_id)
            if owners and (me is None or me not in owners):
                raise refuse_not_owner(agent_id)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"'{agent_id}' is not a runner seat in this room",
            )
        if bool(getattr(room, "is_archived", False)):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This room is archived",
            )

    async def archive_room(
        self,
        room_id: uuid.UUID,
        participant_id: uuid.UUID,
    ) -> Room:
        """Archive a room. Requires owner role."""
        await self._require_role(room_id, participant_id, ["owner"])
        return await self.update_room(room_id, participant_id, is_archived=True)

    async def add_resident_agents(
        self,
        room_id: uuid.UUID,
        agent_participant_ids: list[uuid.UUID],
    ) -> list[RoomMember]:
        """Add persistent agents to a room."""
        memberships: list[RoomMember] = []
        for agent_id in agent_participant_ids:
            # Verify this is actually an agent
            result = await self._db.execute(
                select(Participant).where(
                    Participant.id == agent_id,
                    Participant.participant_type == ParticipantType.AGENT,
                )
            )
            agent = result.scalar_one_or_none()
            if agent is None:
                logger.warning("skip_non_agent_participant", participant_id=str(agent_id))
                continue

            # Check if already a member
            existing = await self._db.execute(
                select(RoomMember).where(
                    RoomMember.room_id == room_id,
                    RoomMember.participant_id == agent_id,
                )
            )
            if existing.scalar_one_or_none() is not None:
                continue

            membership = RoomMember(
                room_id=room_id,
                participant_id=agent_id,
                role=MemberRole.MEMBER,
            )
            self._db.add(membership)
            memberships.append(membership)

        if memberships:
            await self._db.commit()
            logger.info(
                "resident_agents_added",
                room_id=str(room_id),
                count=len(memberships),
            )

        return memberships

    async def get_members(
        self,
        room_id: uuid.UUID,
        caller_id: uuid.UUID | str | None = None,
    ) -> list[dict[str, Any]]:
        """Get all members of a room with their participant info.

        ``caller_id`` (the requesting participant) flags exactly one row with
        ``is_self=True`` so the client can reliably identify "me" in the list —
        the FE's Keycloak id never equals the participant UUID, so client-side
        matching isn't possible without this server-side marker. The moderation
        UI keys off it to decide whose row gets owner/admin action controls.
        """
        result = await self._db.execute(
            select(RoomMember, Participant)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(RoomMember.room_id == room_id)
            .order_by(RoomMember.joined_at.asc())
        )
        rows = result.all()

        # One presence lookup for the whole room (was N+1 inside the loop).
        online_ids = await self._presence.get_online_in_room(str(room_id))
        caller = str(caller_id) if caller_id is not None else None

        # Agents get a SECOND, different fact alongside presence: availability.
        # Presence answers "is a client connected" and is right for humans and
        # for an agent that has actually joined a call; it is meaningless for a
        # chat agent, which is invoked on demand and holds no socket. Deriving
        # an agent's dot from presence alone reports every Brigade agent
        # offline forever — as false as the `participants.status` column that
        # reported them all online forever. See services/agent_availability.py.
        agent_ids_by_participant: dict[str, str] = {}
        for _membership, participant in rows:
            if participant.participant_type != ParticipantType.AGENT:
                continue
            sub = participant.keycloak_sub or ""
            if sub.startswith("brigade:"):
                agent_ids_by_participant[str(participant.id)] = sub[len("brigade:"):]
        availability = await get_agent_availability(
            self._presence.redis, set(agent_ids_by_participant.values())
        )
        owner_names = await self._owner_display_names(
            [participant for _m, participant in rows if participant.participant_type == ParticipantType.AGENT]
        )

        members: list[dict[str, Any]] = []
        for membership, participant in rows:
            brigade_id = agent_ids_by_participant.get(str(participant.id))
            if participant.participant_type == ParticipantType.AGENT:
                # An agent with no `brigade:<id>` identity is one we have no way
                # to reach or ask about, so it is unknown — not available.
                avail, avail_reason = (
                    availability.get(brigade_id, (UNKNOWN, "not_in_brigade_roster"))
                    if brigade_id
                    else (UNKNOWN, "no_brigade_identity")
                )
            else:
                # Humans have no availability concept; `is_online` is the whole
                # truth for them. Null keeps the two ideas from bleeding into
                # each other on the wire.
                avail, avail_reason = (None, None)
            members.append({
                "id": membership.id,
                "participant_id": participant.id,
                "username": participant.username,
                "display_name": participant.display_name,
                "participant_type": participant.participant_type.value,
                "role": membership.role.value,
                "joined_at": membership.joined_at,
                "last_read_at": membership.last_read_at,
                "is_muted": membership.is_muted,
                "is_self": caller is not None and str(participant.id) == caller,
                "avatar_url": participant.avatar_url,
                "avatar_emoji": participant.avatar_emoji,
                # Presence is Redis-derived ONLY. `participants.status` is a
                # stale DB column: essentially every row is created ONLINE and
                # then never updated. Humans are seeded ONLINE on first auth
                # (deps.py, _auto_provision) and agents are seeded ONLINE at
                # creation (agent_chat_responder / facilitator / gateway /
                # internal_artifacts); the only runtime mutation anywhere is the
                # LiveKit call webhook. So falling back to this column here made
                # every participant who had ever authenticated — human or agent —
                # report "online" forever, not just agents. Redis is the single
                # source of truth for "is this participant connected right now".
                #
                # NB: the column is still load-bearing elsewhere and is still
                # wrong there — push_service mention targeting filters on
                # `status != ONLINE`, which selects almost nobody. Out of scope
                # here; fixing it is a separate change to push targeting.
                "is_online": str(participant.id) in online_ids,
                "status": "online" if str(participant.id) in online_ids else "offline",
                # Agents only (null for humans). "available" | "unavailable" |
                # "unknown" — never inferred from `is_online`, which is why an
                # agent can be available without being connected, and connected
                # (in a call) without Brigade having it enabled.
                "availability": avail,
                "availability_reason": avail_reason,
                # Nav v3: the seat's standing in this room (the Mode popover)
                # and a GUEST-SAFE metadata subset for the roster marks —
                # kind / backend / owner / owner_display_name and nothing
                # else. Humans and guests carry none.
                "agent_mode": getattr(membership, "agent_mode", None),
                "context_depth": getattr(membership, "context_depth", None),
                "metadata": (
                    self._member_metadata_subset(participant, owner_names)
                    if participant.participant_type == ParticipantType.AGENT
                    else None
                ),
            })

        return members

    @staticmethod
    def _member_metadata_subset(
        participant: Participant, owner_names: dict[str, str]
    ) -> dict[str, Any]:
        """``{kind, backend, owner, owner_display_name}`` of an agent member
        — the four facts the web roster marks need, never the whole JSONB
        (which carries seat capabilities, avatar overrides, …)."""
        meta = participant.metadata_ if isinstance(participant.metadata_, dict) else {}
        owner = seat_owner(participant)
        return {
            "kind": participant_kind(participant),
            "backend": participant_backend(participant) if meta.get("backend") is not None else None,
            "owner": owner,
            "owner_display_name": owner_names.get(owner) if owner else None,
        }

    async def _owner_display_names(self, agents: list[Participant]) -> dict[str, str]:
        """``{owner username: display_name}`` for every owner named by the
        given agent rows — one query, none when no seat is owned."""
        owners: set[str] = set()
        for participant in agents:
            owners |= set(seat_owners(participant))
        if not owners:
            return {}
        rows = (
            await self._db.execute(
                select(Participant.username, Participant.display_name).where(
                    Participant.participant_type == ParticipantType.HUMAN,
                    func.lower(Participant.username).in_(sorted(owners)),
                )
            )
        ).all()
        return {
            (norm_username(username) or ""): display_name
            for username, display_name in rows
            if username
        }

    async def _require_role(
        self,
        room_id: uuid.UUID,
        participant_id: uuid.UUID,
        roles: list[str],
    ) -> RoomMember:
        """Verify the participant has one of the required roles in the room."""
        result = await self._db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.participant_id == participant_id,
            )
        )
        membership = result.scalar_one_or_none()
        if membership is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this room",
            )
        if membership.role.value not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of roles: {', '.join(roles)}",
            )
        return membership

    # ------------------------------------------------------------------
    # Moderation: per-room member management (remove / role / mute)
    # ------------------------------------------------------------------
    #
    # Authorization model (per-room, mirrors the existing OWNER/ADMIN ladder):
    #   * owner  — full control; the only role that can grant/revoke roles.
    #   * admin  — can remove/mute MEMBERs and GUESTs, but not owners or other
    #              admins (no peer/superior moderation).
    #   * member/guest — no moderation.
    # Invariants enforced here, not in the API layer, so every caller is safe:
    #   * a room always keeps at least one owner (can't remove/demote the last);
    #   * you can't moderate yourself through these paths (use leave_room).

    async def _get_membership(
        self, room_id: uuid.UUID, participant_id: uuid.UUID | str
    ) -> RoomMember | None:
        return (
            await self._db.execute(
                select(RoomMember).where(
                    RoomMember.room_id == room_id,
                    RoomMember.participant_id == participant_id,
                )
            )
        ).scalar_one_or_none()

    async def _count_owners(self, room_id: uuid.UUID) -> int:
        return int(
            (
                await self._db.execute(
                    select(func.count())
                    .select_from(RoomMember)
                    .where(
                        RoomMember.room_id == room_id,
                        RoomMember.role == MemberRole.OWNER,
                    )
                )
            ).scalar_one()
        )

    def _assert_can_target(
        self, actor: RoomMember, target: RoomMember, action: str
    ) -> None:
        """An admin may not act on an owner or another admin; only owners can."""
        if actor.role != MemberRole.OWNER and target.role in (
            MemberRole.OWNER,
            MemberRole.ADMIN,
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Only an owner can {action} an admin or owner",
            )

    async def remove_member(
        self,
        room_id: uuid.UUID,
        actor_id: uuid.UUID | str,
        target_id: uuid.UUID | str,
    ) -> dict[str, Any]:
        """Remove (kick) a member. Returns info for live fanout / LiveKit."""
        actor = await self._require_role(room_id, actor_id, ["owner", "admin"])
        if str(actor_id) == str(target_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Use leave to remove yourself from a room",
            )
        target = await self._get_membership(room_id, target_id)
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="That participant is not a member of this room",
            )
        self._assert_can_target(actor, target, "remove")
        if target.role == MemberRole.OWNER and await self._count_owners(room_id) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Can't remove the last owner — assign another owner first",
            )

        # Grab what we need for LiveKit eviction before deleting the row.
        room = (
            await self._db.execute(select(Room).where(Room.id == room_id))
        ).scalar_one_or_none()
        participant = (
            await self._db.execute(
                select(Participant).where(Participant.id == target_id)
            )
        ).scalar_one_or_none()

        await self._db.delete(target)
        await self._db.commit()

        # Best-effort: evict from the live LiveKit room too. Identity matches
        # the token format in api/tokens.py: "{username}_{participant_id}".
        if room is not None and participant is not None:
            try:
                identity = f"{participant.username}_{participant.id}"
                await self._livekit.remove_participant(
                    room.livekit_room_name, identity
                )
            except Exception:  # noqa: BLE001 — eviction is best-effort
                logger.warning(
                    "livekit_evict_failed",
                    room_id=str(room_id),
                    participant_id=str(target_id),
                    exc_info=True,
                )

        logger.info(
            "member_removed",
            room_id=str(room_id),
            actor=str(actor_id),
            target=str(target_id),
        )
        return {
            "participant_id": str(target_id),
            "livekit_room_name": room.livekit_room_name if room else None,
        }

    async def set_member_role(
        self,
        room_id: uuid.UUID,
        actor_id: uuid.UUID | str,
        target_id: uuid.UUID | str,
        new_role: MemberRole,
    ) -> RoomMember:
        """Change a member's role. Owner-only."""
        await self._require_role(room_id, actor_id, ["owner"])
        target = await self._get_membership(room_id, target_id)
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="That participant is not a member of this room",
            )
        if target.role == new_role:
            return target
        # Don't strip the last owner of ownership and orphan the room.
        if (
            target.role == MemberRole.OWNER
            and new_role != MemberRole.OWNER
            and await self._count_owners(room_id) <= 1
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Can't demote the last owner — promote another owner first",
            )
        target.role = new_role
        await self._db.commit()
        await self._db.refresh(target)
        logger.info(
            "member_role_changed",
            room_id=str(room_id),
            actor=str(actor_id),
            target=str(target_id),
            new_role=new_role.value,
        )
        return target

    async def set_member_mute(
        self,
        room_id: uuid.UUID,
        actor_id: uuid.UUID | str,
        target_id: uuid.UUID | str,
        is_muted: bool,
    ) -> RoomMember:
        """Mute/unmute a member (blocks them from posting). Owner/admin."""
        actor = await self._require_role(room_id, actor_id, ["owner", "admin"])
        if str(actor_id) == str(target_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You can't mute yourself",
            )
        target = await self._get_membership(room_id, target_id)
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="That participant is not a member of this room",
            )
        self._assert_can_target(actor, target, "mute")
        target.is_muted = is_muted
        await self._db.commit()
        await self._db.refresh(target)
        logger.info(
            "member_mute_changed",
            room_id=str(room_id),
            actor=str(actor_id),
            target=str(target_id),
            is_muted=is_muted,
        )
        return target
