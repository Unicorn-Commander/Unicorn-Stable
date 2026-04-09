from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import HTTPException, status
from sqlalchemy import Text, desc, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.message import ContentType, Message
from app.models.participant import Participant
from app.models.room import RoomMember
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)


class MessageService:
    """Business logic for message operations."""

    def __init__(
        self,
        db: AsyncSession,
        livekit: LiveKitService,
    ) -> None:
        self._db = db
        self._livekit = livekit

    async def send_message(
        self,
        room_id: uuid.UUID,
        sender_id: uuid.UUID,
        content: str,
        content_type: str = "text",
        metadata: dict | None = None,
        parent_id: uuid.UUID | None = None,
    ) -> Message:
        """Persist a message and broadcast it via LiveKit data channel."""
        # Verify sender is a member of the room
        membership_result = await self._db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.participant_id == sender_id,
            )
        )
        if membership_result.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this room",
            )

        # If parent_id provided, verify it exists and belongs to the same room
        if parent_id is not None:
            parent_result = await self._db.execute(
                select(Message).where(
                    Message.id == parent_id,
                    Message.room_id == room_id,
                )
            )
            if parent_result.scalar_one_or_none() is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Parent message not found in this room",
                )

        message = Message(
            room_id=room_id,
            sender_id=sender_id,
            content=content,
            content_type=ContentType(content_type),
            metadata_=metadata,
            parent_id=parent_id,
        )
        self._db.add(message)
        await self._db.commit()
        await self._db.refresh(message)

        # Get sender info for broadcast
        sender_result = await self._db.execute(
            select(Participant).where(Participant.id == sender_id)
        )
        sender = sender_result.scalar_one_or_none()

        # Broadcast via LiveKit data channel
        # Look up the LiveKit room name
        from app.models.room import Room

        room_result = await self._db.execute(
            select(Room.livekit_room_name).where(Room.id == room_id)
        )
        lk_room_name = room_result.scalar_one_or_none()

        if lk_room_name:
            broadcast_data = {
                "type": "new_message",
                "message": {
                    "id": str(message.id),
                    "room_id": str(message.room_id),
                    "sender_id": str(message.sender_id) if message.sender_id else None,
                    "content": message.content,
                    "content_type": message.content_type.value,
                    "metadata": message.metadata_,
                    "parent_id": str(message.parent_id) if message.parent_id else None,
                    "is_edited": message.is_edited,
                    "is_deleted": message.is_deleted,
                    "created_at": message.created_at.isoformat(),
                    "sender": {
                        "id": str(sender.id),
                        "username": sender.username,
                        "display_name": sender.display_name,
                        "avatar_url": sender.avatar_url,
                        "participant_type": sender.participant_type.value,
                    } if sender else None,
                },
            }
            try:
                await self._livekit.send_data(lk_room_name, broadcast_data)
            except Exception:
                logger.exception("failed_to_broadcast_message", message_id=str(message.id))

        logger.info(
            "message_sent",
            message_id=str(message.id),
            room_id=str(room_id),
            sender_id=str(sender_id),
        )
        return message

    async def get_messages(
        self,
        room_id: uuid.UUID,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        """Get cursor-paginated messages for a room, newest first."""
        query = (
            select(Message)
            .where(
                Message.room_id == room_id,
                Message.is_deleted == False,  # noqa: E712
                Message.parent_id == None,  # noqa: E711 — top-level only
            )
            .order_by(desc(Message.created_at))
        )

        if cursor:
            try:
                cursor_uuid = uuid.UUID(cursor)
                cursor_msg_result = await self._db.execute(
                    select(Message.created_at).where(Message.id == cursor_uuid)
                )
                cursor_ts = cursor_msg_result.scalar_one_or_none()
                if cursor_ts:
                    query = query.where(Message.created_at < cursor_ts)
            except (ValueError, TypeError):
                pass

        query = query.limit(limit + 1)
        result = await self._db.execute(query)
        messages = list(result.scalars().all())

        has_more = len(messages) > limit
        if has_more:
            messages = messages[:limit]

        next_cursor: str | None = None
        if has_more and messages:
            next_cursor = str(messages[-1].id)

        # Enrich with reply counts
        enriched: list[dict[str, Any]] = []
        for msg in messages:
            reply_count_result = await self._db.execute(
                select(func.count())
                .select_from(Message)
                .where(
                    Message.parent_id == msg.id,
                    Message.is_deleted == False,  # noqa: E712
                )
            )
            reply_count = reply_count_result.scalar() or 0

            enriched.append({
                "message": msg,
                "reply_count": reply_count,
            })

        return {
            "messages": enriched,
            "cursor": next_cursor,
            "has_more": has_more,
        }

    async def edit_message(
        self,
        message_id: uuid.UUID,
        sender_id: uuid.UUID,
        new_content: str,
    ) -> Message:
        """Edit a message. Only the original sender can edit."""
        result = await self._db.execute(
            select(Message).where(Message.id == message_id)
        )
        message = result.scalar_one_or_none()
        if message is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Message not found",
            )

        if str(message.sender_id) != str(sender_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Can only edit your own messages",
            )

        if message.is_deleted:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot edit a deleted message",
            )

        message.content = new_content
        message.is_edited = True
        message.edited_at = datetime.now(timezone.utc)
        await self._db.commit()
        await self._db.refresh(message)

        # Broadcast edit event via LiveKit
        from app.models.room import Room

        room_result = await self._db.execute(
            select(Room.livekit_room_name).where(Room.id == message.room_id)
        )
        lk_room_name = room_result.scalar_one_or_none()
        if lk_room_name:
            try:
                await self._livekit.send_data(lk_room_name, {
                    "type": "message_edited",
                    "message_id": str(message.id),
                    "room_id": str(message.room_id),
                    "content": message.content,
                    "edited_at": message.edited_at.isoformat(),
                })
            except Exception:
                logger.exception("failed_to_broadcast_edit", message_id=str(message.id))

        logger.info("message_edited", message_id=str(message_id))
        return message

    async def delete_message(
        self,
        message_id: uuid.UUID,
        sender_id: uuid.UUID,
    ) -> Message:
        """Soft-delete a message. Only the sender or room admins can delete."""
        result = await self._db.execute(
            select(Message).where(Message.id == message_id)
        )
        message = result.scalar_one_or_none()
        if message is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Message not found",
            )

        # Check if sender is the author or a room admin/owner
        is_author = str(message.sender_id) == str(sender_id)
        if not is_author:
            admin_check = await self._db.execute(
                select(RoomMember).where(
                    RoomMember.room_id == message.room_id,
                    RoomMember.participant_id == sender_id,
                    RoomMember.role.in_(["owner", "admin"]),
                )
            )
            if admin_check.scalar_one_or_none() is None:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Cannot delete this message",
                )

        message.is_deleted = True
        await self._db.commit()
        await self._db.refresh(message)

        # Broadcast delete event
        from app.models.room import Room

        room_result = await self._db.execute(
            select(Room.livekit_room_name).where(Room.id == message.room_id)
        )
        lk_room_name = room_result.scalar_one_or_none()
        if lk_room_name:
            try:
                await self._livekit.send_data(lk_room_name, {
                    "type": "message_deleted",
                    "message_id": str(message.id),
                    "room_id": str(message.room_id),
                })
            except Exception:
                logger.exception("failed_to_broadcast_delete", message_id=str(message.id))

        logger.info("message_deleted", message_id=str(message_id))
        return message

    async def get_thread(
        self,
        parent_id: uuid.UUID,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        """Get all replies in a thread."""
        # Verify parent exists
        parent_result = await self._db.execute(
            select(Message).where(Message.id == parent_id)
        )
        parent = parent_result.scalar_one_or_none()
        if parent is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parent message not found",
            )

        query = (
            select(Message)
            .where(
                Message.parent_id == parent_id,
                Message.is_deleted == False,  # noqa: E712
            )
            .order_by(Message.created_at.asc())
        )

        if cursor:
            try:
                cursor_uuid = uuid.UUID(cursor)
                cursor_msg_result = await self._db.execute(
                    select(Message.created_at).where(Message.id == cursor_uuid)
                )
                cursor_ts = cursor_msg_result.scalar_one_or_none()
                if cursor_ts:
                    query = query.where(Message.created_at > cursor_ts)
            except (ValueError, TypeError):
                pass

        query = query.limit(limit + 1)
        result = await self._db.execute(query)
        messages = list(result.scalars().all())

        has_more = len(messages) > limit
        if has_more:
            messages = messages[:limit]

        next_cursor: str | None = None
        if has_more and messages:
            next_cursor = str(messages[-1].id)

        enriched = [{"message": msg, "reply_count": 0} for msg in messages]

        return {
            "messages": enriched,
            "cursor": next_cursor,
            "has_more": has_more,
        }

    async def search_messages(
        self,
        room_id: uuid.UUID,
        query_text: str,
        limit: int = 20,
    ) -> list[Message]:
        """Full-text search on messages using pg_trgm."""
        if not query_text.strip():
            return []

        # Use pg_trgm similarity search
        query = (
            select(Message)
            .where(
                Message.room_id == room_id,
                Message.is_deleted == False,  # noqa: E712
                Message.content.ilike(f"%{query_text}%"),
            )
            .order_by(desc(Message.created_at))
            .limit(limit)
        )

        result = await self._db.execute(query)
        return list(result.scalars().all())
