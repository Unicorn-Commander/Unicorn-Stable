"""Thread auto-archive (design §3, L2 item 2).

Threads idle for 14 days become ``is_archived``; any new message unarchives.
Two halves:

* :func:`run_thread_auto_archive` — a periodic task started from
  ``main.py`` in the outbox-worker pattern (every uvicorn worker may run it;
  the UPDATEs are idempotent, so overlapping passes cannot double-archive).
  Each pass archives idle threads and, as a safety net, unarchives threads
  that got a message after they were archived but whose send path could not
  run the immediate hook.
* :func:`unarchive_thread_on_message` — the immediate hook, called from the
  tail of ``MessageService.send_message`` when the room it just posted into
  is an archived thread. One UPDATE, only in that case; the common send path
  costs nothing extra.

"Idle" is measured from the newest non-deleted message in the thread, falling
back to the thread's ``updated_at`` (its creation for a thread nobody wrote
in). ``rooms.updated_at`` alone would not do: message sends do not bump it.

Both directions fan out ``thread_archived`` (``payload.is_archived`` says
which way) to the thread AND its parent room, so a Threads panel that is open
moves the row without a refetch.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog
from sqlalchemy import DateTime, Text, bindparam, cast, func, literal, literal_column, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from app.models.message import Message
from app.models.room import Room

logger = structlog.get_logger(__name__)

#: Design §3: "Threads auto-archive after 14 idle days".
THREAD_IDLE_DAYS_DEFAULT = 14
#: rooms.metadata key stamped when a thread is archived (by the sweep or by
#: PATCH is_archived=true); removed again on unarchive. The sweep's safety
#: net compares the newest message against it.
THREAD_ARCHIVED_AT_KEY = "thread_archived_at"
THREAD_ARCHIVED_REASON_KEY = "thread_archived_reason"
#: Room-scoped WS event (mirrored in app.ws.events.THREAD_ARCHIVED).
THREAD_ARCHIVED_EVENT = "thread_archived"

_EMPTY_JSONB = literal_column("'{}'::jsonb")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def archive_stamp(now: datetime, reason: str) -> dict[str, Any]:
    return {THREAD_ARCHIVED_AT_KEY: now.isoformat(), THREAD_ARCHIVED_REASON_KEY: reason}


def _last_activity(thread) -> Any:
    """Newest non-deleted message timestamp in ``thread`` (an aliased Room)."""
    return (
        select(func.max(Message.created_at))
        .where(Message.room_id == thread.id, Message.is_deleted == False)  # noqa: E712
        .correlate(thread)
        .scalar_subquery()
    )


def idle_threads_update(*, now: datetime, idle_days: int, batch: int):
    """``UPDATE rooms … RETURNING id, parent_room_id`` for up to ``batch``
    threads whose last activity is older than ``idle_days``."""
    thread = aliased(Room, name="thread")
    cutoff = now - timedelta(days=idle_days)
    idle_ids = (
        select(thread.id)
        .where(
            thread.parent_room_id.is_not(None),
            thread.is_archived == False,  # noqa: E712
            func.coalesce(_last_activity(thread), thread.updated_at) < cutoff,
        )
        .order_by(thread.updated_at.asc())
        .limit(batch)
    )
    stamp = bindparam("archive_stamp", value=archive_stamp(now, "idle"), type_=JSONB)
    return (
        update(Room)
        .where(Room.id.in_(idle_ids))
        .values(
            is_archived=True,
            metadata_=func.coalesce(Room.metadata_, _EMPTY_JSONB).op("||")(stamp),
        )
        .returning(Room.id, Room.parent_room_id)
    )


def _without_archive_stamp():
    """``metadata - 'thread_archived_at'`` (the reason key is left as history)."""
    return func.coalesce(Room.metadata_, _EMPTY_JSONB).op("-")(
        cast(literal(THREAD_ARCHIVED_AT_KEY), Text)
    )


def stale_archived_threads_update(*, batch: int):
    """Archived threads that received a message AFTER they were archived —
    the safety net for a send path whose immediate hook could not run."""
    thread = aliased(Room, name="thread")
    archived_at = thread.metadata_[THREAD_ARCHIVED_AT_KEY].astext.cast(DateTime(timezone=True))
    stale_ids = (
        select(thread.id)
        .where(
            thread.parent_room_id.is_not(None),
            thread.is_archived == True,  # noqa: E712
            thread.metadata_.has_key(THREAD_ARCHIVED_AT_KEY),
            _last_activity(thread) > archived_at,
        )
        .limit(batch)
    )
    return (
        update(Room)
        .where(Room.id.in_(stale_ids))
        .values(is_archived=False, metadata_=_without_archive_stamp())
        .returning(Room.id, Room.parent_room_id)
    )


def unarchive_thread_update(room_id: Any):
    """Unarchive ONE archived thread (no-op rows return nothing)."""
    return (
        update(Room)
        .where(
            Room.id == room_id,
            Room.is_archived == True,  # noqa: E712
            Room.parent_room_id.is_not(None),
        )
        .values(is_archived=False, metadata_=_without_archive_stamp())
        .returning(Room.id, Room.parent_room_id)
    )


async def _fanout(room_id: Any, parent_room_id: Any, *, archived: bool, reason: str) -> None:
    """``thread_archived`` to the thread and its parent. Best-effort."""
    payload = {
        "room_id": str(room_id),
        "parent_room_id": str(parent_room_id) if parent_room_id is not None else None,
        "is_archived": archived,
        "reason": reason,
    }
    try:
        from app.api.messages import _ws_broadcast_room

        envelope = {"type": THREAD_ARCHIVED_EVENT, "payload": payload}
        await _ws_broadcast_room(None, room_id, envelope)
        if parent_room_id is not None:
            await _ws_broadcast_room(None, parent_room_id, envelope)
    except Exception:
        logger.warning("thread_archived_fanout_failed", room_id=str(room_id), exc_info=True)


def _returned_rows(result: Any) -> list[tuple[Any, Any]]:
    """Rows of an UPDATE … RETURNING as ``(id, parent_room_id)`` tuples.
    Anything that is not a real row (a mocked session) is ignored."""
    rows: list[tuple[Any, Any]] = []
    try:
        raw = result.all()
    except Exception:
        return rows
    for row in raw if isinstance(raw, (list, tuple)) else []:
        if isinstance(row, (str, bytes)) or not hasattr(row, "__getitem__"):
            continue
        try:
            rid, parent = row[0], row[1]
        except (TypeError, IndexError, KeyError):
            continue
        if rid is None:
            continue
        rows.append((rid, parent))
    return rows


async def archive_idle_threads(
    db: AsyncSession, *, idle_days: int = THREAD_IDLE_DAYS_DEFAULT, batch: int = 500, now: datetime | None = None
) -> int:
    now = now or _now()
    rows = _returned_rows(await db.execute(idle_threads_update(now=now, idle_days=idle_days, batch=batch)))
    await db.commit()
    for rid, parent in rows:
        await _fanout(rid, parent, archived=True, reason="idle")
    if rows:
        logger.info("threads_auto_archived", count=len(rows), idle_days=idle_days)
    return len(rows)


async def unarchive_stale_threads(db: AsyncSession, *, batch: int = 500) -> int:
    rows = _returned_rows(await db.execute(stale_archived_threads_update(batch=batch)))
    await db.commit()
    for rid, parent in rows:
        await _fanout(rid, parent, archived=False, reason="message")
    if rows:
        logger.info("threads_unarchived_by_sweep", count=len(rows))
    return len(rows)


async def unarchive_thread_on_message(db: AsyncSession, room_id: Any) -> bool:
    """Immediate half of "any new message unarchives". Called from
    ``MessageService.send_message`` only when the room is a known archived
    thread; returns True when a row flipped."""
    rows = _returned_rows(await db.execute(unarchive_thread_update(room_id)))
    if not rows:
        return False
    await db.commit()
    rid, parent = rows[0]
    logger.info("thread_unarchived_on_message", room_id=str(rid))
    await _fanout(rid, parent, archived=False, reason="message")
    return True


async def sweep_threads(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    idle_days: int = THREAD_IDLE_DAYS_DEFAULT,
    batch: int = 500,
    now: datetime | None = None,
) -> dict[str, int]:
    """One pass: archive idle threads, then unarchive stale-archived ones."""
    async with session_factory() as db:
        archived = await archive_idle_threads(db, idle_days=idle_days, batch=batch, now=now)
        unarchived = await unarchive_stale_threads(db, batch=batch)
    return {"archived": archived, "unarchived": unarchived}


async def run_thread_auto_archive(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Any,
) -> None:
    """Run the sweep forever. Started from the app lifespan (main.py), same
    shape as ``run_guest_reaper`` / ``run_transcript_outbox``: one bad pass
    is logged and never ends the worker."""
    interval = max(30.0, float(getattr(settings, "thread_auto_archive_interval_seconds", 600) or 600))
    idle_days = max(1, int(getattr(settings, "thread_auto_archive_idle_days", THREAD_IDLE_DAYS_DEFAULT) or 0))
    batch = max(1, int(getattr(settings, "thread_auto_archive_batch", 500) or 500))
    logger.info(
        "thread_auto_archive_loop_started",
        interval_seconds=interval,
        idle_days=idle_days,
        batch=batch,
    )
    while True:
        try:
            await sweep_threads(session_factory, idle_days=idle_days, batch=batch)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("thread_auto_archive_pass_failed")
        await asyncio.sleep(interval)


__all__ = [
    "THREAD_IDLE_DAYS_DEFAULT",
    "THREAD_ARCHIVED_AT_KEY",
    "THREAD_ARCHIVED_REASON_KEY",
    "THREAD_ARCHIVED_EVENT",
    "archive_stamp",
    "idle_threads_update",
    "stale_archived_threads_update",
    "unarchive_thread_update",
    "archive_idle_threads",
    "unarchive_stale_threads",
    "unarchive_thread_on_message",
    "sweep_threads",
    "run_thread_auto_archive",
]
