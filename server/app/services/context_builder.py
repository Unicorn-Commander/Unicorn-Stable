"""Context builder — the conversation an agent walks into (design §4).

One function hands an agent the room's recent stream, oldest-first, within a
token budget: messages from every sender, REPLIES inline (the pre-L4
responder excluded them), voice lines (``metadata.via == "voice"``) and system
lines. It is never filtered by when the agent joined or was last mentioned —
that is the whole point: an agent named mid-conversation answers with the
conversation in hand.

Every entry is ``{id, ts, sender{id, name, kind}, kind, text, parent_id}``
with ``kind`` one of ``message | reply | voice | system``. A reply's text is
prefixed ``↳ reply to <author>: `` so a consumer that only reads ``text``
still sees the thread shape.

The rolling room summary (``room.metadata.context_summary``, written by
``context_summary.py``) is PREPENDED only when it adds something the window
does not already show: its watermark precedes the window's first entry, or
the window was truncated (older lines dropped for budget). A window that
covers the room from its first line does not need it. The summary text is
capped and its tokens are charged against the same budget, so a long room
still fits.

Consumers: ``agent_chat_responder._build_history`` (Brigade agents), the
member endpoint ``GET /rooms/{id}/context`` (api/conversation.py), its
gateway mirror ``GET /gateway/rooms/{room}/context`` (api/gateway.py) and,
through that, the seat runner's cold turns.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.message import ContentType, Message
from app.models.room import Room, RoomMember

DEFAULT_BUDGET_TOKENS = 6000
MAX_BUDGET_TOKENS = 32000
#: Hard cap on rows scanned per build, independent of the token budget.
MAX_SCAN_ROWS = 400
#: The rolling summary is never handed over longer than this (chars); the
#: writer caps at the same bound, this is the belt to its braces.
MAX_SUMMARY_CHARS = 2400
#: Prefix a reply entry's text carries so the thread shape survives in
#: consumers that only read ``text``.
REPLY_PREFIX = "↳ reply to "


def estimate_tokens(text: str) -> int:
    """Cheap, deterministic token estimate (≈ chars / 4, minimum 1)."""
    return max(1, (len(text or "") + 3) // 4)


def entry_kind(msg: Any) -> str:
    """message | reply | voice | system for one Message row."""
    ct = getattr(msg, "content_type", None)
    ct_value = ct.value if hasattr(ct, "value") else ct
    if ct_value == ContentType.SYSTEM.value:
        return "system"
    meta = getattr(msg, "metadata_", None)
    if isinstance(meta, dict) and meta.get("via") == "voice":
        return "voice"
    if getattr(msg, "parent_id", None) is not None:
        return "reply"
    return "message"


def is_abandoned(msg: Any) -> bool:
    """A placeholder or a user-stopped partial reply: never context.

    ``…`` is the streaming placeholder before an agent has said anything;
    ``metadata.stopped`` marks a reply the human cut off — replaying its
    partial text (or the "⏹ Stopped" marker) as if it were a real turn is how
    an agent ends up continuing something nobody wanted.
    """
    text = (getattr(msg, "content", None) or "").strip()
    if not text or text == "…":
        return True
    meta = getattr(msg, "metadata_", None)
    return bool(isinstance(meta, dict) and meta.get("stopped"))


def _sender_name(participant: Any) -> str:
    return (
        getattr(participant, "display_name", None)
        or getattr(participant, "username", None)
        or "unknown"
    )


def reply_prefix(msg: Any) -> str:
    """``↳ reply to <author>: `` for a reply whose parent (and its sender) is
    loaded; empty otherwise. Never triggers a lazy load: an unloaded parent
    just loses the author name, it does not fail the build."""
    if getattr(msg, "parent_id", None) is None:
        return ""
    try:
        parent = getattr(msg, "parent", None)
    except Exception:  # a detached/expired relationship — degrade, don't fail
        parent = None
    if parent is None:
        return f"{REPLY_PREFIX}thread: "
    try:
        author = getattr(parent, "sender", None)
    except Exception:
        author = None
    return f"{REPLY_PREFIX}{_sender_name(author) if author is not None else 'thread'}: "


def entry_from_message(msg: Any) -> dict[str, Any]:
    sender = getattr(msg, "sender", None)
    if sender is not None:
        kind = getattr(sender, "participant_type", None)
        kind_value = kind.value if hasattr(kind, "value") else (kind or "human")
        name = _sender_name(sender)
        sender_id = getattr(sender, "id", None)
    else:
        kind_value, name, sender_id = "system", "system", None
    kind = entry_kind(msg)
    text = msg.content or ""
    if kind == "reply":
        text = reply_prefix(msg) + text
    return {
        "id": msg.id,
        "ts": msg.created_at,
        "sender": {"id": sender_id, "name": name, "kind": kind_value},
        "kind": kind,
        "text": text,
        "parent_id": getattr(msg, "parent_id", None),
    }


def format_entry_line(entry: dict[str, Any]) -> str:
    """One prompt line for an entry: ``Name: text``, voice lines marked
    ``Name (voice): text``, system lines ``[system] text``. The same shape
    the seat runner renders, so an agent reads a room the same way from
    either side."""
    sender = entry.get("sender") or {}
    name = sender.get("name") or "someone"
    kind = entry.get("kind")
    text = entry.get("text") or ""
    if kind == "system":
        return f"[system] {text}"
    if kind == "voice":
        return f"{name} (voice): {text}"
    return f"{name}: {text}"


def fit_to_budget(
    newest_first: list[dict[str, Any]], budget_tokens: int, max_entries: int | None = None
) -> tuple[list[dict[str, Any]], int, bool]:
    """Walk newest→oldest, keep entries while they fit; return them
    oldest-first with the tokens used and whether anything was dropped."""
    kept: list[dict[str, Any]] = []
    used = 0
    truncated = False
    for e in newest_first:
        if max_entries is not None and len(kept) >= max_entries:
            truncated = True
            break
        cost = estimate_tokens(e["text"]) + 4  # + a little for the sender/ts framing
        if kept and used + cost > budget_tokens:
            truncated = True
            break
        kept.append(e)
        used += cost
    kept.reverse()
    return kept, used, truncated


def summary_text_of(room_meta: Any) -> str | None:
    """The capped rolling-summary text from a room's metadata, or None."""
    if not isinstance(room_meta, dict):
        return None
    cs = room_meta.get("context_summary")
    if not isinstance(cs, dict):
        return None
    text = cs.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    text = text.strip()
    if len(text) > MAX_SUMMARY_CHARS:
        text = text[: MAX_SUMMARY_CHARS - 1].rstrip() + "…"
    return text


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


def summary_applies(
    context_summary: Any,
    entries: list[dict[str, Any]],
    *,
    truncated: bool,
    floored: bool = False,
) -> bool:
    """Does the rolling summary add anything to this window?

    * a floored window (a history floor such as a guest's) never gets it —
      the summary covers lines the floor exists to hide;
    * an empty window gets it (it is all there is);
    * otherwise: yes when the summary's watermark precedes the window's
      first entry, or the window dropped older lines for budget; no when the
      window already shows the room from before the watermark.
    """
    if floored or not isinstance(context_summary, dict):
        return False
    text = context_summary.get("text")
    if not isinstance(text, str) or not text.strip():
        return False
    if not entries:
        return True
    if truncated:
        return True
    first_ts = _as_utc(entries[0].get("ts"))
    wm_ts = _as_utc(context_summary.get("watermark_ts"))
    if wm_ts is not None and first_ts is not None:
        return wm_ts < first_ts
    wm_id = context_summary.get("watermark")
    if wm_id:
        return str(wm_id) not in {str(e.get("id")) for e in entries}
    return True


async def build_context(
    db: AsyncSession,
    *,
    room_id: uuid.UUID,
    budget_tokens: int = DEFAULT_BUDGET_TOKENS,
    since_message_id: uuid.UUID | None = None,
    not_before: datetime | None = None,
    for_participant_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    """Build the context payload for one room.

    ``since_message_id`` → only entries newer than that message (the delta a
    warm seat asks for). ``not_before`` → a hard history floor (guests).
    ``for_participant_id`` → honour that member's ``context_depth`` override
    (a maximum entry count) when set.
    """
    budget = max(1, min(int(budget_tokens or DEFAULT_BUDGET_TOKENS), MAX_BUDGET_TOKENS))

    stmt = (
        select(Message)
        .where(
            Message.room_id == room_id,
            Message.is_deleted == False,  # noqa: E712
        )
        .options(selectinload(Message.sender))
        .order_by(desc(Message.created_at))
        .limit(MAX_SCAN_ROWS)
    )
    if since_message_id is not None:
        since_ts = (
            await db.execute(select(Message.created_at).where(Message.id == since_message_id))
        ).scalar_one_or_none()
        if since_ts is not None:
            stmt = stmt.where(Message.created_at > since_ts)
    if not_before is not None:
        stmt = stmt.where(Message.created_at >= not_before)

    rows = list((await db.execute(stmt)).scalars().all())

    max_entries: int | None = None
    if for_participant_id is not None:
        depth = (
            await db.execute(
                select(RoomMember.context_depth).where(
                    RoomMember.room_id == room_id,
                    RoomMember.participant_id == for_participant_id,
                )
            )
        ).scalar_one_or_none()
        if depth:
            max_entries = int(depth)

    room_meta = (
        await db.execute(select(Room.metadata_).where(Room.id == room_id))
    ).scalar_one_or_none()
    context_summary = room_meta.get("context_summary") if isinstance(room_meta, dict) else None
    summary_text = summary_text_of(room_meta)
    # The summary is charged against the same budget so the total the agent
    # reads still fits; it is small (capped) next to the window.
    summary_tokens = estimate_tokens(summary_text) if summary_text else 0
    entries_budget = max(1, budget - summary_tokens)

    newest_first = [entry_from_message(m) for m in rows if not is_abandoned(m)]
    entries, used, truncated = fit_to_budget(newest_first, entries_budget, max_entries)

    summary: str | None = None
    if summary_text and summary_applies(
        context_summary, entries, truncated=truncated, floored=not_before is not None
    ):
        summary = summary_text
        used += summary_tokens

    return {
        "room_id": room_id,
        "budget_tokens": budget,
        "used_tokens": used,
        "truncated": truncated,
        "watermark": entries[-1]["id"] if entries else None,
        "summary": summary,
        "entries": entries,
    }


__all__ = [
    "DEFAULT_BUDGET_TOKENS",
    "MAX_BUDGET_TOKENS",
    "MAX_SCAN_ROWS",
    "MAX_SUMMARY_CHARS",
    "REPLY_PREFIX",
    "build_context",
    "entry_from_message",
    "entry_kind",
    "estimate_tokens",
    "fit_to_budget",
    "format_entry_line",
    "is_abandoned",
    "reply_prefix",
    "summary_applies",
    "summary_text_of",
]
