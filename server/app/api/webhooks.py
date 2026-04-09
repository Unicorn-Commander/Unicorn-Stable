from __future__ import annotations

import json
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from livekit.api import WebhookReceiver
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_db, get_presence, get_settings_dep
from app.models.participant import Participant, ParticipantStatus
from app.models.room import Room
from app.services.presence_service import PresenceService

logger = structlog.get_logger(__name__)

router = APIRouter()


@router.post("/webhooks/livekit")
async def livekit_webhook(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> dict[str, str]:
    """
    Receive and process LiveKit webhook events.

    Handles: participant_joined, participant_left, room_started,
    room_finished, track_published.
    """
    body = await request.body()
    auth_header = request.headers.get("Authorization", "")

    # Validate webhook signature
    receiver = WebhookReceiver(
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret,
    )

    try:
        event = receiver.receive(body.decode("utf-8"), auth_header)
    except Exception as exc:
        logger.warning("webhook_signature_invalid", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook signature",
        )

    event_type = event.event
    logger.info(
        "livekit_webhook_received",
        event_type=event_type,
        room_name=event.room.name if event.room else None,
    )

    if event_type == "participant_joined":
        await _handle_participant_joined(event, db, presence)
    elif event_type == "participant_left":
        await _handle_participant_left(event, db, presence)
    elif event_type == "room_started":
        await _handle_room_started(event, db)
    elif event_type == "room_finished":
        await _handle_room_finished(event, db)
    elif event_type == "track_published":
        await _handle_track_published(event)
    else:
        logger.debug("webhook_event_unhandled", event_type=event_type)

    return {"status": "ok"}


async def _handle_participant_joined(
    event: Any,
    db: AsyncSession,
    presence: PresenceService,
) -> None:
    """Handle a participant joining a LiveKit room."""
    if not event.participant or not event.room:
        return

    identity = event.participant.identity
    room_name = event.room.name

    logger.info(
        "participant_joined",
        identity=identity,
        room=room_name,
    )

    # Find the room in our database
    room_result = await db.execute(
        select(Room).where(Room.livekit_room_name == room_name)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        logger.warning("webhook_room_not_found", room_name=room_name)
        return

    # Extract participant ID from identity (format: username_uuid)
    participant_id = _extract_participant_id(identity)
    if participant_id:
        await presence.set_online(participant_id, "online")
        await presence.join_room_presence(participant_id, str(room.id))

        # Update participant status in DB
        p_result = await db.execute(
            select(Participant).where(Participant.id == participant_id)
        )
        participant = p_result.scalar_one_or_none()
        if participant:
            participant.status = ParticipantStatus.ONLINE
            await db.commit()


async def _handle_participant_left(
    event: Any,
    db: AsyncSession,
    presence: PresenceService,
) -> None:
    """Handle a participant leaving a LiveKit room."""
    if not event.participant or not event.room:
        return

    identity = event.participant.identity
    room_name = event.room.name

    logger.info(
        "participant_left",
        identity=identity,
        room=room_name,
    )

    room_result = await db.execute(
        select(Room).where(Room.livekit_room_name == room_name)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        return

    participant_id = _extract_participant_id(identity)
    if participant_id:
        await presence.leave_room_presence(participant_id, str(room.id))

        # Check if participant is in any other rooms
        # If not, mark them as offline
        # For now, just update their status
        from datetime import datetime, timezone

        p_result = await db.execute(
            select(Participant).where(Participant.id == participant_id)
        )
        participant = p_result.scalar_one_or_none()
        if participant:
            participant.last_seen_at = datetime.now(timezone.utc)
            participant.status = ParticipantStatus.OFFLINE
            await db.commit()

        await presence.set_offline(participant_id)


async def _handle_room_started(
    event: Any,
    db: AsyncSession,
) -> None:
    """Handle a LiveKit room being created/started."""
    if not event.room:
        return

    room_name = event.room.name
    sid = event.room.sid

    logger.info("room_started", room_name=room_name, sid=sid)

    # Update the livekit_sid in our database
    result = await db.execute(
        select(Room).where(Room.livekit_room_name == room_name)
    )
    room = result.scalar_one_or_none()
    if room and sid:
        room.livekit_sid = sid
        await db.commit()


async def _handle_room_finished(
    event: Any,
    db: AsyncSession,
) -> None:
    """Handle a LiveKit room being destroyed."""
    if not event.room:
        return

    room_name = event.room.name
    logger.info("room_finished", room_name=room_name)

    result = await db.execute(
        select(Room).where(Room.livekit_room_name == room_name)
    )
    room = result.scalar_one_or_none()
    if room:
        room.livekit_sid = None
        await db.commit()


async def _handle_track_published(event: Any) -> None:
    """Handle a track being published (audio/video stream)."""
    if not event.participant or not event.track:
        return

    logger.info(
        "track_published",
        identity=event.participant.identity,
        track_type=event.track.type,
        track_source=event.track.source,
    )


def _extract_participant_id(identity: str) -> str | None:
    """
    Extract participant UUID from a LiveKit identity string.

    Expected format: username_<uuid>
    """
    parts = identity.rsplit("_", 1)
    if len(parts) == 2:
        try:
            import uuid
            uuid.UUID(parts[1])
            return parts[1]
        except ValueError:
            pass
    return None
