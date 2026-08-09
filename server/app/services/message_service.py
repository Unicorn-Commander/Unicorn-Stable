from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import HTTPException, status
from sqlalchemy import Text, cast as sa_cast, desc, func, or_, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.message import ContentType, Message
from app.models.participant import Participant
from app.models.room import Room, RoomMember
from app.models.activity import ActivityEvent, ActivityEventType
from app.services.livekit_service import LiveKitService
from app.services.mentions import parse_mentions

logger = structlog.get_logger(__name__)

# `has:` operator values that mean "message carries attachments". Attachments
# have no column of their own — they live in messages.metadata['attachments']
# (see uploads.py) — so this is the only `has:` fact the server can answer.
# Anything else (`has:link`, typos, …) is ignored, per the lenient operator
# contract: an unknown value drops that filter, it never 422s/500s.
_HAS_ATTACHMENT_VALUES = frozenset({"file", "files", "attachment", "attachments"})


def parse_operator_date(value: str | None) -> datetime | None:
    """Lenient ISO-8601 parse for the before:/after: search operators.

    Returns an aware datetime (naive input is taken as UTC) or None for
    anything unparseable — operator filters degrade to "not applied", they
    never error out the whole search.
    """
    if not value or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def build_search_operator_filters(
    *,
    from_sender: str | None = None,
    in_room: str | None = None,
    has: str | None = None,
    before: str | None = None,
    after: str | None = None,
) -> list[Any]:
    """SQLAlchemy filter clauses for the chip search operators.

    Shared by the per-room and global search paths; every input is untrusted
    free text from the client's operator parser, so each filter validates
    leniently and simply drops itself when the value is unusable.

    - ``from_sender``: case-insensitive substring on the sender's
      display_name or username (leading ``@`` stripped).
    - ``in_room``: case-insensitive substring on room name/display_name
      (leading ``#`` stripped). Global search only — the per-room endpoint
      never passes it (the room is already fixed).
    - ``has``: attachment presence for file/attachment values.
    - ``before``/``after``: ISO dates against created_at (before is
      exclusive; after with a bare date means "from that day's midnight UTC").
    """
    conds: list[Any] = []

    if from_sender and from_sender.strip().lstrip("@"):
        needle = from_sender.strip().lstrip("@")
        like = f"%{needle}%"
        sender_ids = select(Participant.id).where(
            or_(
                Participant.display_name.ilike(like),
                Participant.username.ilike(like),
            )
        )
        conds.append(Message.sender_id.in_(sender_ids))

    if in_room and in_room.strip().lstrip("#"):
        needle = in_room.strip().lstrip("#")
        like = f"%{needle}%"
        room_ids = select(Room.id).where(
            or_(
                Room.name.ilike(like),
                Room.display_name.ilike(like),
            )
        )
        conds.append(Message.room_id.in_(room_ids))

    if has and has.strip().lower() in _HAS_ATTACHMENT_VALUES:
        # Explicit `->` (not Python subscript) so the rendered SQL is the
        # arrow operator on every Postgres version, not PG14+ subscripting.
        attachments = Message.metadata_.op("->")("attachments")
        # Both clauses are NULL-safe in any evaluation order (jsonb_typeof of
        # a missing key is NULL) — never jsonb_array_length, which raises on
        # non-arrays and Postgres does not guarantee AND short-circuit order.
        conds.append(func.jsonb_typeof(attachments) == "array")
        conds.append(attachments != sa_cast("[]", JSONB))

    before_dt = parse_operator_date(before)
    if before_dt is not None:
        conds.append(Message.created_at < before_dt)

    after_dt = parse_operator_date(after)
    if after_dt is not None:
        conds.append(Message.created_at > after_dt)

    return conds


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
        membership = membership_result.scalar_one_or_none()
        if membership is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this room",
            )
        # A muted member can read but not post (per-room moderation). Enforced
        # here so every send path — HTTP and the internal agent reply — honors
        # it; the API/UI also surfaces it, but this is the authoritative gate.
        if membership.is_muted:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You've been muted in this room and can't post right now.",
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
        # Flush first: activity rows have a real message FK and the mention
        # counters/event index must commit with the message, never after it.
        await self._db.flush()

        lower_content = (content or "").casefold()
        member_rows = (
            await self._db.execute(
                select(RoomMember, Participant).join(
                    Participant, Participant.id == RoomMember.participant_id
                ).where(RoomMember.room_id == room_id)
            )
        ).all()
        # Broadcast detection is token-based (services/mentions.py), shared
        # with the push/email fan-outs so every surface agrees. Both @channel
        # and @here badge every member: the inbox is a durable catch-up
        # surface (@here's online-only scope applies to the offline push and
        # email channels, which mentions.py documents).
        parsed_mentions = parse_mentions(content)
        broad = parsed_mentions.broadcast
        for member, participant in member_rows:
            if str(member.participant_id) == str(sender_id):
                continue
            names = (f"@{participant.username}".casefold(), f"@{participant.display_name}".casefold())
            if broad or any(name in lower_content for name in names):
                member.mention_count += 1
                member.has_unread_mention = True
                self._db.add(ActivityEvent(
                    participant_id=member.participant_id,
                    room_id=room_id,
                    message_id=message.id,
                    actor_id=sender_id,
                    event_type=ActivityEventType.MENTION,
                ))

        if parent_id is not None:
            parent = (await self._db.execute(select(Message).where(Message.id == parent_id))).scalar_one()
            if parent.sender_id is not None and str(parent.sender_id) != str(sender_id):
                self._db.add(ActivityEvent(
                    participant_id=parent.sender_id, room_id=room_id,
                    message_id=message.id, actor_id=sender_id,
                    event_type=ActivityEventType.THREAD,
                ))
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
            select(Room.livekit_room_name, Room.room_type).where(Room.id == room_id)
        )
        room_row = room_result.one_or_none()
        lk_room_name = room_row[0] if room_row else None
        room_type_str = room_row[1].value if room_row and room_row[1] else "channel"

        if lk_room_name:
            broad_mention = parsed_mentions.broad_kind
            broadcast_data = {
                "type": "new_message",
                "room_type": room_type_str,
                "broad_mention": broad_mention,
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
        from_sender: str | None = None,
        has: str | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> list[Message]:
        """Full-text search on messages using pg_trgm.

        The optional operator filters (from:/has:/before:/after: chips) narrow
        the same query; unusable values drop their filter (see
        build_search_operator_filters). No ``in:`` here — the room is fixed.
        """
        if not query_text.strip():
            return []

        # Use pg_trgm similarity search
        query = (
            select(Message)
            .where(
                Message.room_id == room_id,
                Message.is_deleted == False,  # noqa: E712
                Message.content.ilike(f"%{query_text}%"),
                *build_search_operator_filters(
                    from_sender=from_sender,
                    has=has,
                    before=before,
                    after=after,
                ),
            )
            .order_by(desc(Message.created_at))
            .limit(limit)
        )

        result = await self._db.execute(query)
        return list(result.scalars().all())

    async def search_all_messages(
        self,
        participant_id: uuid.UUID,
        query_text: str,
        limit: int = 30,
        from_sender: str | None = None,
        in_room: str | None = None,
        has: str | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> list[Message]:
        """Full-text search across every room the participant belongs to.

        Scoped to the caller's room memberships so results never leak from
        rooms the user is not in. Reuses the ``ix_messages_content_trgm`` GIN
        index that backs the per-room search. The operator filters
        (from:/in:/has:/before:/after: chips) only ever narrow within that
        membership scope — ``in:`` intersects with it, never widens it.
        """
        if not query_text.strip():
            return []

        member_subq = select(RoomMember.room_id).where(
            RoomMember.participant_id == participant_id
        )
        query = (
            select(Message)
            .where(
                Message.room_id.in_(member_subq),
                Message.is_deleted == False,  # noqa: E712
                Message.content.ilike(f"%{query_text}%"),
                *build_search_operator_filters(
                    from_sender=from_sender,
                    in_room=in_room,
                    has=has,
                    before=before,
                    after=after,
                ),
            )
            .order_by(desc(Message.created_at))
            .limit(limit)
        )

        result = await self._db.execute(query)
        return list(result.scalars().all())
