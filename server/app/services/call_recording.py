"""Automatic call-audio recording (LiveKit egress) → Meeting-Ops hand-off.

When a call becomes active in a room (first non-service participant joins the
LiveKit room), Stable starts ONE audio-only ``room_composite`` egress for that
call. When the call ends (occupancy hits zero, or the LiveKit room is
destroyed), the egress is stopped. LiveKit's ``egress_ended`` webhook then
hands us the finished OGG on the shared output volume, and a durable outbox
worker attaches it to the Meeting-Ops session that the transcript export lane
created for the same call — through Meeting-Ops' own chunked upload API with
``action=attach``, so MO's normal processing (transcription, diarization,
summary) runs against the real call audio.

Failure doctrine: recording is a bystander. Nothing in this module may break
the call itself, presence bookkeeping, or the webhook 200 — every entry point
called from the webhook path is fail-open and logs loudly instead of raising.

Concurrency doctrine: the backend runs uvicorn ``--workers 4``; any "only
once" decision in this module is enforced by a database row (the partial
unique lease index on ``call_egresses.room_id``) or ``FOR UPDATE SKIP
LOCKED`` claims — never by in-process state.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import structlog
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.models.call_egress import ACTIVE_EGRESS_STATUSES, CallEgress
from app.models.room import Room, TranscriptExport

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

# An egress `active`/`stopping` with no terminal webhook after this long is
# lost (webhook dropped, egress crashed hard). Terminalize so the room lease
# frees and the operator sees it.
_EGRESS_STALE_AFTER = timedelta(hours=6)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def is_service_identity(identity: str) -> bool:
    """True for identities that observe/record but are not call participants."""
    value = str(identity or "")
    return value.startswith("broadcast-") or value.startswith(EGRESS_IDENTITY_PREFIX)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def recording_enabled(settings: Settings) -> bool:
    return bool(settings.call_recording_enabled)


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
# Egress lifecycle (webhook-driven)
# ---------------------------------------------------------------------------


async def ensure_room_recording(
    db: AsyncSession,
    settings: Settings,
    livekit: Any,
    room: Room,
) -> CallEgress | None:
    """Start ONE audio egress for this room's live call, across all workers.

    The INSERT into the leased partial unique index decides the winner; the
    losers get an IntegrityError and walk away silently. Returns the row when
    THIS caller started (or owns) the recording, else None.
    """
    if not recording_enabled(settings):
        return None
    if room is None or not getattr(room, "livekit_room_name", None):
        return None

    row = CallEgress(
        id=uuid.uuid4(),
        room_id=room.id,
        livekit_room_name=room.livekit_room_name,
        status="starting",
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        # Another worker (or an earlier join) already owns this call's lease.
        await db.rollback()
        return None
    await db.refresh(row)

    output_dir = (settings.call_recording_output_dir or "/egress-out").rstrip("/")
    stamp = _now().strftime("%Y%m%dT%H%M%SZ")
    filepath = f"{output_dir}/stable-call-{room.id}-{stamp}.ogg"

    try:
        info = await livekit.start_room_audio_egress(room.livekit_room_name, filepath)
    except Exception as exc:
        # Fail OPEN: the call continues unrecorded; free the lease and shout.
        row.status = "failed"
        row.error = f"StartEgress failed: {type(exc).__name__}: {exc}"[:2000]
        row.ended_at = _now()
        await db.commit()
        logger.error(
            "call_recording_start_failed",
            room_id=str(room.id),
            livekit_room=room.livekit_room_name,
            error=str(exc),
        )
        return None

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
        filepath=filepath,
    )
    return row


async def stop_room_recording(
    db: AsyncSession,
    settings: Settings,
    livekit: Any,
    room: Room,
    *,
    reason: str,
) -> int:
    """Ask LiveKit to stop every non-terminal egress for this room.

    Idempotent and multi-worker safe: StopEgress on an already-stopping egress
    is an error LiveKit reports and we swallow — ``egress_ended`` remains the
    single authority for terminal state.
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
    if rows:
        await db.commit()
        logger.info(
            "call_recording_stop_requested",
            room_id=str(room.id),
            reason=reason,
            egress_count=len(rows),
        )
    return stopped


async def stop_room_recording_if_idle(
    db: AsyncSession,
    settings: Settings,
    livekit: Any,
    room: Room,
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
        await stop_room_recording(db, settings, livekit, room, reason="room_idle")


async def handle_egress_event(
    db: AsyncSession,
    settings: Settings,
    event_type: str,
    egress_info: Any,
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
            file_path=file_path,
            file_size=file_size,
            duration_seconds=duration_s,
            handoff_status=row.handoff_status,
        )
    else:
        row.status = "failed"
        row.error = (error_text or f"egress ended with status {status_code}")[:2000]
        logger.error(
            "call_recording_failed",
            egress_id=row.egress_id,
            room_id=str(row.room_id),
            egress_status=status_code,
            error=error_text,
        )
    await db.commit()


# ---------------------------------------------------------------------------
# Meeting-Ops audio hand-off (durable outbox)
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
    target_session_id: str,
    filename: str,
) -> dict[str, Any]:
    """Attach one audio file to an existing MO session via MO's upload API.

    start → chunk* → finalize, honoring the server-assigned chunk size.
    Returns a status dict; never raises.
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
            start_resp = await client.post(
                f"{base}/api/uploads/start",
                json={
                    "filename": filename,
                    "total_size": total_size,
                    "content_type": "audio/ogg",
                    "action": "attach",
                    "target_session_id": target_session_id,
                },
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
                    files={"data": (filename, chunk, "audio/ogg")},
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
            return {
                "ok": True,
                "upload_id": upload_id,
                "detail": "audio attached to Meeting-Ops session",
            }
    except Exception as exc:
        return {
            "ok": False,
            "retryable": True,
            "detail": f"MO upload failed: {type(exc).__name__}: {exc}"[:500],
        }


async def _sweep_stale_rows(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Terminalize rows whose owner died, so room leases free up loudly."""
    now = _now()
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
                        CallEgress.updated_at < now - _EGRESS_STALE_AFTER,
                    )
                    .with_for_update(skip_locked=True)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        for row in stale_starting:
            row.status = "failed"
            row.error = "abandoned before StartEgress completed (worker died?)"
        for row in stale_running:
            row.status = "failed"
            row.error = "no egress_ended webhook received; recording state lost"
        if stale_starting or stale_running:
            await db.commit()
            logger.error(
                "call_recording_stale_rows_terminalized",
                starting=len(stale_starting),
                running=len(stale_running),
            )


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

        if session_id is None:
            waited = (_now() - ended_at).total_seconds()
            if waited > settings.call_recording_session_wait_seconds:
                row.handoff_status = "no_session"
                row.handoff_error = (
                    "no delivered Meeting-Ops transcript session matched this "
                    "call's recording window"
                )
                await db.commit()
                logger.error(
                    "call_recording_handoff_no_session",
                    egress_id=row.egress_id,
                    room_id=str(room_id),
                    waited_seconds=int(waited),
                )
            else:
                row.handoff_status = "pending"
                row.handoff_error = "waiting for the call's Meeting-Ops session"
                row.handoff_next_attempt_at = _now() + timedelta(
                    seconds=_backoff_seconds(settings, attempts)
                )
                await db.commit()
            return

        # Remember the target before the network call so retries stay sticky.
        row.mo_session_id = session_id
        await db.commit()
        filename = file_path.name

    result = await upload_audio_to_meeting_ops(
        settings,
        file_path=file_path,
        target_session_id=session_id,
        filename=filename,
    )

    async with session_factory() as db:
        row = await db.get(CallEgress, row_id, with_for_update=True)
        if row is None or row.handoff_status != "delivering":
            return
        if result.get("ok"):
            row.handoff_status = "delivered"
            row.mo_upload_id = str(result.get("upload_id") or "") or None
            row.handoff_error = None
            logger.info(
                "call_recording_handoff_delivered",
                egress_id=row.egress_id,
                room_id=str(row.room_id),
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
) -> None:
    """Continuously drain hand-off rows; safe in every uvicorn worker."""
    poll = max(0.5, settings.call_recording_handoff_poll_seconds)
    next_sweep = _now()
    while True:
        try:
            if _now() >= next_sweep:
                await _sweep_stale_rows(session_factory)
                next_sweep = _now() + timedelta(minutes=2)
            worked = await deliver_handoff_now(session_factory, settings)
            if not worked:
                await asyncio.sleep(poll)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("call_recording_handoff_worker_error")
            await asyncio.sleep(poll)
