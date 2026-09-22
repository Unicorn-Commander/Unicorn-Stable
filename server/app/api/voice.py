"""Call-me voice state and the dispatch-log fan-out.

``PATCH /rooms/{id}/call/me`` writes ``shared_mic`` onto the caller's live
LiveKit participant metadata. The agents read that flag and refuse to treat
two people on one device as a solo human.

``POST /internal/voice-dispatch`` appends an ``agent_events`` row of type
``voice_dispatch`` and publishes a room-scoped WebSocket event
``voice_dispatch`` with ``{winner, rule}`` for the floor pill. Agents never
barge by audio off that event; it is visual.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._internal_auth import verify_internal_bearer
from app.api.tokens import livekit_identity
from app.config import get_settings
from app.deps import get_db, get_livekit, require_room_member
from app.models.agent import AgentEvent
from app.models.room import Room
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)
router = APIRouter()


class SharedMicBody(BaseModel):
    shared_mic: bool


class VoiceDispatchBody(BaseModel):
    room: str = Field(..., min_length=1, max_length=255)
    speaker: str = Field(default="", max_length=255)
    text_hash: str = Field(..., min_length=8, max_length=64)
    rule: str = Field(..., min_length=1, max_length=64)
    winner: str | None = Field(default=None, max_length=64)
    human_count: int = Field(..., ge=0, le=10000)
    shared_mic: bool = False
    agent_identity: str = Field(default="voice-dispatch", max_length=255)
    agent_type: str = Field(default="voice", max_length=100)


def _metadata_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except Exception:
            return {}
        return dict(data) if isinstance(data, dict) else {}
    return {}


async def _room_by_ref(db: AsyncSession, ref: str) -> Room | None:
    text = (ref or "").strip()
    if not text:
        return None
    try:
        as_uuid = uuid.UUID(text)
    except ValueError:
        as_uuid = None
    if as_uuid is not None:
        statement = select(Room).where(
            or_(Room.id == as_uuid, Room.livekit_room_name == text)
        )
    else:
        statement = select(Room).where(Room.livekit_room_name == text)
    return (await db.execute(statement)).scalar_one_or_none()


@router.patch("/rooms/{room_id}/call/me")
async def update_my_call(
    room_id: uuid.UUID,
    body: SharedMicBody,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> dict[str, Any]:
    """Flag the caller's live participant as a shared microphone.

    Membership is the dependency's job. The caller must already be in the
    LiveKit room — there is no participant metadata to merge otherwise.
    """
    room = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    username = str(user.get("username") or "").strip()
    participant_id = user.get("participant_id")
    if not username or participant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Caller has no LiveKit identity",
        )
    identity = livekit_identity(username, participant_id)
    try:
        info = await livekit.get_participant(room.livekit_room_name, identity)
    except Exception:
        logger.info(
            "shared_mic_not_in_call",
            room_id=str(room_id),
            identity=identity,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Join the call before changing the shared microphone",
        )
    merged = _metadata_dict(getattr(info, "metadata", ""))
    merged["shared_mic"] = bool(body.shared_mic)
    from livekit.api.room_service import UpdateParticipantRequest

    request = UpdateParticipantRequest(
        room=room.livekit_room_name,
        identity=identity,
        metadata=json.dumps(merged),
    )
    await livekit._api.room.update_participant(request)
    logger.info(
        "shared_mic_updated",
        room_id=str(room_id),
        identity=identity,
        shared_mic=bool(body.shared_mic),
    )
    return {"shared_mic": bool(body.shared_mic), "identity": identity}


@router.post("/internal/voice-dispatch", status_code=status.HTTP_201_CREATED)
async def ingest_voice_dispatch(
    body: VoiceDispatchBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """Record one decide() and fan {winner, rule} out to the room."""
    verify_internal_bearer(request)
    room = await _room_by_ref(db, body.room)
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")

    settings = get_settings()
    org_id = uuid.UUID(settings.instance_org_id) if settings.instance_org_id else None
    event_data = {
        "room": body.room,
        "speaker": body.speaker,
        "text_hash": body.text_hash,
        "rule": body.rule,
        "winner": body.winner,
        "human_count": body.human_count,
        "shared_mic": body.shared_mic,
    }
    event = AgentEvent(
        org_id=org_id,
        agent_identity=body.agent_identity,
        agent_type=body.agent_type,
        event_type="voice_dispatch",
        room_ref=str(room.id),
        event_data=event_data,
        occurred_at=datetime.now(timezone.utc),
    )
    db.add(event)
    await db.commit()

    try:
        from app.api.messages import _ws_broadcast_room

        await _ws_broadcast_room(
            db,
            room.id,
            {
                "type": "voice_dispatch",
                "payload": {"winner": body.winner, "rule": body.rule},
            },
        )
    except Exception:
        logger.warning("voice_dispatch_fanout_failed", room_id=str(room.id), exc_info=True)

    logger.info(
        "voice_dispatch_logged",
        room_id=str(room.id),
        rule=body.rule,
        winner=body.winner,
        human_count=body.human_count,
        shared_mic=body.shared_mic,
    )
    return {
        "id": str(event.id),
        "winner": body.winner,
        "rule": body.rule,
    }
