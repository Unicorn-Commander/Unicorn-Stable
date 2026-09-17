"""Project-Ops signed webhook receiver → agent-room messages.

Receives ``task.assigned`` / ``task.comment.created`` / ``task.status_changed``
envelopes signed by Project-Ops (see ``app/services/projectops_webhook.py`` for
the wire contract), verifies the signature + timestamp window, maps the task's
assignee (a Project-Ops user id) to a Stable room, and posts a short message
with a task link.

Flag-off = inert: when the secret or workspace binding is unset the route returns
503 and nothing is processed — matching the "no behaviour change unless
configured" acceptance bar.

Signed-body identity maps to a durable message primary key, making concurrent
retries idempotent without marking failed attempts delivered. Rate limiting
remains per workspace. Header delivery IDs are audit metadata, not authority.
"""

from __future__ import annotations

import hashlib
import uuid
from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import _rate_limit_hit, get_db, get_livekit, get_redis, get_settings_dep
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.message import Message
from app.models.room import MemberRole, Room, RoomMember
from app.services.livekit_service import LiveKitService
from app.services.message_service import MessageService
from app.services.projectops_webhook import (
    DELIVERY_HEADER,
    HANDLED_EVENTS,
    SIGNATURE_HEADER,
    build_message,
    build_task_link,
    extract_assignee_id,
    extract_project_id,
    is_timestamp_fresh,
    parse_envelope,
    verify_signature,
)

logger = structlog.get_logger(__name__)

router = APIRouter()


@router.post("/webhooks/project-ops")
async def project_ops_webhook(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    redis: Annotated[Redis, Depends(get_redis)] = None,
) -> dict[str, str]:
    """Verify a signed Project-Ops event and relay it to the assignee's room.

    Order of checks matters: unconfigured → 503, bad signature → 401, stale
    timestamp → 401, then de-dupe, then route. Unmapped/unknown events are
    acknowledged and dropped (200) so a single unhandled event never fails the
    webhook and triggers Project-Ops retries.
    """
    secret = settings.projectops_webhook_secret
    if not secret or not settings.projectops_workspace_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Project-Ops webhooks not configured",
        )

    raw_body = await request.body()
    if not verify_signature(secret, raw_body, request.headers.get(SIGNATURE_HEADER)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook signature",
        )

    envelope = parse_envelope(raw_body)
    if envelope is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Body must be a JSON object",
        )

    if not is_timestamp_fresh(
        envelope.get("timestamp"),
        settings.projectops_webhook_max_age_seconds,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Stale webhook timestamp",
        )

    event = envelope.get("event")
    if not isinstance(event, str) or event not in HANDLED_EVENTS:
        return {"status": "ignored", "reason": f"unhandled_event:{event}"}

    workspace_id = envelope.get("workspaceId")
    if workspace_id != settings.projectops_workspace_id:
        raise HTTPException(status_code=403, detail="Workspace not authorized")

    # Header delivery IDs are NOT signed. Derive identity from signed bytes so
    # changing/omitting the header cannot bypass replay protection. The message
    # primary key provides durable dedupe, including concurrent requests and
    # retries after a commit whose HTTP response was lost. No Redis fail-open.
    delivery_id = request.headers.get(DELIVERY_HEADER)

    data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
    assignee_id = extract_assignee_id(data)
    room_name = (
        settings.projectops_room_mapping.get(assignee_id) if assignee_id else None
    )
    if not room_name:
        logger.info(
            "projectops_webhook_unmapped",
            po_event=event,
            assignee=assignee_id,
        )
        return {"status": "ignored", "reason": "unmapped_assignee"}

    # Per-workspace rate limit (no authenticated user here — key on workspace).
    message_id = uuid.uuid5(
        uuid.NAMESPACE_URL, "projectops:" + hashlib.sha256(raw_body).hexdigest()
    )
    if await db.get(Message, message_id) is not None:
        return {"status": "duplicate", "message_id": str(message_id)}
    if redis is not None and settings.rate_limit_enabled:
        await _rate_limit_hit(
            redis,
            bucket="projectops_webhook",
            identifier=workspace_id,
            limit=settings.rate_limit_webhook_per_min,
            window_seconds=60,
        )

    room = (
        await db.execute(select(Room).where(Room.name == room_name))
    ).scalar_one_or_none()
    if room is None:
        logger.warning("projectops_webhook_room_not_found", room=room_name)
        return {"status": "ignored", "reason": f"room_not_found:{room_name}"}

    content = build_message(event, data)
    if not content:
        return {"status": "ignored", "reason": "empty_message"}

    link = build_task_link(
        settings.projectops_dashboard_url,
        workspace_id,
        data.get("taskId") if isinstance(data.get("taskId"), str) else None,
        extract_project_id(data),
    )
    if link:
        content = f"{content}\n\n{link}"

    room_id = room.id
    sender = await _get_or_create_sender(db, room_name)
    await _ensure_membership(db, room_id, sender.id)

    svc = MessageService(db=db, livekit=livekit)
    try:
        msg = await svc.send_message(
            room_id=room_id,
            sender_id=sender.id,
            content=content,
            content_type="text",
            metadata={
                "source": "project-ops",
                "event": event,
                "task_id": data.get("taskId"),
                "delivery": delivery_id,
                "workspace_id": workspace_id,
            },
            message_id=message_id,
        )
    except IntegrityError:
        await db.rollback()
        if await db.get(Message, message_id) is not None:
            return {"status": "duplicate", "message_id": str(message_id)}
        raise

    logger.info(
        "projectops_webhook_posted",
        room=room_name,
        po_event=event,
        message_id=str(msg.id),
    )
    return {"status": "ok", "message_id": str(msg.id)}


async def _get_or_create_sender(db: AsyncSession, room_name: str) -> Participant:
    """Only the exact synthetic subject can own webhook messages."""
    pseudo_sub = f"projectops:{room_name}"
    query = select(Participant).where(Participant.keycloak_sub == pseudo_sub)
    existing = (await db.execute(query)).scalar_one_or_none()
    if existing is not None:
        if existing.participant_type != ParticipantType.AGENT:
            raise HTTPException(
                status_code=409, detail="Webhook sender identity conflict"
            )
        return existing
    sender = Participant(
        keycloak_sub=pseudo_sub,
        username="projectops-" + hashlib.sha256(room_name.encode()).hexdigest()[:32],
        display_name="Project-Ops",
        participant_type=ParticipantType.AGENT,
        status=ParticipantStatus.ONLINE,
    )
    try:
        async with db.begin_nested():
            db.add(sender)
            await db.flush()
    except IntegrityError:
        winner = (await db.execute(query)).scalar_one_or_none()
        if winner is not None and winner.participant_type == ParticipantType.AGENT:
            return winner
        raise
    return sender


async def _ensure_membership(
    db: AsyncSession, room_id: uuid.UUID, sender_id: uuid.UUID
) -> None:
    """Savepoint rollback preserves outer objects on a concurrent first delivery."""
    query = select(RoomMember).where(
        RoomMember.room_id == room_id,
        RoomMember.participant_id == sender_id,
    )
    if (await db.execute(query)).scalar_one_or_none() is not None:
        return
    try:
        async with db.begin_nested():
            db.add(
                RoomMember(
                    room_id=room_id, participant_id=sender_id, role=MemberRole.MEMBER
                )
            )
            await db.flush()
    except IntegrityError:
        if (await db.execute(query)).scalar_one_or_none() is None:
            raise
