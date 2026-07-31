from __future__ import annotations

import uuid
from typing import Any

import structlog
from fastapi import HTTPException, status
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.agent import AgentConfig
from app.models.message import Message
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import MemberRole, Room, RoomMember, RoomType
from app.services.agent_availability import UNKNOWN, get_agent_availability
from app.services.livekit_service import LiveKitService
from app.services.presence_service import PresenceService

logger = structlog.get_logger(__name__)


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
        return True

    def _agent_member_room_ids(self):
        """Subquery of room ids that currently have any agent member."""
        return (
            select(RoomMember.room_id)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(Participant.participant_type == ParticipantType.AGENT)
        )

    def _accept_human_dm_candidate(self, room: Room | None) -> Room | None:
        """Metadata + type gate (no extra round-trip). Agent members filtered in SQL."""
        if room is None:
            return None
        if room.room_type != RoomType.DM or room.is_archived:
            return None
        if not self._is_pure_human_dm_room(room):
            return None
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
        """Locate an existing true 1:1 *human-only* DM for this pair, if any."""
        # 1. Canonical metadata key (post-ensure rooms + backfilled legacy).
        agent_rooms = self._agent_member_room_ids()
        by_pair = (
            await self._db.execute(
                select(Room).where(
                    Room.room_type == RoomType.DM,
                    Room.is_archived == False,  # noqa: E712
                    Room.metadata_["dm_pair"].astext == pair_key,
                    Room.id.notin_(agent_rooms),
                )
            )
        ).scalar_one_or_none()
        accepted = self._accept_human_dm_candidate(by_pair)
        if accepted is not None:
            return accepted
        if by_pair is not None:
            # Pair key was stamped on an agent-tainted room — free the key so a
            # clean ensure can create (or find) a pure human DM.
            await self._clear_stale_dm_pair(by_pair, pair_key)

        # 2. Deterministic slug (unique rooms.name).
        by_name = (
            await self._db.execute(
                select(Room).where(
                    Room.name == slug,
                    Room.id.notin_(agent_rooms),
                )
            )
        ).scalar_one_or_none()
        accepted = self._accept_human_dm_candidate(by_name)
        if accepted is not None:
            return accepted

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
    ) -> dict[str, Any]:
        """List rooms the user is a member of, with pagination."""
        query = (
            select(Room)
            .join(RoomMember, RoomMember.room_id == Room.id)
            .where(
                RoomMember.participant_id == participant_id,
                Room.is_archived == False,  # noqa: E712
            )
            .order_by(Room.updated_at.desc())
        )

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

        # Get total count
        count_query = (
            select(func.count())
            .select_from(RoomMember)
            .where(RoomMember.participant_id == participant_id)
            .join(Room, Room.id == RoomMember.room_id)
            .where(Room.is_archived == False)  # noqa: E712
        )
        total_result = await self._db.execute(count_query)
        total = total_result.scalar() or 0

        # Batch the conversation-list extras for the whole page in two queries
        # (avoids an N+1 and lets the sidebar/home feed show previews + unread
        # badges on cold load). Keyed by str(room_id) so UUID vs str column
        # typing can't cause a lookup miss.
        room_ids = [room.id for room in rooms]
        last_msg_by_room: dict[str, Message] = {}
        unread_by_room: dict[str, int] = {}
        if room_ids:
            # Latest non-deleted message per room (Postgres DISTINCT ON; the
            # leading ORDER BY column must match the DISTINCT column).
            lm_rows = await self._db.execute(
                select(Message)
                .where(
                    Message.room_id.in_(room_ids),
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
                    Message.room_id.in_(room_ids),
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

        # Enrich rooms with member/online counts + conversation-list extras
        enriched_rooms: list[dict[str, Any]] = []
        for room in rooms:
            mc_result = await self._db.execute(
                select(func.count()).select_from(RoomMember).where(RoomMember.room_id == room.id)
            )
            mc = mc_result.scalar() or 0
            online_ids = await self._presence.get_online_in_room(str(room.id))
            enriched_rooms.append({
                "room": room,
                "member_count": mc,
                "online_count": len(online_ids),
                "last_message": last_msg_by_room.get(str(room.id)),
                "unread_count": unread_by_room.get(str(room.id), 0),
            })

        return {
            "rooms": enriched_rooms,
            "total": total,
            "cursor": next_cursor,
        }

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

        # Private/invite-only gate: a user may only self-join public channels.
        # DM / group_dm membership comes exclusively from an invite (or being
        # the original DM counterpart), never by knowing the room UUID.
        if self_join and room.room_type != RoomType.CHANNEL:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This room is invite-only",
            )

        # B6: cross-org gate. On a per-org instance a user may only self-join a
        # channel belonging to their org (or an org-less/community channel).
        # Blocks discovering + joining another org's channel by UUID. An invite
        # (self_join=False) still works cross-org for explicit collaboration.
        if self_join:
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
    ) -> Room:
        """Update room details. Requires admin or owner role."""
        await self._require_role(room_id, participant_id, ["owner", "admin"])

        result = await self._db.execute(select(Room).where(Room.id == room_id))
        room = result.scalar_one_or_none()
        if room is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found",
            )

        if display_name is not None:
            room.display_name = display_name
        if description is not None:
            room.description = description
        if is_archived is not None:
            room.is_archived = is_archived

        await self._db.commit()
        await self._db.refresh(room)

        logger.info("room_updated", room_id=str(room_id))
        return room

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
            })

        return members

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
