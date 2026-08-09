"""Web-Push dispatch (VAPID). Sends a browser push to offline @-mentioned
users so they get a notification with the app closed. Mirrors the offline-
mention email dispatch; fully fail-safe (never raises into the request)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import structlog
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.push_subscription import PushSubscription
from app.models.room import Room, RoomMember, RoomType
from app.services.mentions import offline_notify_targets, parse_mentions

logger = structlog.get_logger(__name__)


def push_configured(settings: Settings) -> bool:
    return bool(
        getattr(settings, "vapid_private_key", "")
        and getattr(settings, "vapid_public_key", "")
    )


async def send_web_push(sub: PushSubscription, payload: dict, settings: Settings) -> bool:
    """Send one push. Returns False iff the endpoint is permanently dead
    (404/410) and its row should be pruned. Any other failure returns True
    (transient — keep the subscription)."""
    try:
        from pywebpush import WebPushException, webpush
    except Exception:  # noqa: BLE001 - library missing
        logger.warning("pywebpush_unavailable")
        return True

    def _do() -> None:
        webpush(
            subscription_info={
                "endpoint": sub.endpoint,
                "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
            },
            data=json.dumps(payload),
            vapid_private_key=settings.vapid_private_key,
            vapid_claims={"sub": settings.vapid_subject},
            timeout=10,
        )

    try:
        await asyncio.to_thread(_do)
        return True
    except WebPushException as exc:  # type: ignore[misc]
        code = getattr(getattr(exc, "response", None), "status_code", None)
        if code in (404, 410):
            return False
        logger.warning("web_push_failed", status=code, err=str(exc)[:120])
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("web_push_error", err=str(exc)[:120])
        return True


async def dispatch_message_pushes(
    *, db: AsyncSession, content: str, room_id: Any, sender_id: Any,
    sender_name: str, settings: Settings,
) -> None:
    """Push one message to offline DM/group members, plus channel mentions.

    In channels only mentioned members are pushed: explicit @user handles
    matched on USERNAME, plus @channel = every (offline, non-sender, human)
    member. @here adds no push targets by design — see services/mentions.py.
    """
    if not push_configured(settings):
        return
    room = (await db.execute(select(Room).where(Room.id == room_id))).scalar_one_or_none()
    if room is None:
        return
    rows = (await db.execute(
        select(Participant).join(RoomMember, RoomMember.participant_id == Participant.id).where(
            RoomMember.room_id == room_id,
            Participant.id != sender_id,
            Participant.participant_type == ParticipantType.HUMAN,
            Participant.status != ParticipantStatus.ONLINE,
        )
    )).scalars().all()
    if room.room_type == RoomType.CHANNEL:
        rows = offline_notify_targets(parse_mentions(content), rows)
    await _dispatch_targets(
        db=db, targets=rows,
        payload={
            "title": f"{sender_name} in {room.display_name or room.name}",
            "body": content if len(content) <= 140 else content[:140] + "…",
            "url": f"{settings.public_base_url}/?room={room.id}", "tag": str(room.id),
        }, settings=settings,
    )


async def dispatch_call_pushes(
    *, db: AsyncSession, targets: list[Participant], room: Room,
    caller_name: str, call_id: str, settings: Settings,
) -> None:
    """Push an incoming ring to offline callee devices."""
    offline = [p for p in targets if p.status != ParticipantStatus.ONLINE]
    await _dispatch_targets(db=db, targets=offline, settings=settings, payload={
        "title": f"Incoming call from {caller_name}",
        "body": room.display_name or "Direct message",
        "url": f"{settings.public_base_url}/?room={room.id}",
        "tag": f"call:{call_id}",
    })


async def _dispatch_targets(
    *, db: AsyncSession, targets: list[Participant], payload: dict, settings: Settings,
) -> None:
    if not targets or not push_configured(settings):
        return
    subs = (await db.execute(select(PushSubscription).where(
        PushSubscription.participant_id.in_([p.id for p in targets])
    ))).scalars().all()
    dead = [s.endpoint for s in subs if not await send_web_push(s, payload, settings)]
    if dead:
        await db.execute(delete(PushSubscription).where(PushSubscription.endpoint.in_(dead)))
        await db.commit()
