from __future__ import annotations

import uuid
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_user, get_db, get_livekit
from app.schemas.message import (
    MessageCreate,
    MessageListResponse,
    MessageResponse,
    MessageUpdate,
    SenderInfo,
)
from app.services.livekit_service import LiveKitService
from app.services.message_service import MessageService

logger = structlog.get_logger(__name__)

router = APIRouter()


def _build_message_service(
    db: AsyncSession,
    livekit: LiveKitService,
) -> MessageService:
    return MessageService(db=db, livekit=livekit)


def _msg_to_response(msg: Any, reply_count: int = 0) -> MessageResponse:
    sender_info: SenderInfo | None = None
    if msg.sender:
        sender_info = SenderInfo(
            id=msg.sender.id,
            username=msg.sender.username,
            display_name=msg.sender.display_name,
            avatar_url=msg.sender.avatar_url,
            participant_type=msg.sender.participant_type.value,
        )

    return MessageResponse(
        id=msg.id,
        room_id=msg.room_id,
        sender_id=msg.sender_id,
        content=msg.content,
        content_type=msg.content_type.value,
        metadata_=msg.metadata_,
        parent_id=msg.parent_id,
        is_edited=msg.is_edited,
        edited_at=msg.edited_at,
        is_deleted=msg.is_deleted,
        created_at=msg.created_at,
        sender=sender_info,
        reply_count=reply_count,
    )


@router.post(
    "/rooms/{room_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    room_id: uuid.UUID,
    body: MessageCreate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Send a message to a room."""
    svc = _build_message_service(db, livekit)
    msg = await svc.send_message(
        room_id=room_id,
        sender_id=user["participant_id"],
        content=body.content,
        content_type=body.content_type,
        metadata=body.metadata,
        parent_id=body.parent_id,
    )
    return _msg_to_response(msg)


@router.get("/rooms/{room_id}/messages", response_model=MessageListResponse)
async def get_messages(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
) -> MessageListResponse:
    """Get cursor-paginated messages for a room (newest first)."""
    svc = _build_message_service(db, livekit)
    result = await svc.get_messages(
        room_id=room_id,
        cursor=cursor,
        limit=limit,
    )
    messages = [
        _msg_to_response(item["message"], item["reply_count"])
        for item in result["messages"]
    ]
    return MessageListResponse(
        messages=messages,
        cursor=result["cursor"],
        has_more=result["has_more"],
    )


@router.patch("/messages/{message_id}", response_model=MessageResponse)
async def edit_message(
    message_id: uuid.UUID,
    body: MessageUpdate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Edit a message. Only the sender can edit."""
    svc = _build_message_service(db, livekit)
    msg = await svc.edit_message(
        message_id=message_id,
        sender_id=user["participant_id"],
        new_content=body.content,
    )
    return _msg_to_response(msg)


@router.delete("/messages/{message_id}", response_model=MessageResponse)
async def delete_message(
    message_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Soft-delete a message."""
    svc = _build_message_service(db, livekit)
    msg = await svc.delete_message(
        message_id=message_id,
        sender_id=user["participant_id"],
    )
    return _msg_to_response(msg)


@router.get("/messages/{message_id}/thread", response_model=MessageListResponse)
async def get_thread(
    message_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
) -> MessageListResponse:
    """Get thread replies under a parent message."""
    svc = _build_message_service(db, livekit)
    result = await svc.get_thread(
        parent_id=message_id,
        cursor=cursor,
        limit=limit,
    )
    messages = [
        _msg_to_response(item["message"], item["reply_count"])
        for item in result["messages"]
    ]
    return MessageListResponse(
        messages=messages,
        cursor=result["cursor"],
        has_more=result["has_more"],
    )


@router.get("/rooms/{room_id}/messages/search", response_model=list[MessageResponse])
async def search_messages(
    room_id: uuid.UUID,
    q: str = Query(..., min_length=1, max_length=500),
    user: Annotated[dict[str, Any], Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
    livekit: Annotated[LiveKitService, Depends(get_livekit)] = None,
    limit: int = Query(20, ge=1, le=100),
) -> list[MessageResponse]:
    """Search messages in a room using full-text search."""
    svc = _build_message_service(db, livekit)
    messages = await svc.search_messages(
        room_id=room_id,
        query_text=q,
        limit=limit,
    )
    return [_msg_to_response(msg) for msg in messages]
