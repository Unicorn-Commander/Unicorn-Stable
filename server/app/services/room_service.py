from __future__ import annotations

import uuid
from typing import Any

import structlog
from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent import AgentConfig
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import MemberRole, Room, RoomMember, RoomType
from app.services.livekit_service import LiveKitService
from app.services.presence_service import PresenceService

logger = structlog.get_logger(__name__)


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
    ) -> Room:
        """Create a new room in the database and LiveKit."""
        # Check for duplicate name
        existing = await self._db.execute(
            select(Room).where(Room.name == name)
        )
        if existing.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Room with name '{name}' already exists",
            )

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

        # Enrich rooms with member and online counts
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

    async def get_members(self, room_id: uuid.UUID) -> list[dict[str, Any]]:
        """Get all members of a room with their participant info."""
        result = await self._db.execute(
            select(RoomMember, Participant)
            .join(Participant, Participant.id == RoomMember.participant_id)
            .where(RoomMember.room_id == room_id)
            .order_by(RoomMember.joined_at.asc())
        )
        rows = result.all()

        members: list[dict[str, Any]] = []
        for membership, participant in rows:
            online_ids = await self._presence.get_online_in_room(str(room_id))
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
                "status": "online" if str(participant.id) in online_ids else participant.status.value,
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
