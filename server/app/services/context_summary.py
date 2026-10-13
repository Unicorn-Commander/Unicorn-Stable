"""Rolling room summary — design §4, lane L4.

Long rooms do not fit a 6k-token context window. Every
``context_summary_every_messages`` (default 50) new messages per room — or
on demand, ``POST /rooms/{id}/context/summarize`` by an owner/admin — this
module folds the delta since the previous summary's watermark into a new
summary and writes it to ``rooms.metadata.context_summary``::

    {"text": ..., "watermark": <message id>, "watermark_ts": <iso>,
     "updated_at": <iso>, "message_count": <n>, "model": <name>}

The context builder prepends ``text`` when the watermark precedes the window
it hands an agent, so the agent still knows what happened before the lines
it can see.

WHERE IT RUNS. The model is reached through the LiteLLM gateway
(OpenAI-compatible ``/chat/completions``); the default lane is
the configured long-context model on deployment-owned hardware — a room
summary is the room's content (customer names included) and never leaves the
box. Base URL, key and model come from the environment
(``CONTEXT_SUMMARY_BASE_URL`` / ``CONTEXT_SUMMARY_API_KEY`` /
``CONTEXT_SUMMARY_MODEL``) and are never logged or returned.

OFF BY DEFAULT. ``CONTEXT_SUMMARY_ENABLED`` gates everything: the worker
exits at startup when the feature is off or unconfigured, and the endpoint
answers 503 with the reason (names of the missing settings, never values).

OFF THE SEND PATH. Nothing here runs inside a message POST. The worker is
an asyncio task started from the lifespan like the transcript outbox: it
polls, finds rooms whose delta crossed the threshold, and summarizes them
one at a time. A per-room Redis lease keeps the four uvicorn workers from
summarizing the same room at once; a lost lease fails open (a duplicate
summary is harmless — last write wins).
"""

from __future__ import annotations

import asyncio
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import structlog
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.models.message import Message
from app.models.room import Room
from app.services.context_builder import (
    MAX_SUMMARY_CHARS,
    entry_from_message,
    format_entry_line,
    is_abandoned,
)

logger = structlog.get_logger(__name__)

DEFAULT_MODEL = "qwen3.6-35b-long-batch"
DEFAULT_EVERY_MESSAGES = 50
#: Newest rows folded into one summary call; older unsummarized lines are
#: left behind rather than paged through (a first summary of a 2,000-line
#: room covers its last 400 lines, which is what the agent needs).
MAX_DELTA_MESSAGES = 400
#: Bound on the rendered delta handed to the model (chars); the oldest lines
#: are dropped first when it overflows.
MAX_DELTA_CHARS = 60_000
MAX_LINE_CHARS = 1_500
LEASE_PREFIX = "stable:context_summary:lease:"

_THINK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)


class SummaryError(RuntimeError):
    """A summary could not be produced; the message is safe to surface."""


@dataclass(frozen=True)
class SummaryConfig:
    enabled: bool
    base_url: str
    api_key: str
    model: str
    every_messages: int
    poll_seconds: float
    lookback_days: int
    timeout_seconds: float
    max_chars: int


def summary_config(settings: Any) -> SummaryConfig:
    """Read the feature's settings (all ``CONTEXT_SUMMARY_*`` env names)."""

    def get(name: str, default: Any) -> Any:
        value = getattr(settings, name, default)
        return default if value is None else value

    return SummaryConfig(
        enabled=bool(get("context_summary_enabled", False)),
        base_url=str(get("context_summary_base_url", "")).strip().rstrip("/"),
        api_key=str(get("context_summary_api_key", "")).strip(),
        model=str(get("context_summary_model", DEFAULT_MODEL)).strip() or DEFAULT_MODEL,
        every_messages=max(1, int(get("context_summary_every_messages", DEFAULT_EVERY_MESSAGES))),
        poll_seconds=max(5.0, float(get("context_summary_poll_seconds", 60.0))),
        lookback_days=max(1, int(get("context_summary_lookback_days", 30))),
        timeout_seconds=max(10.0, float(get("context_summary_timeout_seconds", 180.0))),
        max_chars=max(200, min(int(get("context_summary_max_chars", MAX_SUMMARY_CHARS)), MAX_SUMMARY_CHARS)),
    )


def config_error(cfg: SummaryConfig) -> str | None:
    """Why summaries cannot run, in words safe to return to a client: the
    NAME of what is missing, never a value."""
    if not cfg.enabled:
        return "Room summaries are disabled (CONTEXT_SUMMARY_ENABLED)"
    if not cfg.base_url:
        return "Room summaries are not configured (CONTEXT_SUMMARY_BASE_URL)"
    if not cfg.api_key:
        return "Room summaries are not configured (CONTEXT_SUMMARY_API_KEY)"
    if not cfg.model:
        return "Room summaries are not configured (CONTEXT_SUMMARY_MODEL)"
    return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def strip_thinking(text: str) -> str:
    """Drop ``<think>…</think>`` blocks a reasoning model may emit."""
    return _THINK_RE.sub("", text or "").strip()


def cap_text(text: str, max_chars: int) -> str:
    text = (text or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def previous_summary(room_meta: Any) -> dict[str, Any] | None:
    if not isinstance(room_meta, dict):
        return None
    cs = room_meta.get("context_summary")
    return cs if isinstance(cs, dict) else None


def render_lines(messages: list[Any]) -> list[str]:
    """``[MM-DD HH:MM] Name: text`` per message (oldest first), replies and
    voice lines marked the way the builder marks them, abandoned
    placeholders skipped, each line and the whole block bounded."""
    lines: list[str] = []
    for m in messages:
        if is_abandoned(m):
            continue
        entry = entry_from_message(m)
        stamp = ""
        ts = _as_utc(entry.get("ts"))
        if ts is not None:
            stamp = f"[{ts.strftime('%m-%d %H:%M')}] "
        line = stamp + format_entry_line(entry).replace("\n", " ").strip()
        lines.append(cap_text(line, MAX_LINE_CHARS))
    total = sum(len(line) + 1 for line in lines)
    while lines and total > MAX_DELTA_CHARS:
        total -= len(lines[0]) + 1
        lines.pop(0)
    return lines


def build_summary_messages(
    *,
    room_name: str,
    previous: str | None,
    lines: list[str],
    max_chars: int,
) -> list[dict[str, str]]:
    """The chat-completions request body's messages (pure)."""
    max_words = max(80, max_chars // 6)
    system = (
        "You maintain the rolling summary of a chat room so that an AI teammate "
        "who joins the conversation later knows what has happened. Update the "
        "previous summary with the new messages. Keep who is involved, decisions, "
        "facts, numbers, names of things, open questions and commitments, in the "
        "order they happened; drop greetings and chit-chat. Write plain prose or "
        f"short bullets, at most {max_words} words. Never invent anything, never "
        "add commentary, never address the reader. Output only the updated summary."
    )
    user = (
        f"Room: {room_name}\n\n"
        f"Previous summary:\n{(previous or '').strip() or '(none yet)'}\n\n"
        f"New messages (oldest first):\n" + "\n".join(lines)
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def request_summary(
    cfg: SummaryConfig,
    messages: list[dict[str, str]],
    *,
    http: httpx.AsyncClient | None = None,
) -> str:
    """POST the summary request to the gateway and return the text.

    ``http`` is injectable for tests (a fake gateway); otherwise a client is
    opened against ``cfg.base_url`` for this one call. Logs carry the model
    and HTTP status only — never the URL or the key.
    """
    own_client = http is None
    client = http or httpx.AsyncClient(
        base_url=cfg.base_url, timeout=httpx.Timeout(cfg.timeout_seconds, connect=10.0)
    )
    body = {
        "model": cfg.model,
        "messages": messages,
        "max_tokens": max(256, cfg.max_chars // 3),
        "temperature": 0.2,
    }
    try:
        try:
            resp = await client.post(
                "/chat/completions",
                headers={"Authorization": f"Bearer {cfg.api_key}"},
                json=body,
            )
        except httpx.HTTPError as exc:
            raise SummaryError(f"summary gateway unreachable ({type(exc).__name__})") from exc
    finally:
        if own_client:
            await client.aclose()
    if resp.status_code != 200:
        logger.warning("context_summary_http_error", status=resp.status_code, model=cfg.model)
        raise SummaryError(f"summary gateway HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise SummaryError("summary gateway returned a non-JSON body") from exc
    content = ""
    if isinstance(data, dict):
        choices = data.get("choices") or []
        if choices and isinstance(choices[0], dict):
            message = choices[0].get("message") or {}
            content = message.get("content") if isinstance(message, dict) else ""
    text = strip_thinking(content if isinstance(content, str) else "")
    if not text:
        raise SummaryError("summary gateway returned an empty completion")
    return text


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


async def _load_room(db: AsyncSession, room_id: uuid.UUID) -> Room | None:
    return (await db.execute(select(Room).where(Room.id == room_id))).scalar_one_or_none()


async def load_delta(
    db: AsyncSession, room_id: uuid.UUID, after_ts: datetime | None, cap: int = MAX_DELTA_MESSAGES
) -> list[Any]:
    """The newest ``cap`` live messages after ``after_ts``, oldest first."""
    stmt = (
        select(Message)
        .where(Message.room_id == room_id, Message.is_deleted == False)  # noqa: E712
        .options(selectinload(Message.sender))
        .order_by(desc(Message.created_at))
        .limit(cap)
    )
    if after_ts is not None:
        stmt = stmt.where(Message.created_at > after_ts)
    rows = list((await db.execute(stmt)).scalars().all())
    rows.reverse()
    return rows


async def count_new_messages(db: AsyncSession, room_id: uuid.UUID, after_ts: datetime) -> int:
    stmt = select(func.count(Message.id)).where(
        Message.room_id == room_id,
        Message.is_deleted == False,  # noqa: E712
        Message.created_at > after_ts,
    )
    return int((await db.execute(stmt)).scalar_one() or 0)


async def find_due_rooms(
    db: AsyncSession, *, threshold: int, lookback_days: int
) -> list[uuid.UUID]:
    """Rooms whose live messages since their summary watermark number at
    least ``threshold``. Bounded to rooms active in the last
    ``lookback_days`` so the sweep never walks the whole table."""
    floor = _now() - timedelta(days=lookback_days)
    candidates_stmt = (
        select(Message.room_id, func.count(Message.id))
        .where(Message.is_deleted == False, Message.created_at >= floor)  # noqa: E712
        .group_by(Message.room_id)
        .having(func.count(Message.id) >= threshold)
    )
    candidates = [row[0] for row in (await db.execute(candidates_stmt)).all()]
    due: list[uuid.UUID] = []
    for room_id in candidates:
        room_meta = (
            await db.execute(select(Room.metadata_).where(Room.id == room_id))
        ).scalar_one_or_none()
        prev = previous_summary(room_meta)
        after_ts = _as_utc(prev.get("watermark_ts")) if prev else None
        if after_ts is None:
            due.append(room_id)
            continue
        if await count_new_messages(db, room_id, after_ts) >= threshold:
            due.append(room_id)
    return due


async def _acquire_lease(redis: Any, room_id: uuid.UUID, cfg: SummaryConfig) -> bool:
    if redis is None:
        return True
    try:
        return bool(
            await redis.set(
                f"{LEASE_PREFIX}{room_id}", "1", nx=True, ex=int(cfg.timeout_seconds) + 60
            )
        )
    except Exception:
        logger.warning("context_summary_lease_failed", room_id=str(room_id), exc_info=True)
        return True


async def _release_lease(redis: Any, room_id: uuid.UUID) -> None:
    if redis is None:
        return
    try:
        await redis.delete(f"{LEASE_PREFIX}{room_id}")
    except Exception:
        logger.debug("context_summary_lease_release_failed", room_id=str(room_id), exc_info=True)


async def summarize_room(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Any,
    room_id: uuid.UUID,
    *,
    http: httpx.AsyncClient | None = None,
    redis: Any = None,
    force: bool = False,
) -> dict[str, Any] | None:
    """Fold the room's delta into its rolling summary.

    Returns the stored ``context_summary`` dict, the previous one with
    ``unchanged: True`` when there was nothing new (or, without ``force``,
    not enough new), or ``None`` when another worker holds the room's lease.
    Raises ``SummaryError`` when the feature is off/unconfigured or the
    gateway fails. Never blocks a message send: callers are the worker and
    the on-demand endpoint only.
    """
    cfg = summary_config(settings)
    err = config_error(cfg)
    if err:
        raise SummaryError(err)
    if not await _acquire_lease(redis, room_id, cfg):
        return None
    try:
        async with session_factory() as db:
            room = await _load_room(db, room_id)
            if room is None:
                raise SummaryError("Room not found")
            room_name = room.name or str(room_id)
            prev = previous_summary(room.metadata_) or None
            after_ts = _as_utc(prev.get("watermark_ts")) if prev else None
            rows = await load_delta(db, room_id, after_ts)

        rows = [m for m in rows if not is_abandoned(m)]
        if not rows or (not force and len(rows) < cfg.every_messages):
            return {**(prev or {}), "unchanged": True}

        lines = render_lines(rows)
        messages = build_summary_messages(
            room_name=room_name,
            previous=prev.get("text") if prev else None,
            lines=lines,
            max_chars=cfg.max_chars,
        )
        text = cap_text(await request_summary(cfg, messages, http=http), cfg.max_chars)
        last = rows[-1]
        last_ts = _as_utc(last.created_at) or _now()
        summary = {
            "text": text,
            "watermark": str(last.id),
            "watermark_ts": last_ts.isoformat(),
            "updated_at": _now().isoformat(),
            "message_count": len(rows),
            "model": cfg.model,
        }
        async with session_factory() as db:
            room = await _load_room(db, room_id)
            if room is None:
                raise SummaryError("Room not found")
            room.metadata_ = {**(room.metadata_ or {}), "context_summary": summary}
            await db.commit()
        logger.info(
            "context_summary_written",
            room_id=str(room_id),
            messages=len(rows),
            chars=len(text),
            model=cfg.model,
        )
        return summary
    finally:
        await _release_lease(redis, room_id)


async def run_context_summary_worker(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Any,
    redis: Any = None,
) -> None:
    """Poll for rooms that crossed the threshold and summarize them, one at
    a time. Exits immediately when the feature is off or unconfigured (so an
    unset instance costs nothing); safe in every uvicorn worker."""
    cfg = summary_config(settings)
    err = config_error(cfg)
    if err:
        logger.info("context_summary_worker_idle", reason=err)
        return
    logger.info(
        "context_summary_worker_started",
        model=cfg.model,
        every_messages=cfg.every_messages,
        poll_seconds=cfg.poll_seconds,
    )
    while True:
        try:
            async with session_factory() as db:
                due = await find_due_rooms(
                    db, threshold=cfg.every_messages, lookback_days=cfg.lookback_days
                )
            for room_id in due:
                try:
                    await summarize_room(session_factory, settings, room_id, redis=redis)
                except SummaryError as exc:
                    logger.warning("context_summary_failed", room_id=str(room_id), error=str(exc))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("context_summary_room_error", room_id=str(room_id))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("context_summary_worker_error")
        await asyncio.sleep(cfg.poll_seconds)


__all__ = [
    "DEFAULT_EVERY_MESSAGES",
    "DEFAULT_MODEL",
    "MAX_DELTA_MESSAGES",
    "SummaryConfig",
    "SummaryError",
    "build_summary_messages",
    "cap_text",
    "config_error",
    "count_new_messages",
    "find_due_rooms",
    "load_delta",
    "previous_summary",
    "render_lines",
    "request_summary",
    "run_context_summary_worker",
    "strip_thinking",
    "summarize_room",
    "summary_config",
]
