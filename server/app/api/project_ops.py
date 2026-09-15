"""Project-Ops signed webhook receiver → agent-room messages.

Receives ``task.assigned`` / ``task.comment.created`` / ``task.status_changed``
envelopes signed by Project-Ops (see ``app/services/projectops_webhook.py`` for
the wire contract), verifies the signature + timestamp window, maps the task's
assignee (a Project-Ops user id) to a Stable room, and posts a short message
with a task link.

Flag-off = inert: when ``PROJECTOPS_WEBHOOK_SECRET`` is unset the route returns
503 and nothing is processed — matching the "no behaviour change unless
configured" acceptance bar.

Resilience mirrors the Slack incoming webhook: deliveries are de-duplicated on
the ``X-ProjectOps-Delivery`` id (Redis, fail-open) so Project-Ops' retries
never double-post, and the route is rate-limited per workspace.
"""

from __future__ import annotations

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

# How long a delivery id is remembered for de-duplication. Long enough to span
# Project-Ops' 3-attempt retry window many times over, short enough that the
# dedupe key set does not grow without bound.
_DEDUPE_TTL_SECONDS = 3600


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
    if not secret:
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
    if event not in HANDLED_EVENTS:
        return {"status": "ignored", "reason": f"unhandled_event:{event}"}

    # De-duplicate on the delivery id so Project-Ops' retries (same signed body,
    # same timestamp, same delivery header) never post the same event twice.
    delivery_id = request.headers.get(DELIVERY_HEADER)
    if redis is not None and delivery_id:
        dedupe_key = f"projectops:delivery:{delivery_id}"
        try:
            first = await redis.set(dedupe_key, "1", ex=_DEDUPE_TTL_SECONDS, nx=True)
        except Exception:
            logger.warning("projectops_webhook_dedupe_error", exc_info=True)
        else:
            if not first:
                return {"status": "duplicate", "delivery": delivery_id}

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
    workspace_id = (
        envelope.get("workspaceId") if isinstance(envelope.get("workspaceId"), str) else "unknown"
    )
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

    sender = await _get_or_create_sender(db, room_name)
    await _ensure_membership(db, room, sender)

    svc = MessageService(db=db, livekit=livekit)
    msg = await svc.send_message(
        room_id=room.id,
        sender_id=sender.id,
        content=content,
        content_type="text",
        metadata={
            "source": "project-ops",
            "event": event,
            "task_id": data.get("taskId"),
            "delivery": delivery_id,
        },
    )

    logger.info(
        "projectops_webhook_posted",
        room=room_name,
        po_event=event,
        message_id=str(msg.id),
    )
    return {"status": "ok", "message_id": str(msg.id)}


async def _get_or_create_sender(db: AsyncSession, room_name: str) -> Participant:
    """The per-room Project-Ops pseudo participant that owns these messages.

    Mirrors the Slack incoming-webhook pattern: a dedicated AGENT participant so
    threads/history/read-state behave as first-class chat. The SELECT-then-INSERT
    is made race-safe: on a unique-constraint collision (two first-ever
    deliveries to the same room), we roll back and re-read the winner.
    """
    pseudo_sub = f"projectops:{room_name}"
    pseudo_username = f"projectops-{room_name}"[:100]

    existing = (
        await db.execute(
            select(Participant).where(
                (Participant.keycloak_sub == pseudo_sub)
                | (Participant.username == pseudo_username)
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    sender = Participant(
        keycloak_sub=pseudo_sub,
        username=pseudo_username,
        display_name="Project-Ops",
        participant_type=ParticipantType.AGENT,
        status=ParticipantStatus.ONLINE,
    )
    db.add(sender)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        winner = (
            await db.execute(
                select(Participant).where(
                    (Participant.keycloak_sub == pseudo_sub)
                    | (Participant.username == pseudo_username)
                )
            )
        ).scalar_one_or_none()
        if winner is not None:
            return winner
        raise
    await db.refresh(sender)
    return sender


async def _ensure_membership(db: AsyncSession, room: Room, sender: Participant) -> None:
    """Make the pseudo participant a member of the target room (idempotent)."""
    membership = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == sender.id,
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        db.add(RoomMember(room_id=room.id, participant_id=sender.id, role=MemberRole.MEMBER))
        try:
            await db.commit()
        except IntegrityError:
            # A concurrent delivery already added the membership — that's fine.
            await db.rollback()
