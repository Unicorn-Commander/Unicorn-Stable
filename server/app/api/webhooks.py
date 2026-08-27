from __future__ import annotations

import json
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from livekit.api import WebhookReceiver
from livekit.api.access_token import TokenVerifier
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import (
    _rate_limit_hit,
    get_db,
    get_livekit,
    get_presence,
    get_redis,
    get_settings_dep,
)
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import MemberRole, Room, RoomMember
from app.services import call_recording
from app.services.livekit_service import LiveKitService
from app.services.message_service import MessageService
from app.services.presence_service import PresenceService

logger = structlog.get_logger(__name__)

router = APIRouter()


@router.post("/webhooks/livekit")
async def livekit_webhook(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    redis: Annotated[Redis, Depends(get_redis)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> dict[str, str]:
    """
    Receive and process LiveKit webhook events.

    Handles: participant_joined, participant_left, room_started,
    room_finished, track_published.

    Joins/leaves additionally fan a room-scoped ``call_occupancy`` frame out to
    the room's members (see :func:`_broadcast_call_occupancy`) — the webhook is
    the one place the server learns occupancy changed the moment it happens,
    which is what lets the client's live-call surfaces (sidebar badges,
    in-room banner, call-started toast) move in real time instead of at the
    next /home/summary poll.
    """
    body = await request.body()
    auth_header = request.headers.get("Authorization", "")

    # Validate webhook signature (livekit-api 1.x takes a TokenVerifier)
    receiver = WebhookReceiver(
        TokenVerifier(
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
        )
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
        await _handle_participant_joined(event, db, presence, redis, livekit, settings)
    elif event_type == "participant_left":
        await _handle_participant_left(event, db, presence, redis, livekit, settings)
    elif event_type == "room_started":
        await _handle_room_started(event, db)
    elif event_type == "room_finished":
        await _handle_room_finished(event, db, redis, livekit, settings)
    elif event_type == "track_published":
        await _handle_track_published(event)
    elif event_type in ("egress_started", "egress_updated", "egress_ended"):
        await _handle_egress_event(event, db, settings, event_type)
    else:
        logger.debug("webhook_event_unhandled", event_type=event_type)

    return {"status": "ok"}


async def _broadcast_call_occupancy(
    redis: Redis,
    livekit: LiveKitService | None,
    room: Room,
    *,
    by: dict[str, Any] | None = None,
    count_override: int | None = None,
) -> None:
    """Tell the room's members what this room's call occupancy is NOW.

    Published on the ``room:{id}`` channel every websocket member is already
    subscribed to, as a flat ``call_occupancy`` frame (the same wire shape as
    typing/presence). Count 0 means the call ended.

    This is deliberately a DIFFERENT event from ``call_started`` — that one is
    a ring ("someone is calling YOU", per-user, carries an offer the client
    answers). This one is a room FACT with no offer, so no client can mistake
    it for a ring; it exists because ringing only covers DMs, while channel
    calls, un-rung joins, and every call END had no realtime signal at all.

    Occupancy is re-probed from LiveKit (the same honest source
    api/calls.py uses) rather than counted incrementally, so a lost webhook
    can never make the number drift. `count_override` skips the probe for
    events that already assert the answer (room_finished ⇒ 0).

    Best-effort BY DESIGN: awareness must never break presence bookkeeping or
    the webhook 200, so every failure lands in a log, not an exception. The
    30s /home/summary poll remains the reconciling backstop.
    """
    try:
        if count_override is not None:
            count = count_override
            has_agent = False
        else:
            if livekit is None:
                return
            info = await livekit.get_room(room.livekit_room_name)
            # Service participants (broadcast viewers, the egress recorder)
            # observe the call; they are not IN it.
            participants = [
                p
                for p in info.get("participants", [])
                if not call_recording.is_service_identity(
                    getattr(p, "identity", "")
                )
            ]
            count = len(participants)
            has_agent = any(
                str(getattr(p, "identity", "")).startswith("agent-")
                for p in participants
            )
        payload = {
            "type": "call_occupancy",
            "room_id": str(room.id),
            "room_type": room.room_type.value,
            "room_name": room.display_name,
            "participant_count": count,
            "has_agent": has_agent,
            "by": by,
        }
        await redis.publish(f"room:{room.id}", json.dumps(payload))
    except Exception:
        logger.warning(
            "call_occupancy_broadcast_failed",
            room_id=str(room.id),
            exc_info=True,
        )


def _is_broadcast_identity(identity: str) -> bool:
    """True for subscribe-only broadcast viewers (OBS browser sources).

    These join hidden, publish nothing, and must not affect presence or the
    call-occupancy fan-out — otherwise a silent OBS source announces itself as
    a participant and can flip presence for a UUID it does not own.
    """
    return str(identity or "").startswith("broadcast-")

def _is_agent_identity(identity: str) -> bool:
    """True for agent worker identities — ``agent-<brigade_agent_id>`` plus the
    legacy bare type-shaped workers (``agent-brigade``/``agent-triage``)."""
    return str(identity or "").startswith("agent-")


async def _release_agents_if_no_humans(
    livekit: LiveKitService, room: Room
) -> None:
    """Hang up agent workers once the last human leaves the call.

    Agent voice workers are dispatched into a call when humans join, but a
    worker only ends when its LiveKit job shuts down — and nothing used to
    shut it down, so agents sat alone in "empty" LiveKit rooms holding job
    slots and keeping the recording idle-stop from ever seeing the room as
    empty. An agent never keeps a call open on its own; text conversation
    continues through the server responder regardless of any call.
    """
    try:
        info = await livekit.get_room(room.livekit_room_name)
    except Exception:
        return  # room already gone from LiveKit — nothing to release
    participants = info.get("participants", [])
    humans = [
        p
        for p in participants
        if not call_recording.is_service_identity(getattr(p, "identity", ""))
        and not _is_agent_identity(getattr(p, "identity", ""))
    ]
    if humans:
        return
    agents = [
        str(getattr(p, "identity", ""))
        for p in participants
        if _is_agent_identity(getattr(p, "identity", ""))
    ]
    if not agents:
        return
    released: list[str] = []
    for identity in agents:
        try:
            await livekit.remove_participant(room.livekit_room_name, identity)
            released.append(identity)
        except Exception:
            logger.warning(
                "call_agent_release_failed",
                room_id=str(room.id),
                identity=identity,
                exc_info=True,
            )
    if released:
        logger.info(
            "call_agents_released",
            room_id=str(room.id),
            released=released,
        )


def _joined_by(event: Any, participant_id: str | None) -> dict[str, Any]:
    """Name the joiner for the ``call_occupancy`` frame.

    ``id`` is the Stable participant UUID when the identity carries one
    (humans — what the client compares against itself to suppress "you
    started a call" toasts); agents and unknown identities get ``id: None``
    but keep a human-readable display name.
    """
    identity = str(getattr(event.participant, "identity", "") or "")
    name = str(getattr(event.participant, "name", "") or "")
    if not name:
        # ``username_<uuid>`` → username; anything else stands as-is.
        name = identity.rsplit("_", 1)[0] if participant_id else identity
    return {"id": participant_id, "display_name": name or None}


async def _handle_participant_joined(
    event: Any,
    db: AsyncSession,
    presence: PresenceService,
    redis: Redis,
    livekit: LiveKitService,
    settings: Settings,
) -> None:
    """Handle a participant joining a LiveKit room."""
    if not event.participant or not event.room:
        return

    identity = event.participant.identity
    if call_recording.is_service_identity(identity):
        # Subscribe-only OBS viewer or the egress recorder: no presence, no
        # occupancy fan-out, and never a reason to start a recording.
        return
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
        # Resolve the participant BEFORE announcing presence, because the
        # answer decides how widely it is announced.
        p_result = await db.execute(
            select(Participant).where(Participant.id == participant_id)
        )
        participant = p_result.scalar_one_or_none()

        # GUEST PRESENCE IS ROOM-SCOPED. This is the SECOND door into the
        # instance-wide presence channel — the websocket is the first — and it
        # is the one a guest actually walks through, because a guest on camera
        # triggers this webhook. Scoping the socket alone would have looked
        # correct and leaked anyway the moment the guest turned their camera
        # on. An unresolved participant keeps the pre-existing behaviour: not
        # being able to find a row is not evidence of being a guest.
        instance_wide = not (
            participant is not None
            and participant.participant_type == ParticipantType.GUEST
        )
        await presence.set_online(
            participant_id, "online", instance_wide=instance_wide
        )
        await presence.join_room_presence(participant_id, str(room.id))

        # Update participant status in DB
        if participant:
            participant.status = ParticipantStatus.ONLINE
            await db.commit()

    # A join changes call occupancy whoever joined (agents included — they
    # count on /home/summary too), so the broadcast is NOT gated on having
    # resolved a participant id.
    await _broadcast_call_occupancy(
        redis, livekit, room, by=_joined_by(event, participant_id)
    )

    # Automatic call-audio recording: any real join means a call is live in
    # this room; the DB lease inside makes "start once" true across all four
    # uvicorn workers. Fail-open BY CONTRACT — a broken/absent egress service
    # must never break the call, presence, or this webhook's 200.
    try:
        await call_recording.ensure_room_recording(db, settings, livekit, room)
    except Exception:
        logger.error(
            "call_recording_ensure_failed",
            room_id=str(room.id),
            exc_info=True,
        )


async def _handle_participant_left(
    event: Any,
    db: AsyncSession,
    presence: PresenceService,
    redis: Redis,
    livekit: LiveKitService,
    settings: Settings,
) -> None:
    """Handle a participant leaving a LiveKit room."""
    if not event.participant or not event.room:
        return

    identity = event.participant.identity
    if call_recording.is_service_identity(identity):
        # Subscribe-only OBS viewer or the egress recorder: no presence, no
        # occupancy fan-out.
        return
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

        # Must mirror the join scope exactly — an instance-wide offline for a
        # guest who was never announced online is a phantom event on every
        # client on the deployment.
        await presence.set_offline(
            participant_id,
            instance_wide=not (
                participant is not None
                and participant.participant_type == ParticipantType.GUEST
            ),
        )

    # Re-probed occupancy: the last leaver takes this to 0, which is the
    # room-scoped "the call ended" signal the clients key off.
    await _broadcast_call_occupancy(redis, livekit, room)

    # Agents never hold a call open: once the last human leaves, hang up any
    # agent workers so the room can actually empty — and so the recording
    # idle-stop just below can see it as empty (it counts agents as real
    # participants). Fail-open like everything else in this webhook.
    try:
        await _release_agents_if_no_humans(livekit, room)
    except Exception:
        logger.error(
            "call_agent_release_sweep_failed",
            room_id=str(room.id),
            exc_info=True,
        )

    # If that was the last real participant, stop this call's recording now
    # instead of waiting out LiveKit's empty_timeout (which would append
    # minutes of silence). Fail-open: recording must never break the webhook.
    try:
        await call_recording.stop_room_recording_if_idle(db, settings, livekit, room)
    except Exception:
        logger.error(
            "call_recording_idle_stop_failed",
            room_id=str(room.id),
            exc_info=True,
        )


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
    redis: Redis,
    livekit: LiveKitService,
    settings: Settings,
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
        # The room is gone, so its call occupancy is definitionally 0 — no
        # probe. Backstop for a lost/ignored final participant_left, so no
        # client is left believing a call is live in a destroyed room.
        await _broadcast_call_occupancy(redis, None, room, count_override=0)

        # Backstop for the recording too: if the idle-stop never fired (lost
        # webhook), stop the egress when the room dies. Fail-open.
        try:
            await call_recording.stop_room_recording(
                db, settings, livekit, room, reason="room_finished"
            )
        except Exception:
            logger.error(
                "call_recording_finish_stop_failed",
                room_id=str(room.id),
                exc_info=True,
            )


async def _handle_egress_event(
    event: Any,
    db: AsyncSession,
    settings: Settings,
    event_type: str,
) -> None:
    """Fold LiveKit egress lifecycle webhooks into recording bookkeeping.

    ``egress_ended`` is the single authority that a recording finished (or
    died) and is what queues the Meeting-Ops audio hand-off. Fail-open: an
    exception here must not turn the webhook into a non-200 (LiveKit would
    retry forever against a persistent bug).
    """
    try:
        await call_recording.handle_egress_event(
            db, settings, event_type, getattr(event, "egress_info", None)
        )
    except Exception:
        logger.error(
            "call_recording_egress_event_failed",
            event_type=event_type,
            exc_info=True,
        )


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


# ---------------------------------------------------------------------------
# Slack-shaped incoming webhook
# ---------------------------------------------------------------------------


class IncomingWebhookBody(BaseModel):
    """Slack-style incoming-webhook payload.

    Either ``text`` or ``blocks`` (or both) must be present. ``username`` and
    ``icon_emoji`` are honored where they map; unknown fields are ignored.
    """

    text: str | None = None
    blocks: list[dict[str, Any]] | None = None
    username: str | None = None
    icon_emoji: str | None = None


def _render_slack_blocks_to_markdown(blocks: list[dict[str, Any]]) -> str:
    """Best-effort render of Slack block-kit blocks to plain markdown.

    Handles the block types we actually see from Brigade tripwires + the
    common GitHub/Sentry shapes: header, section (text + fields), context,
    divider. Unknown blocks fall back to any nested ``text.text`` we can find
    so messages aren't silently dropped.
    """
    parts: list[str] = []
    for block in blocks:
        bt = block.get("type")
        if bt == "header":
            txt = (block.get("text") or {}).get("text", "").strip()
            if txt:
                parts.append(f"## {txt}")
        elif bt == "section":
            txt = (block.get("text") or {}).get("text", "").strip()
            if txt:
                parts.append(txt)
            for f in block.get("fields", []) or []:
                ftxt = (f or {}).get("text", "").strip()
                if ftxt:
                    parts.append(ftxt)
        elif bt == "context":
            chunks = [
                (e or {}).get("text", "").strip()
                for e in (block.get("elements") or [])
                if isinstance(e, dict)
            ]
            chunks = [c for c in chunks if c]
            if chunks:
                parts.append("_" + " · ".join(chunks) + "_")
        elif bt == "divider":
            parts.append("---")
        else:
            # Unknown block type: salvage whatever inline text we can.
            inner = (block.get("text") or {}).get("text")
            if isinstance(inner, str) and inner.strip():
                parts.append(inner.strip())
    return "\n\n".join(p for p in parts if p)


@router.post("/webhooks/incoming/{secret}/{room_name}")
async def incoming_webhook(
    secret: str,
    room_name: str,
    body: IncomingWebhookBody,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    redis: Annotated[Redis, Depends(get_redis)] = None,
) -> dict[str, str]:
    """Slack-shaped incoming webhook → posts a message into a Stable channel.

    URL  : ``POST /webhooks/incoming/<secret>/<room-name>``
    Auth : the URL secret must match ``settings.incoming_webhook_secret``
           (matches Slack's URL-as-auth convention so any tool that already
           speaks Slack webhooks plugs in by changing one env var).
    Body : Slack block-kit shape. ``text`` and/or ``blocks`` required.

    The rendered content lands in the named room as a message from a
    per-room agent participant (``webhook-<room>``), so threads, history,
    mentions, and read state all behave as first-class chat.

    Rate-limited per room so a leaked URL can't flood a channel.
    """
    import hmac as _hmac

    expected = settings.incoming_webhook_secret
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Incoming webhooks not configured",
        )
    # Constant-time comparison so the secret can't be recovered by timing.
    if not _hmac.compare_digest(secret, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bad webhook secret",
        )

    # Per-room rate limit (no authenticated user here — key on room name).
    if redis is not None and settings.rate_limit_enabled:
        await _rate_limit_hit(
            redis,
            bucket="webhook_incoming",
            identifier=room_name,
            limit=settings.rate_limit_webhook_per_min,
            window_seconds=60,
        )

    room = (
        await db.execute(select(Room).where(Room.name == room_name))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Room '{room_name}' not found",
        )

    if body.blocks:
        content = _render_slack_blocks_to_markdown(body.blocks)
        if not content and body.text:
            content = body.text
    elif body.text:
        content = body.text
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Payload must include 'text' or 'blocks'",
        )

    if not content.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Rendered content is empty",
        )

    sender_name = (body.username or "Webhook").strip()[:60] or "Webhook"
    pseudo_sub = f"webhook:{room_name}"
    pseudo_username = f"webhook-{room_name}"[:60]

    agent_p = (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == pseudo_sub)
        )
    ).scalar_one_or_none()
    if agent_p is None:
        agent_p = Participant(
            keycloak_sub=pseudo_sub,
            username=pseudo_username,
            display_name=sender_name,
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
        )
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)
    elif agent_p.display_name != sender_name:
        agent_p.display_name = sender_name
        await db.commit()

    membership = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == agent_p.id,
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        db.add(
            RoomMember(
                room_id=room.id,
                participant_id=agent_p.id,
                role=MemberRole.MEMBER,
            )
        )
        await db.commit()

    svc = MessageService(db=db, livekit=livekit)
    msg = await svc.send_message(
        room_id=room.id,
        sender_id=agent_p.id,
        content=content,
        content_type="text",
        metadata={"source": "webhook", "username": sender_name},
    )

    logger.info(
        "incoming_webhook_posted",
        room=room_name,
        sender=sender_name,
        message_id=str(msg.id),
        content_len=len(content),
    )
    return {"status": "ok", "message_id": str(msg.id)}
