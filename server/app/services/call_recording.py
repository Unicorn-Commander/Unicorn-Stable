"""Call recording (LiveKit egress) — policy-driven capture, receipts, storage,
retention, and the Meeting-Ops hand-off. Design §8.

WHAT RECORDS, AND WHY
---------------------
The room's ``recording_policy`` is the decision (services/recording_policy.py
holds the whole matrix):

* ``always``      — the first real ``participant_joined`` of a call starts a
                    recording (``started_by`` NULL: policy-driven).
* ``on_request``  — an entitled member presses Record (``POST
                    /rooms/{id}/recording/start``), or an entitled member
                    whose ``record_my_calls`` preference is on STARTS a call.
* ``off``         — nothing records.

``CALL_RECORDING_ENABLED`` remains the instance-wide master kill-switch.

TWO KINDS
---------
* ``audio``     — audio-only ``room_composite`` egress → OGG (the original lane).
* ``composite`` — video ``room_composite`` egress rendering OUR broadcast page
                  through a recorder token (api/broadcast.py) → MP4. Capped
                  instance-wide by a Redis semaphore (services/
                  recording_capacity.py) because each one is a headless Chrome.

RECEIPTS
--------
Every start/stop transition fans a ``recording_state`` frame to the room's
members (ws/events.py) and posts a system message ("Audio recording started"
/ "Video recording stopped") so people, guests and agents all see it.

The message has NO sender, so it may carry only Stable's own words
(:func:`recording_notice_text`, a closed vocabulary): never a display name,
an error string or anything else a person or another system chose. Who
started it is ``metadata.started_by`` — a participant id the web renders a
name from, and that the room class counts as an author of the room.

AFTER THE EGRESS ENDS
---------------------
``egress_ended`` → the row is ``complete`` with ``retention_until`` = now +
``CALL_RECORDING_RETENTION_DAYS``. The durable outbox worker then, per row:
  1. uploads the file to S3-compatible storage (services/recording_storage.py)
     when configured → ``storage_url``;
  2. attaches the file to the call's Meeting-Ops session (MO's chunked upload
     API, ``action=attach``) exactly as before;
  3. deletes the LOCAL file once (1) succeeded and (2) reached a terminal
     state — today those files were never unlinked.
The 2-minute sweep also deletes storage objects + local files whose
``retention_until`` has passed (``legal_hold`` blocks it), frees leaked
composite slots, and revokes recorder tokens of finished egresses.

Failure doctrine: recording is a bystander. Nothing in this module may break
the call itself, presence bookkeeping, or the webhook 200 — every entry point
called from the webhook path is fail-open and logs loudly instead of raising.
The API path raises ``RecordingError`` (carrying an HTTP status) instead.

Concurrency doctrine: the backend runs uvicorn ``--workers 4``; any "only
once" decision in this module is enforced by a database row (the partial
unique lease index on ``call_egresses.room_id``), ``FOR UPDATE SKIP LOCKED``
claims, or Redis — never by in-process state.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import structlog
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.models.call_egress import ACTIVE_EGRESS_STATUSES, CallEgress
from app.models.agent import AgentEvent
from app.models.message import ContentType, Message
from app.models.participant import Participant
from app.models.room import Room, TranscriptExport
from app.services import recording_capacity, recording_storage
from app.services.recording_policy import (
    KIND_AUDIO,
    KIND_COMPOSITE,
    STARTABLE_KINDS,
    decide_auto_start,
    normalize_policy,
    participant_is_entitled,
    participant_wants_own_calls_recorded,
)

logger = structlog.get_logger(__name__)

# LiveKit egress participants join rooms with an EG_-prefixed identity; they
# are recorders, not callers, and must never count as call occupancy.
EGRESS_IDENTITY_PREFIX = "EG_"

# Transcript exports are created at (or during) THEIR call: manual sends land
# mid-call, automatic ones at each browser's hang-up. An export created before
# this recording began therefore belongs to an EARLIER call in the same room —
# the pre-window slack covers only clock skew, or back-to-back calls collapse
# onto the previous call's session (observed live: call 2's audio attached to
# call 1's session under a symmetric ±30min window). The post-window slack is
# generous because the last browser's export can trail the egress stop.
_SESSION_MATCH_PRE_SLACK = timedelta(minutes=2)
_SESSION_MATCH_POST_SLACK = timedelta(minutes=30)

# A row stuck in `starting` longer than this had its StartEgress interrupted
# (process death between lease INSERT and egress start); release the lease.
_STARTING_STALE_AFTER = timedelta(minutes=5)

# A row `delivering` longer than this belongs to a dead worker; reclaimable.
_DELIVERING_STALE_AFTER = timedelta(minutes=15)

# Hand-off states after which the row is never claimed again.
_HANDOFF_TERMINAL = ("delivered", "failed", "no_session")

# Egress statuses that mean "a recording exists (or existed)".
TERMINAL_EGRESS_STATUSES = ("complete", "failed", "deleted")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def composite_template(settings: Settings) -> str:
    """``livekit`` (the egress container's own grid template) or ``stable``
    (our broadcast page + recorder token). Anything else reads as livekit."""
    value = str(getattr(settings, "call_recording_composite_template", "") or "").strip().lower()
    return "stable" if value == "stable" else "livekit"


def is_service_identity(identity: str) -> bool:
    """True for identities that observe/record but are not call participants."""
    value = str(identity or "")
    return value.startswith("broadcast-") or value.startswith(EGRESS_IDENTITY_PREFIX)


def _is_agent_identity(identity: str) -> bool:
    return str(identity or "").startswith("agent-")


class RecordingError(Exception):
    """A refused or failed recording action, with the HTTP status to answer."""

    def __init__(self, code: str, status: int, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.status = status
        self.detail = detail


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def recording_enabled(settings: Settings) -> bool:
    """The instance-wide master switch (the room policy is the decision)."""
    return bool(settings.call_recording_enabled)


def max_duration_seconds(settings: Settings) -> int:
    hours = max(1, int(getattr(settings, "call_recording_max_hours", 6) or 6))
    return hours * 3600


def retention_delta(settings: Settings) -> timedelta:
    days = max(1, int(getattr(settings, "call_recording_retention_days", 30) or 30))
    return timedelta(days=days)


def handoff_config_error(settings: Settings) -> str | None:
    """Non-secret reason the Meeting-Ops audio hand-off cannot run, or None."""
    base = (settings.meeting_ops_upload_url or settings.meeting_ops_url or "").strip()
    if not base:
        return "Meeting-Ops upload URL is not configured"
    pat = (settings.meeting_ops_upload_pat or "").strip()
    if not pat:
        return "Meeting-Ops upload PAT is not configured"
    if not pat.startswith("mops_pat_"):
        return "Meeting-Ops upload credential must be a Personal Access Token"
    if not (settings.meeting_ops_org_slug or "").strip():
        return "Meeting-Ops organization slug is not configured"
    return None


def handoff_configured(settings: Settings) -> bool:
    return handoff_config_error(settings) is None


def upload_base_url(settings: Settings) -> str:
    return (
        (settings.meeting_ops_upload_url or settings.meeting_ops_url or "")
        .strip()
        .rstrip("/")
    )


def _handoff_headers(settings: Settings) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {(settings.meeting_ops_upload_pat or '').strip()}",
        "X-MeetingOps-Org": (settings.meeting_ops_org_slug or "").strip(),
        "User-Agent": "unicorn-stable-call-audio/1.0",
    }


def _backoff_seconds(settings: Settings, attempt: int) -> int:
    base = max(1, settings.call_recording_handoff_retry_base_seconds)
    maximum = max(base, settings.call_recording_handoff_retry_max_seconds)
    return min(maximum, base * (2 ** max(0, attempt - 1)))


# ---------------------------------------------------------------------------
# Room state
# ---------------------------------------------------------------------------


async def active_recording(db: AsyncSession, room_id: Any) -> CallEgress | None:
    """The room's in-flight recording row (starting/active), if any."""
    return (
        await db.execute(
            select(CallEgress)
            .where(
                CallEgress.room_id == room_id,
                CallEgress.status.in_(ACTIVE_EGRESS_STATUSES),
            )
            .order_by(CallEgress.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _display_name(db: AsyncSession, participant_id: Any) -> str | None:
    if participant_id is None:
        return None
    try:
        row = await db.get(Participant, participant_id)
    except Exception:
        return None
    if row is None:
        return None
    return row.display_name or row.username


async def room_recording_state(db: AsyncSession, room: Room) -> dict[str, Any]:
    """The ``recording_state`` shape for a room right now (consent surface).

    Used by the guest join payload and by the API; the same shape rides the
    ``recording_state`` WebSocket frame.
    """
    policy = normalize_policy(getattr(room, "recording_policy", "off"))
    kind = getattr(room, "recording_kind", None) or KIND_AUDIO
    row = await active_recording(db, room.id)
    if row is None:
        return {
            "active": False,
            "policy": policy,
            "kind": kind,
            "started_by": None,
            "started_at": None,
            "recording_id": None,
        }
    name = await _display_name(db, row.started_by)
    return {
        "active": True,
        "policy": policy,
        "kind": row.kind or kind,
        "started_by": (
            {"id": str(row.started_by), "display_name": name}
            if row.started_by is not None
            else None
        ),
        "started_at": (row.started_at or row.created_at).isoformat()
        if (row.started_at or row.created_at)
        else None,
        "recording_id": str(row.id),
    }


# ---------------------------------------------------------------------------
# Receipts: recording_state frame + system message
# ---------------------------------------------------------------------------


async def _ws_room(room_id: Any, envelope: dict[str, Any]) -> None:
    """Fan an envelope to the room's members; best effort."""
    try:
        from app.api.messages import _ws_broadcast_room

        await _ws_broadcast_room(None, room_id, envelope)
    except Exception:
        logger.warning("recording_ws_broadcast_failed", room_id=str(room_id), exc_info=True)


async def _post_system_message(
    db: AsyncSession,
    room_id: Any,
    content: str,
    metadata: dict[str, Any],
) -> None:
    """Persist a system message and deliver it like any other message.

    Persisted so agents (bridge/runner read the messages table) and late
    joiners see it; fanned out in the same ``message`` envelope the web
    client already handles, with ``sender_type: system`` so it renders as a
    notice rather than a bubble.
    """
    try:
        message = Message(
            id=uuid.uuid4(),
            room_id=room_id,
            sender_id=None,
            content=content,
            content_type=ContentType.SYSTEM,
            metadata_=metadata,
        )
        db.add(message)
        await db.commit()
        await db.refresh(message)
    except Exception:
        logger.warning("recording_system_message_failed", room_id=str(room_id), exc_info=True)
        try:
            await db.rollback()
        except Exception:
            pass
        return
    try:
        from app.schemas.message import MessageResponse

        response = MessageResponse(
            id=message.id,
            room_id=message.room_id,
            sender_id=None,
            sender_type="system",
            sender_name="Stable",
            content=message.content,
            content_type="system",
            metadata=message.metadata_ or {},
            created_at=message.created_at,
            updated_at=getattr(message, "updated_at", None),
        )
        await _ws_room(
            room_id,
            {
                "type": "message",
                "payload": {
                    "room_id": str(room_id),
                    "message": response.model_dump(mode="json"),
                },
            },
        )
    except Exception:
        logger.warning("recording_system_message_fanout_failed", exc_info=True)


def recording_notice_text(kind: str | None, event: str) -> str:
    """The text of a recording notice: Stable's own words and nothing else.

    A notice is a NULL-sender SYSTEM line, which the room class counts as
    house and a seat reads as ``[system] <text>`` — so the text is built
    from a closed vocabulary. The starter's name, the reason and any error
    string live in ``metadata`` (``started_by`` is a participant id)."""
    if event == "failed":
        return "Recording failed"
    kind_word = "Video recording" if kind == KIND_COMPOSITE else "Audio recording"
    return f"{kind_word} {'started' if event == 'started' else 'stopped'}"


async def _announce_recording_failure(db: AsyncSession, row: CallEgress, reason: str) -> None:
    """Make a failed/orphaned recording visible to people and agents. The
    reason (an error string from the egress) rides in metadata only."""
    if row.room_id is None:
        return
    await _post_system_message(
        db, row.room_id, recording_notice_text(row.kind, "failed"),
        {"kind": "recording", "event": "failed", "recording_id": str(row.id),
         "egress_id": row.egress_id, "reason": reason[:2000]},
    )
    try:
        db.add(AgentEvent(
            agent_identity="stable-recording", agent_type="system",
            event_type="recording_failed", room_ref=str(row.room_id),
            correlation_id=str(row.id),
            event_data={"recording_id": str(row.id), "egress_id": row.egress_id,
                        "reason": reason[:2000]},
            occurred_at=_now(),
        ))
        await db.commit()
    except Exception:
        logger.warning("recording_failure_agent_event_failed", room_id=str(row.room_id), exc_info=True)
        try:
            await db.rollback()
        except Exception:
            pass


async def announce_recording(
    db: AsyncSession,
    room: Room,
    row: CallEgress,
    *,
    active: bool,
    started_by_name: str | None = None,
    reason: str = "",
) -> None:
    """The receipts for one transition: ``recording_state`` + system message."""
    from app.ws.events import RECORDING_STATE

    if started_by_name is None and row.started_by is not None:
        started_by_name = await _display_name(db, row.started_by)
    started_at = row.started_at or row.created_at
    started_by = (
        {"id": str(row.started_by), "display_name": started_by_name}
        if row.started_by is not None
        else None
    )
    payload = {
        "room_id": str(room.id),
        "active": bool(active),
        "kind": row.kind or KIND_AUDIO,
        "started_by": started_by,
        "started_at": started_at.isoformat() if started_at else None,
        "recording_id": str(row.id),
        "reason": reason,
    }
    await _ws_room(room.id, {"type": RECORDING_STATE, "payload": payload})

    # The persisted line names nobody: the starter is metadata.started_by
    # (an id), the trigger / stop reason is metadata.reason.
    await _post_system_message(
        db,
        room.id,
        recording_notice_text(row.kind, "started" if active else "stopped"),
        {
            "kind": "recording",
            "event": "started" if active else "stopped",
            "recording_kind": row.kind or KIND_AUDIO,
            "recording_id": str(row.id),
            "started_by": str(row.started_by) if row.started_by else None,
            "reason": reason,
        },
    )


# ---------------------------------------------------------------------------
# Egress lifecycle
# ---------------------------------------------------------------------------


async def _joiner_started_the_call(livekit: Any, room: Room, joiner_identity: str | None) -> bool:
    """True when the joiner is the only human in the LiveKit room right now."""
    if livekit is None:
        return False
    try:
        info = await livekit.get_room(room.livekit_room_name)
    except Exception:
        return False
    humans = [
        str(getattr(p, "identity", "") or "")
        for p in info.get("participants", [])
        if not is_service_identity(getattr(p, "identity", ""))
        and not _is_agent_identity(getattr(p, "identity", ""))
    ]
    if len(humans) > 1:
        return False
    if joiner_identity and humans and humans[0] != joiner_identity:
        return False
    return True


async def ensure_room_recording(
    db: AsyncSession,
    settings: Settings,
    livekit: Any,
    room: Room,
    *,
    redis: Any = None,
    joiner: Any = None,
    joiner_identity: str | None = None,
) -> CallEgress | None:
    """Policy-driven auto-start on ``participant_joined``.

    The INSERT into the leased partial unique index decides the winner across
    all workers; the losers get an IntegrityError and walk away silently.
    Returns the row when THIS caller started the recording, else None.
    Fail-open: never raises.
    """
    if not recording_enabled(settings):
        return None
    if room is None or not getattr(room, "livekit_room_name", None):
        return None
    policy = normalize_policy(getattr(room, "recording_policy", "off"))
    if policy == "off":
        return None

    # Cheap short-circuit before any LiveKit probe: a call already recording
    # (or mid-start) needs nothing from this join.
    try:
        if await active_recording(db, room.id) is not None:
            return None
    except Exception:
        logger.warning("call_recording_active_probe_failed", room_id=str(room.id), exc_info=True)
        return None

    joiner_entitled = participant_is_entitled(joiner)
    joiner_pref = participant_wants_own_calls_recorded(joiner)
    started_call = False
    if policy == "on_request" and joiner is not None and joiner_entitled and joiner_pref:
        started_call = await _joiner_started_the_call(livekit, room, joiner_identity)

    decision = decide_auto_start(
        policy=policy,
        master_enabled=True,
        joiner_entitled=joiner_entitled,
        joiner_pref=joiner_pref,
        joiner_started_call=started_call,
    )
    if not decision.start:
        return None

    kind = getattr(room, "recording_kind", None) or KIND_AUDIO
    if kind not in STARTABLE_KINDS:
        kind = KIND_AUDIO
    started_by = getattr(joiner, "id", None) if decision.attribute_to_joiner else None
    try:
        return await start_recording(
            db,
            settings,
            livekit,
            room,
            kind=kind,
            started_by=started_by,
            redis=redis,
            trigger=decision.reason,
            allow_fallback=True,
        )
    except RecordingError as exc:
        if exc.code != "already_active":
            logger.error(
                "call_recording_auto_start_refused",
                room_id=str(room.id),
                code=exc.code,
                detail=exc.detail,
            )
        return None
    except Exception:
        logger.error("call_recording_auto_start_failed", room_id=str(room.id), exc_info=True)
        return None


async def start_recording(
    db: AsyncSession,
    settings: Settings,
    livekit: Any,
    room: Room,
    *,
    kind: str,
    started_by: Any,
    redis: Any = None,
    trigger: str = "manual",
    allow_fallback: bool = False,
    started_by_name: str | None = None,
) -> CallEgress:
    """Start ONE recording of ``kind`` for this room's live call.

    Raises :class:`RecordingError` (``already_active`` 409, ``capacity`` 429,
    ``egress_unavailable`` 503). With ``allow_fallback`` (policy-driven
    starts) a composite that cannot get a capacity slot degrades to audio
    instead of refusing — an ``always`` room must still produce a receipt.
    """
    if kind not in STARTABLE_KINDS:
        raise RecordingError("bad_kind", 400, f"Recording kind '{kind}' is not available")
    if not recording_enabled(settings):
        raise RecordingError("disabled", 503, "Recording is disabled on this instance")

    row = CallEgress(
        id=uuid.uuid4(),
        room_id=room.id,
        livekit_room_name=room.livekit_room_name,
        status="starting",
        kind=kind,
        started_by=started_by,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        # Another worker (or an earlier join) already owns this call's lease.
        await db.rollback()
        raise RecordingError("already_active", 409, "This room is already being recorded")
    await db.refresh(row)

    slot_member = str(row.id)
    if kind == KIND_COMPOSITE:
        admitted = False
        capacity_note = ""
        limit = int(getattr(settings, "recording_max_composite", 2) or 0)
        if redis is None:
            capacity_note = "capacity service unavailable"
        else:
            try:
                admitted = await recording_capacity.acquire_composite_slot(
                    redis,
                    member=slot_member,
                    limit=limit,
                    ttl_seconds=max_duration_seconds(settings),
                )
                if not admitted:
                    capacity_note = f"composite capacity is full ({limit} allowed at once)"
            except recording_capacity.CapacityUnavailable as exc:
                capacity_note = f"capacity service unavailable: {exc}"[:200]
        if not admitted:
            if allow_fallback:
                logger.warning(
                    "call_recording_composite_fallback_to_audio",
                    room_id=str(room.id),
                    detail=capacity_note,
                )
                kind = KIND_AUDIO
                row.kind = KIND_AUDIO
                await db.commit()
            else:
                await db.delete(row)
                await db.commit()
                if "unavailable" in capacity_note:
                    raise RecordingError("capacity_unknown", 503, "Recording capacity cannot be checked right now; try again shortly")
                raise RecordingError(
                    "capacity",
                    429,
                    f"Video recording capacity is full ({limit} composite recordings at once). "
                    "Wait for one to finish, or record audio instead.",
                )

    output_dir = (settings.call_recording_output_dir or "/egress-out").rstrip("/")
    stamp = _now().strftime("%Y%m%dT%H%M%SZ")
    ext = recording_storage.EXTENSIONS.get(kind, "ogg")
    filepath = f"{output_dir}/stable-call-{room.id}-{stamp}.{ext}"

    try:
        if kind == KIND_COMPOSITE:
            template_url: str | None = None
            if composite_template(settings) == "stable":
                from app.api.broadcast import composite_template_url, mint_recorder_token

                raw_token, _token_row = await mint_recorder_token(
                    db, room, egress_row_id=row.id, ttl_seconds=max_duration_seconds(settings)
                )
                template_url = composite_template_url(settings, room.id, raw_token)
            info = await livekit.start_room_composite_video_egress(
                room.livekit_room_name,
                filepath,
                custom_base_url=template_url,
                preset=getattr(settings, "call_recording_composite_preset", "H264_720P_30"),
                layout=getattr(settings, "call_recording_composite_layout", "grid") or "grid",
            )
        else:
            info = await livekit.start_room_audio_egress(room.livekit_room_name, filepath)
    except Exception as exc:
        # Fail OPEN: the call continues unrecorded; free the lease and shout.
        try:
            await db.rollback()
        except Exception:
            pass
        row = await db.get(CallEgress, row.id) or row
        row.status = "failed"
        row.error = f"StartEgress failed: {type(exc).__name__}: {exc}"[:2000]
        row.ended_at = _now()
        await db.commit()
        if kind == KIND_COMPOSITE:
            if redis is not None:
                await recording_capacity.release_composite_slot(redis, slot_member)
            from app.api.broadcast import revoke_recorder_tokens

            await revoke_recorder_tokens(
                db, livekit, egress_row_id=row.id, room_name=room.livekit_room_name
            )
        logger.error(
            "call_recording_start_failed",
            room_id=str(room.id),
            livekit_room=room.livekit_room_name,
            kind=kind,
            error=str(exc),
        )
        await _announce_recording_failure(db, row, row.error or "egress start failed")
        raise RecordingError(
            "egress_unavailable",
            503,
            "Recording could not be started: the egress service did not answer",
        )

    # The egress webhooks race this commit: a very fast egress_started (or a
    # fast-abort egress_ended) may already have adopted/terminalized the row
    # via the null-egress_id fallback matcher. Re-read and never overwrite a
    # terminal state back to active.
    await db.refresh(row)
    row.egress_id = row.egress_id or getattr(info, "egress_id", None)
    if row.status in ("starting", "active"):
        row.status = "active"
        row.started_at = row.started_at or _now()
    await db.commit()
    logger.info(
        "call_recording_started",
        room_id=str(room.id),
        livekit_room=room.livekit_room_name,
        egress_id=row.egress_id,
        kind=kind,
        trigger=trigger,
        started_by=str(started_by) if started_by else None,
        filepath=filepath,
    )
    if row.status == "active":
        await announce_recording(
            db, room, row, active=True, started_by_name=started_by_name, reason=trigger
        )
    return row


async def _finish_row_side_effects(
    db: AsyncSession,
    livekit: Any,
    redis: Any,
    row: CallEgress,
    room_name: str | None,
) -> None:
    """Free what a composite held: its capacity slot and its recorder token."""
    if row.kind != KIND_COMPOSITE:
        return
    if redis is not None:
        await recording_capacity.release_composite_slot(redis, str(row.id))
    from app.api.broadcast import revoke_recorder_tokens

    await revoke_recorder_tokens(db, livekit, egress_row_id=row.id, room_name=room_name)


async def stop_room_recording(
    db: AsyncSession,
    settings: Settings,
    livekit: Any,
    room: Room,
    *,
    reason: str,
    redis: Any = None,
    stopped_by_name: str | None = None,
) -> int:
    """Ask LiveKit to stop every non-terminal egress for this room.

    Idempotent and multi-worker safe: StopEgress on an already-stopping egress
    is an error LiveKit reports and we swallow — ``egress_ended`` remains the
    single authority for terminal state. Announces the stop ONCE per row (the
    transition into ``stopping``).
    """
    if room is None:
        return 0
    rows = (
        (
            await db.execute(
                select(CallEgress).where(
                    CallEgress.room_id == room.id,
                    CallEgress.status.in_(ACTIVE_EGRESS_STATUSES),
                )
            )
        )
        .scalars()
        .all()
    )
    stopped = 0
    announced: list[CallEgress] = []
    for row in rows:
        if not row.egress_id:
            # StartEgress still in flight in another worker; egress_ended (or
            # the stale-starting sweep) will terminalize it.
            continue
        try:
            await livekit.stop_egress(row.egress_id)
            stopped += 1
        except Exception as exc:
            # Already ended / already stopping is normal here.
            logger.info(
                "call_recording_stop_request_noop",
                egress_id=row.egress_id,
                room_id=str(room.id),
                detail=str(exc)[:200],
            )
        row.status = "stopping"
        announced.append(row)
    if rows:
        await db.commit()
        logger.info(
            "call_recording_stop_requested",
            room_id=str(room.id),
            reason=reason,
            egress_count=len(rows),
        )
    for row in announced:
        await announce_recording(db, room, row, active=False, reason=reason)
        await _finish_row_side_effects(db, livekit, redis, row, room.livekit_room_name)
    return stopped


async def stop_room_recording_if_idle(
    db: AsyncSession,
    settings: Settings,
    livekit: Any,
    room: Room,
    *,
    redis: Any = None,
) -> None:
    """Stop the room's recording when no real participants remain."""
    if room is None:
        return
    # Cheap short-circuit: no non-terminal egress rows → nothing to stop.
    has_active = (
        await db.execute(
            select(CallEgress.id)
            .where(
                CallEgress.room_id == room.id,
                CallEgress.status.in_(ACTIVE_EGRESS_STATUSES),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if has_active is None:
        return
    try:
        info = await livekit.get_room(room.livekit_room_name)
        participants = info.get("participants", [])
        count = sum(
            1
            for p in participants
            if not is_service_identity(getattr(p, "identity", ""))
        )
    except Exception:
        # Room already gone from LiveKit ⇒ the call is over.
        count = 0
    if count == 0:
        await stop_room_recording(
            db, settings, livekit, room, reason="room_idle", redis=redis
        )


async def handle_egress_event(
    db: AsyncSession,
    settings: Settings,
    event_type: str,
    egress_info: Any,
    *,
    redis: Any = None,
    livekit: Any = None,
) -> None:
    """Fold a LiveKit egress webhook event into our bookkeeping row."""
    if egress_info is None:
        return
    egress_id = getattr(egress_info, "egress_id", "") or ""
    room_name = getattr(egress_info, "room_name", "") or ""

    row = (
        await db.execute(select(CallEgress).where(CallEgress.egress_id == egress_id))
    ).scalar_one_or_none()
    if row is None:
        # StartEgress response may not have committed yet in the other worker;
        # fall back to the room's in-flight row.
        row = (
            await db.execute(
                select(CallEgress)
                .where(
                    CallEgress.livekit_room_name == room_name,
                    CallEgress.status.in_(("starting", "active", "stopping")),
                    CallEgress.egress_id.is_(None),
                )
                .order_by(CallEgress.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if row is not None and egress_id:
            row.egress_id = egress_id
    if row is None:
        logger.warning(
            "call_recording_event_unmatched",
            event=event_type,
            egress_id=egress_id,
            livekit_room=room_name,
        )
        return

    if event_type in ("egress_started", "egress_updated"):
        if row.status == "starting":
            row.status = "active"
            row.started_at = row.started_at or _now()
        await db.commit()
        return

    if event_type != "egress_ended":
        return

    # A row that never went through stop_room_recording (egress died, or
    # LiveKit ended it on its own) still owes the room a "stopped" receipt.
    owes_stop_receipt = row.status in ("starting", "active")

    # Terminal: EgressStatus — 3=COMPLETE, 4=FAILED, 5=ABORTED, 6=LIMIT_REACHED.
    status_code = int(getattr(egress_info, "status", 0) or 0)
    error_text = str(getattr(egress_info, "error", "") or "")
    file_results = list(getattr(egress_info, "file_results", []) or [])
    file_path: str | None = None
    file_size: int | None = None
    duration_s: float | None = None
    if file_results:
        first = file_results[0]
        file_path = str(getattr(first, "filename", "") or "") or None
        file_size = int(getattr(first, "size", 0) or 0)
        duration_ns = int(getattr(first, "duration", 0) or 0)
        duration_s = duration_ns / 1_000_000_000 if duration_ns else None

    row.ended_at = _now()
    row.file_path = file_path
    row.file_size_bytes = file_size
    row.duration_seconds = duration_s

    completed = status_code in (3, 6) and file_path and (file_size or 0) > 0
    if completed:
        row.status = "complete"
        row.retention_until = row.retention_until or (_now() + retention_delta(settings))
        if handoff_configured(settings):
            row.handoff_status = "pending"
            row.handoff_next_attempt_at = _now()
        else:
            row.handoff_status = "blocked"
            row.handoff_error = "Meeting-Ops audio hand-off is not configured"
        logger.info(
            "call_recording_complete",
            egress_id=row.egress_id,
            room_id=str(row.room_id),
            kind=row.kind,
            file_path=file_path,
            file_size=file_size,
            duration_seconds=duration_s,
            retention_until=row.retention_until.isoformat() if row.retention_until else None,
            handoff_status=row.handoff_status,
        )
    else:
        row.status = "failed"
        row.error = (error_text or f"egress ended with status {status_code}")[:2000]
        logger.error(
            "call_recording_failed",
            egress_id=row.egress_id,
            room_id=str(row.room_id),
            kind=row.kind,
            egress_status=status_code,
            error=error_text,
        )
    await db.commit()

    room = await db.get(Room, row.room_id) if row.room_id is not None else None
    await _finish_row_side_effects(db, livekit, redis, row, room_name or None)

    if completed:
        if owes_stop_receipt and room is not None:
            await announce_recording(db, room, row, active=False, reason="ended")
        return

    replacement = await _retry_failed_start(db, settings, livekit, redis, room, row)
    if replacement is not None:
        # The replacement posted its own "started" receipt and the failed
        # row names it, so this no longer reads as a lost recording.
        return
    if owes_stop_receipt and room is not None:
        await announce_recording(db, room, row, active=False, reason="failed")
    await _announce_recording_failure(db, row, row.error or "egress failed")


_START_RETRY_WINDOW = timedelta(minutes=3)
_START_RETRY_MAX_FAILED = 2


async def _retry_failed_start(
    db: AsyncSession,
    settings: Settings,
    livekit: Any,
    redis: Any,
    room: Room | None,
    failed: CallEgress,
) -> CallEgress | None:
    """One bounded replacement for an egress that died before it recorded.

    Measured on dogfood 2026-09-24 (build-in-public-live): ``egress_ended``
    with "Start signal not received" 1.2 s after StartEgress, 0 bytes. The
    lease had released correctly (the row was already ``failed``) and a
    second person's join six seconds later started a recording that
    completed — so a call with ONE human would simply not have been
    recorded. Retry here when the room asked for every call (``always``),
    nothing was captured, a human is still in the LiveKit room, and fewer
    than two rows failed for the room in the last three minutes (a broken
    egress must not loop). Returns the replacement row, or None when no
    retry happened. Never raises.
    """
    if room is None or livekit is None:
        return None
    if (failed.file_size_bytes or 0) > 0:
        return None
    if normalize_policy(getattr(room, "recording_policy", "off")) != "always":
        return None
    try:
        recent = (
            await db.execute(
                select(func.count())
                .select_from(CallEgress)
                .where(
                    CallEgress.room_id == room.id,
                    CallEgress.status == "failed",
                    CallEgress.created_at >= _now() - _START_RETRY_WINDOW,
                )
            )
        ).scalar_one()
        if int(recent or 0) >= _START_RETRY_MAX_FAILED:
            logger.error(
                "call_recording_retry_exhausted",
                room_id=str(room.id),
                recent_failures=int(recent or 0),
            )
            return None
        info = await livekit.get_room(room.livekit_room_name)
        participants = info.get("participants", []) if isinstance(info, dict) else []
        humans = [
            p
            for p in participants
            if not is_service_identity(getattr(p, "identity", ""))
            and not _is_agent_identity(getattr(p, "identity", ""))
        ]
        if not humans:
            return None
    except Exception:
        logger.warning("call_recording_retry_probe_failed", room_id=str(room.id), exc_info=True)
        return None

    replacement: CallEgress | None
    try:
        replacement = await start_recording(
            db,
            settings,
            livekit,
            room,
            kind=failed.kind or KIND_AUDIO,
            started_by=failed.started_by,
            redis=redis,
            trigger="policy always",
        )
    except RecordingError as exc:
        if exc.code != "already_active":
            logger.warning("call_recording_retry_refused", room_id=str(room.id), code=exc.code)
            return None
        replacement = await active_recording(db, room.id)
    except Exception:
        logger.warning("call_recording_retry_failed", room_id=str(room.id), exc_info=True)
        return None
    if replacement is None:
        return None
    failed.error = (
        f"{failed.error or 'egress failed'} — retried automatically as recording {replacement.id}"
    )[:2000]
    await db.commit()
    logger.info(
        "call_recording_retried",
        room_id=str(room.id),
        failed_id=str(failed.id),
        replacement_id=str(replacement.id),
    )
    return replacement


# ---------------------------------------------------------------------------
# Files: storage upload, local cleanup, purge
# ---------------------------------------------------------------------------


def _unlink_quietly(path: str | None) -> bool:
    """Delete a local egress file. True if it is gone afterwards."""
    if not path:
        return True
    p = Path(path)
    try:
        p.unlink()
        return True
    except FileNotFoundError:
        return True
    except OSError as exc:
        logger.warning("call_recording_local_unlink_failed", path=path, detail=str(exc))
        return False


async def purge_recording_files(settings: Settings, row: CallEgress) -> dict[str, Any]:
    """Delete the storage object and the local file of one row.

    Mutates ``row.storage_url`` / ``row.file_path`` to None for what is gone;
    the caller commits. Never raises. Returns what happened.
    """
    result: dict[str, Any] = {"storage": None, "local": None}
    cfg = recording_storage.storage_config(settings)
    if row.storage_url:
        key = recording_storage.key_from_url(cfg, row.storage_url) if cfg else None
        if cfg is None:
            result["storage"] = "storage not configured; object left in place"
        elif key is None:
            result["storage"] = "storage_url does not belong to the configured bucket"
        else:
            outcome = await recording_storage.delete_object(settings, key=key)
            if outcome.get("ok"):
                row.storage_url = None
                result["storage"] = "deleted"
            else:
                result["storage"] = outcome.get("detail")
    if row.file_path:
        if await asyncio.to_thread(_unlink_quietly, row.file_path):
            row.file_path = None
            result["local"] = "deleted"
        else:
            result["local"] = "unlink failed"
    return result


async def _upload_to_storage(settings: Settings, row: CallEgress) -> dict[str, Any]:
    """Upload the row's local file; sets ``row.storage_url`` on success."""
    cfg = recording_storage.storage_config(settings)
    if cfg is None or not row.file_path:
        return {"ok": False, "skipped": True}
    key = recording_storage.object_key(
        cfg, room_id=row.room_id, row_id=row.id, kind=row.kind or KIND_AUDIO
    )
    outcome = await recording_storage.put_object(
        settings,
        file_path=Path(row.file_path),
        key=key,
        content_type=recording_storage.CONTENT_TYPES.get(row.kind or KIND_AUDIO, "application/octet-stream"),
    )
    if outcome.get("ok"):
        row.storage_url = outcome["url"]
    return outcome


# ---------------------------------------------------------------------------
# Meeting-Ops hand-off (durable outbox)
# ---------------------------------------------------------------------------


async def _find_meeting_ops_session(
    db: AsyncSession, row: CallEgress
) -> str | None:
    """The MO session created by this call's transcript export, if any.

    Deterministic across retries and duplicate exports: the EARLIEST delivered
    export whose creation falls inside the recording window (± slack) wins.
    """
    if row.room_id is None:
        return None
    window_start = (row.started_at or row.created_at) - _SESSION_MATCH_PRE_SLACK
    window_end = (row.ended_at or _now()) + _SESSION_MATCH_POST_SLACK
    export = (
        await db.execute(
            select(TranscriptExport)
            .where(
                TranscriptExport.room_id == row.room_id,
                TranscriptExport.status == "delivered",
                TranscriptExport.remote_session_id.is_not(None),
                TranscriptExport.created_at >= window_start,
                TranscriptExport.created_at <= window_end,
            )
            .order_by(TranscriptExport.created_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if export is None:
        return None
    return export.remote_session_id


async def upload_audio_to_meeting_ops(
    settings: Settings,
    *,
    file_path: Path,
    target_session_id: str | None,
    filename: str,
    content_type: str = "audio/ogg",
) -> dict[str, Any]:
    """Deliver one media file to Meeting-Ops through MO's upload API.

    ``target_session_id`` set → ``action=attach`` onto that session (the one
    the call's transcript export created). None → ``action=transcribe``: MO
    creates a NEW session from the media and runs its own STT + summary, so
    a call nobody exported a transcript for still lands. (Dogfood
    2026-09-24: four of the last ten recordings sat as ``no_session``.)
    MO's transcript-ingest endpoint cannot do this — it refuses an export
    with no lines — which is why the media upload is the door.

    start → chunk* → finalize, honoring the server-assigned chunk size.
    Returns a status dict; never raises. Composite MP4s ride the same path
    with ``content_type="video/mp4"``.
    """
    base = upload_base_url(settings)
    headers = _handoff_headers(settings)
    try:
        total_size = file_path.stat().st_size
    except OSError as exc:
        # Mount/permission trouble is operational and worth retrying (the
        # caller's max-attempts cap keeps it bounded).
        return {
            "ok": False,
            "retryable": True,
            "detail": f"audio file unreadable: {exc}",
        }
    if total_size <= 0:
        return {"ok": False, "retryable": False, "detail": "audio file is empty"}

    def _classify(status_code: int) -> bool:
        return status_code == 429 or status_code >= 500

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(180.0, connect=10.0)
        ) as client:
            start_json: dict[str, Any] = {
                "filename": filename,
                "total_size": total_size,
                "content_type": content_type,
                "action": "attach" if target_session_id else "transcribe",
            }
            if target_session_id:
                start_json["target_session_id"] = target_session_id
            start_resp = await client.post(
                f"{base}/api/uploads/start",
                json=start_json,
                headers=headers,
            )
            if start_resp.status_code >= 400:
                return {
                    "ok": False,
                    "retryable": _classify(start_resp.status_code),
                    "http_status": start_resp.status_code,
                    "detail": f"MO uploads/start returned HTTP {start_resp.status_code}",
                }
            start_body = start_resp.json()
            upload_id = str(start_body.get("upload_id") or "")
            chunk_size = int(start_body.get("chunk_size") or 8 * 1024 * 1024)
            if not upload_id or chunk_size <= 0:
                return {
                    "ok": False,
                    "retryable": False,
                    "detail": "MO uploads/start returned no upload_id/chunk_size",
                }

            def _read_chunk(index: int) -> bytes:
                with file_path.open("rb") as fh:
                    fh.seek(index * chunk_size)
                    return fh.read(chunk_size)

            total_chunks = max(1, -(-total_size // chunk_size))
            for index in range(total_chunks):
                chunk = await asyncio.to_thread(_read_chunk, index)
                chunk_resp = await client.post(
                    f"{base}/api/uploads/{upload_id}/chunk",
                    data={"chunk_index": str(index)},
                    files={"data": (filename, chunk, content_type)},
                    headers=headers,
                )
                if chunk_resp.status_code >= 400:
                    return {
                        "ok": False,
                        "retryable": _classify(chunk_resp.status_code),
                        "http_status": chunk_resp.status_code,
                        "detail": (
                            f"MO chunk {index + 1}/{total_chunks} returned "
                            f"HTTP {chunk_resp.status_code}"
                        ),
                    }

            finalize_resp = await client.post(
                f"{base}/api/uploads/{upload_id}/finalize",
                headers=headers,
            )
            if finalize_resp.status_code >= 400:
                return {
                    "ok": False,
                    "retryable": _classify(finalize_resp.status_code),
                    "http_status": finalize_resp.status_code,
                    "detail": f"MO finalize returned HTTP {finalize_resp.status_code}",
                }
            session_id: str | None = None
            try:
                fin = finalize_resp.json() if finalize_resp.content else {}
                if isinstance(fin, dict) and fin.get("session_id") is not None:
                    session_id = str(fin["session_id"])
            except Exception:
                session_id = None
            if session_id is None and not target_session_id:
                # A transcribe upload's session is created by MO's pipeline
                # worker moments after finalize; give it a few seconds so the
                # row can carry the session it landed in.
                session_id = await _poll_upload_session_id(client, base, upload_id, headers)
            return {
                "ok": True,
                "upload_id": upload_id,
                "session_id": session_id,
                "detail": (
                    "audio attached to Meeting-Ops session"
                    if target_session_id
                    else "Meeting-Ops session created from the recording"
                ),
            }
    except Exception as exc:
        return {
            "ok": False,
            "retryable": True,
            "detail": f"MO upload failed: {type(exc).__name__}: {exc}"[:500],
        }


async def _poll_upload_session_id(
    client: Any,
    base: str,
    upload_id: str,
    headers: dict[str, str],
    *,
    attempts: int = 4,
    delay_seconds: float = 2.0,
) -> str | None:
    """The session MO's pipeline created for a transcribe upload, if it has yet."""
    for _ in range(max(0, attempts)):
        await asyncio.sleep(delay_seconds)
        try:
            resp = await client.get(f"{base}/api/uploads/{upload_id}/status", headers=headers)
            if resp.status_code >= 400:
                return None
            body = resp.json()
            if isinstance(body, dict) and body.get("session_id") is not None:
                return str(body["session_id"])
        except Exception:
            return None
    return None


async def _sweep_stale_rows(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings | None = None,
    redis: Any = None,
    livekit: Any = None,
) -> None:
    """Terminalize rows whose owner died, so room leases free up loudly."""
    now = _now()
    stale_after = timedelta(seconds=max_duration_seconds(settings)) if settings else timedelta(hours=6)
    async with session_factory() as db:
        stale_starting = (
            (
                await db.execute(
                    select(CallEgress)
                    .where(
                        CallEgress.status == "starting",
                        CallEgress.updated_at < now - _STARTING_STALE_AFTER,
                    )
                    .with_for_update(skip_locked=True)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        stale_running = (
            (
                await db.execute(
                    select(CallEgress)
                    .where(
                        CallEgress.status.in_(("active", "stopping")),
                        CallEgress.updated_at < now - stale_after,
                    )
                    .with_for_update(skip_locked=True)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        reconciled: list[CallEgress] = []
        for row in stale_starting + stale_running:
            if livekit is None or not hasattr(livekit, "list_egress"):
                continue
            try:
                records = await livekit.list_egress(row.livekit_room_name)
                remote = next(
                    (item for item in records if getattr(item, "egress_id", None) == row.egress_id),
                    None,
                )
                if remote is not None and int(getattr(remote, "status", 0) or 0) in (3, 4, 5, 6):
                    await handle_egress_event(
                        db, settings or Settings(), "egress_ended", remote,
                        redis=redis, livekit=livekit,
                    )
                    reconciled.append(row)
            except Exception:
                logger.warning("call_recording_livekit_reconcile_failed", recording_id=str(row.id), exc_info=True)
        stale_starting = [row for row in stale_starting if row not in reconciled]
        stale_running = [row for row in stale_running if row not in reconciled]
        for row in stale_starting:
            row.status = "failed"
            row.error = "abandoned before StartEgress completed (worker died?)"
        for row in stale_running:
            row.status = "failed"
            row.error = "no egress_ended webhook received; LiveKit egress was not found"
        if stale_starting or stale_running:
            await db.commit()
            logger.error(
                "call_recording_stale_rows_terminalized",
                starting=len(stale_starting),
                running=len(stale_running),
            )
            for row in list(stale_starting) + list(stale_running):
                await _finish_row_side_effects(db, None, redis, row, row.livekit_room_name)
                await _announce_recording_failure(db, row, row.error or "recording lost")


async def _sweep_retention(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> int:
    """Delete storage objects + local files past ``retention_until``.

    ``legal_hold`` rows are never touched. A row is eligible while it still
    points at something (storage_url or file_path); once both are gone it
    drops out of the scan on its own. Returns how many rows were purged.
    """
    now = _now()
    purged = 0
    async with session_factory() as db:
        rows = (
            (
                await db.execute(
                    select(CallEgress)
                    .where(
                        CallEgress.retention_until.is_not(None),
                        CallEgress.retention_until < now,
                        CallEgress.legal_hold.is_(False),
                        CallEgress.status.in_(("complete", "failed")),
                        or_(
                            CallEgress.storage_url.is_not(None),
                            CallEgress.file_path.is_not(None),
                        ),
                    )
                    .order_by(CallEgress.retention_until.asc())
                    .with_for_update(skip_locked=True)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        for row in rows:
            outcome = await purge_recording_files(settings, row)
            if row.storage_url is None and row.file_path is None:
                purged += 1
            logger.info(
                "call_recording_retention_purged",
                recording_id=str(row.id),
                room_id=str(row.room_id),
                kind=row.kind,
                outcome=outcome,
            )
        if rows:
            await db.commit()
    return purged


async def _sweep_local_files_after_delivery(
    session_factory: async_sessionmaker[AsyncSession],
) -> int:
    """Unlink local files whose durable copy exists and whose hand-off is done."""
    freed = 0
    async with session_factory() as db:
        rows = (
            (
                await db.execute(
                    select(CallEgress)
                    .where(
                        CallEgress.status == "complete",
                        CallEgress.storage_url.is_not(None),
                        CallEgress.file_path.is_not(None),
                        CallEgress.handoff_status.in_(_HANDOFF_TERMINAL),
                    )
                    .with_for_update(skip_locked=True)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        for row in rows:
            if await asyncio.to_thread(_unlink_quietly, row.file_path):
                logger.info(
                    "call_recording_local_file_freed",
                    recording_id=str(row.id),
                    file_path=row.file_path,
                )
                row.file_path = None
                freed += 1
        if rows:
            await db.commit()
    return freed


_MEDIA_SESSION_BACKFILL_WINDOW = timedelta(hours=48)


async def _sweep_media_sessions(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> int:
    """Learn which session Meeting-Ops made for a media-created hand-off.

    A `transcribe` upload's session is created by MO's pipeline worker after
    finalize, often later than the short poll at delivery time. Until the row
    carries it, the recordings list cannot link the room to its session. Ask
    MO's upload status for delivered rows that still lack one (48 h window,
    20 per sweep); a pipeline that failed is written onto the row so it reads
    as what it is instead of "delivered".
    """
    if not handoff_configured(settings):
        return 0
    filled = 0
    async with session_factory() as db:
        rows = (
            (
                await db.execute(
                    select(CallEgress)
                    .where(
                        CallEgress.handoff_status == "delivered",
                        CallEgress.mo_upload_id.is_not(None),
                        CallEgress.mo_session_id.is_(None),
                        CallEgress.handoff_last_attempt_at
                        >= _now() - _MEDIA_SESSION_BACKFILL_WINDOW,
                    )
                    .with_for_update(skip_locked=True)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        if not rows:
            return 0
        base = upload_base_url(settings)
        headers = _handoff_headers(settings)
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0)) as client:
            for row in rows:
                try:
                    resp = await client.get(
                        f"{base}/api/uploads/{row.mo_upload_id}/status", headers=headers
                    )
                    if resp.status_code >= 400:
                        continue
                    body = resp.json()
                except Exception:
                    logger.warning(
                        "call_recording_media_session_probe_failed",
                        recording_id=str(row.id),
                        exc_info=True,
                    )
                    continue
                if not isinstance(body, dict):
                    continue
                session_id = body.get("session_id")
                error = body.get("error")
                if session_id is not None:
                    row.mo_session_id = str(session_id)
                    filled += 1
                    logger.info(
                        "call_recording_media_session_filled",
                        recording_id=str(row.id),
                        mo_session_id=row.mo_session_id,
                        pipeline_error=str(error)[:200] if error else None,
                    )
                if error:
                    # MO has the media; its own pipeline failed on it. With a
                    # session the link still works, so the row stays
                    # delivered and carries the reason; without one there is
                    # nothing to link and the row says so.
                    row.handoff_error = f"Meeting-Ops pipeline: {str(error)[:300]}"
                    if session_id is None:
                        row.handoff_status = "failed"
                    logger.error(
                        "call_recording_media_session_failed",
                        recording_id=str(row.id),
                        mo_upload_id=row.mo_upload_id,
                        mo_session_id=row.mo_session_id,
                        detail=row.handoff_error,
                    )
        await db.commit()
    return filled


async def _sweep_composite_slots(
    session_factory: async_sessionmaker[AsyncSession],
    redis: Any,
) -> None:
    """Reconcile the Redis semaphore against rows that are really in flight."""
    if redis is None:
        return
    async with session_factory() as db:
        live = (
            (
                await db.execute(
                    select(CallEgress.id).where(
                        CallEgress.kind == KIND_COMPOSITE,
                        CallEgress.status.in_(("starting", "active", "stopping")),
                    )
                )
            )
            .scalars()
            .all()
        )
    await recording_capacity.reconcile_composite_slots(redis, {str(i) for i in live})


async def run_maintenance_sweep(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    redis: Any = None,
    livekit: Any = None,
) -> None:
    """Everything the 2-minute sweep does; each step fails independently."""
    for step in (
        lambda: _sweep_stale_rows(session_factory, settings, redis, livekit),
        lambda: _sweep_retention(session_factory, settings),
        lambda: _sweep_local_files_after_delivery(session_factory),
        lambda: _sweep_media_sessions(session_factory, settings),
        lambda: _sweep_composite_slots(session_factory, redis),
    ):
        try:
            await step()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("call_recording_sweep_step_failed")


async def _claim_one_handoff(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> uuid.UUID | None:
    now = _now()
    eligible = or_(
        and_(
            CallEgress.handoff_status == "pending",
            or_(
                CallEgress.handoff_next_attempt_at.is_(None),
                CallEgress.handoff_next_attempt_at <= now,
            ),
        ),
        and_(
            CallEgress.handoff_status == "delivering",
            CallEgress.handoff_last_attempt_at < now - _DELIVERING_STALE_AFTER,
        ),
    )
    if handoff_configured(settings):
        eligible = or_(eligible, CallEgress.handoff_status == "blocked")

    async with session_factory() as db:
        row = (
            await db.execute(
                select(CallEgress)
                .where(eligible)
                .order_by(CallEgress.created_at.asc())
                .with_for_update(skip_locked=True)
                .limit(1)
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.handoff_status = "delivering"
        row.handoff_attempts += 1
        row.handoff_last_attempt_at = now
        row.handoff_next_attempt_at = None
        await db.commit()
        return row.id


async def _deliver_claimed_handoff(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    row_id: uuid.UUID,
) -> None:
    async with session_factory() as db:
        row = await db.get(CallEgress, row_id)
        if row is None or row.handoff_status != "delivering":
            return
        attempts = row.handoff_attempts
        file_path = Path(row.file_path) if row.file_path else None
        session_id = row.mo_session_id or await _find_meeting_ops_session(db, row)
        ended_at = row.ended_at or row.created_at
        room_id = row.room_id
        content_type = recording_storage.CONTENT_TYPES.get(row.kind or KIND_AUDIO, "audio/ogg")

        if not handoff_configured(settings):
            row.handoff_status = "blocked"
            row.handoff_error = (
                handoff_config_error(settings) or "hand-off not configured"
            )
            await db.commit()
            return

        # exists() can RAISE (not return False) when the volume mount or its
        # permissions are broken — that is an ops problem, not a lost file,
        # so it retries with backoff instead of terminalizing the row.
        file_unreadable: str | None = None
        file_missing = file_path is None
        if file_path is not None:
            try:
                file_missing = not file_path.exists()
            except OSError as exc:
                file_unreadable = f"{type(exc).__name__}: {exc}"

        if file_missing:
            row.handoff_status = "failed"
            row.handoff_error = f"audio file missing: {row.file_path}"
            await db.commit()
            logger.error(
                "call_recording_handoff_file_missing",
                egress_id=row.egress_id,
                file_path=row.file_path,
            )
            return

        if file_unreadable is not None:
            exhausted = attempts >= settings.call_recording_handoff_max_attempts
            row.handoff_status = "failed" if exhausted else "pending"
            row.handoff_error = f"audio file unreadable: {file_unreadable}"
            if not exhausted:
                row.handoff_next_attempt_at = _now() + timedelta(
                    seconds=_backoff_seconds(settings, attempts)
                )
            await db.commit()
            logger.error(
                "call_recording_handoff_file_unreadable",
                egress_id=row.egress_id,
                file_path=row.file_path,
                attempts=attempts,
                detail=file_unreadable,
            )
            return

        # Durable copy FIRST (Garage on the LAN). A failing upload holds the
        # MO attach back and retries with the same backoff, so an operator
        # sees ONE stuck row with a storage error rather than a delivered
        # session and a silently missing file.
        if recording_storage.storage_configured(settings) and not row.storage_url:
            outcome = await _upload_to_storage(settings, row)
            if outcome.get("ok"):
                await db.commit()
                logger.info(
                    "call_recording_storage_uploaded",
                    egress_id=row.egress_id,
                    room_id=str(room_id),
                    kind=row.kind,
                    storage_url=row.storage_url,
                )
            else:
                exhausted = attempts >= settings.call_recording_handoff_max_attempts
                row.handoff_status = "failed" if exhausted else "pending"
                row.handoff_error = f"storage upload: {outcome.get('detail') or 'failed'}"
                if not exhausted:
                    row.handoff_next_attempt_at = _now() + timedelta(
                        seconds=_backoff_seconds(settings, attempts)
                    )
                await db.commit()
                logger.error(
                    "call_recording_storage_upload_failed",
                    egress_id=row.egress_id,
                    attempts=attempts,
                    detail=row.handoff_error,
                )
                return

        if session_id is None:
            waited = (_now() - ended_at).total_seconds()
            if waited <= settings.call_recording_session_wait_seconds:
                row.handoff_status = "pending"
                row.handoff_error = "waiting for the call's Meeting-Ops session"
                row.handoff_next_attempt_at = _now() + timedelta(
                    seconds=_backoff_seconds(settings, attempts)
                )
                await db.commit()
                return
            # Nobody exported a transcript for this call (or the window
            # missed). The file is not orphaned: MO's transcribe upload makes
            # the session from the media itself.
            logger.warning(
                "call_recording_handoff_session_from_media",
                egress_id=row.egress_id,
                room_id=str(room_id),
                waited_seconds=int(waited),
            )
        else:
            # Remember the target before the network call so retries stay sticky.
            row.mo_session_id = session_id
            await db.commit()
        filename = file_path.name

    result = await upload_audio_to_meeting_ops(
        settings,
        file_path=file_path,
        target_session_id=session_id,
        filename=filename,
        content_type=content_type,
    )

    async with session_factory() as db:
        row = await db.get(CallEgress, row_id, with_for_update=True)
        if row is None or row.handoff_status != "delivering":
            return
        if result.get("ok"):
            row.handoff_status = "delivered"
            row.mo_upload_id = str(result.get("upload_id") or "") or None
            if not row.mo_session_id and result.get("session_id"):
                row.mo_session_id = str(result["session_id"])
            row.handoff_error = None
            logger.info(
                "call_recording_handoff_delivered",
                egress_id=row.egress_id,
                room_id=str(row.room_id),
                kind=row.kind,
                mo_session_id=row.mo_session_id,
                mo_upload_id=row.mo_upload_id,
                attempts=row.handoff_attempts,
            )
        elif (
            result.get("retryable", False)
            and row.handoff_attempts < settings.call_recording_handoff_max_attempts
        ):
            row.handoff_status = "pending"
            row.handoff_error = result.get("detail") or "transient MO upload failure"
            row.handoff_next_attempt_at = _now() + timedelta(
                seconds=_backoff_seconds(settings, row.handoff_attempts)
            )
            logger.warning(
                "call_recording_handoff_retry",
                egress_id=row.egress_id,
                attempts=row.handoff_attempts,
                detail=row.handoff_error,
            )
        else:
            row.handoff_status = "failed"
            row.handoff_error = result.get("detail") or "MO upload failed"
            logger.error(
                "call_recording_handoff_failed",
                egress_id=row.egress_id,
                room_id=str(row.room_id),
                mo_session_id=row.mo_session_id,
                attempts=row.handoff_attempts,
                detail=row.handoff_error,
            )
        # Local cleanup: the durable copy exists and the hand-off is settled.
        if (
            row.handoff_status in _HANDOFF_TERMINAL
            and row.storage_url
            and row.file_path
            and await asyncio.to_thread(_unlink_quietly, row.file_path)
        ):
            logger.info(
                "call_recording_local_file_freed",
                egress_id=row.egress_id,
                file_path=row.file_path,
            )
            row.file_path = None
        await db.commit()


async def deliver_handoff_now(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> bool:
    claimed = await _claim_one_handoff(session_factory, settings)
    if claimed is None:
        return False
    await _deliver_claimed_handoff(session_factory, settings, claimed)
    return True


async def run_call_recording_handoff(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    redis: Any = None,
    livekit: Any = None,
) -> None:
    """Continuously drain hand-off rows; safe in every uvicorn worker."""
    poll = max(0.5, settings.call_recording_handoff_poll_seconds)
    next_sweep = _now()
    while True:
        try:
            if _now() >= next_sweep:
                await run_maintenance_sweep(session_factory, settings, redis, livekit)
                next_sweep = _now() + timedelta(minutes=2)
            worked = await deliver_handoff_now(session_factory, settings)
            if not worked:
                await asyncio.sleep(poll)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("call_recording_handoff_worker_error")
            await asyncio.sleep(poll)
