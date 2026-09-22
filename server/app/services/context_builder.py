"""Context builder — the conversation an agent walks into (design §4).

One function hands an agent the room's recent stream, oldest-first, within a
token budget: messages from every sender, REPLIES inline (today's responder
excludes them), voice lines (``metadata.via == "voice"``) and system lines.
It is never filtered by when the agent joined or was last mentioned — that is
the whole point: an agent named mid-conversation answers with the
conversation in hand.

This is the L0 contract implementation: real entries from the message table,
a real budget walk, ``summary`` from ``room.metadata.context_summary`` when a
later job has written one (the rolling-summary job is lane L4). L4 also
swaps ``agent_chat_responder._build_history`` and the runner onto it.
"""

from __future__ import annotations

import uuid
from datetime import datetime
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


def entry_from_message(msg: Any) -> dict[str, Any]:
    sender = getattr(msg, "sender", None)
    if sender is not None:
        kind = getattr(sender, "participant_type", None)
        kind_value = kind.value if hasattr(kind, "value") else (kind or "human")
        name = getattr(sender, "display_name", None) or getattr(sender, "username", None) or "unknown"
        sender_id = getattr(sender, "id", None)
    else:
        kind_value, name, sender_id = "system", "system", None
    return {
        "id": msg.id,
        "ts": msg.created_at,
        "sender": {"id": sender_id, "name": name, "kind": kind_value},
        "kind": entry_kind(msg),
        "text": msg.content or "",
        "parent_id": getattr(msg, "parent_id", None),
    }


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

    newest_first = [
        entry_from_message(m)
        for m in rows
        if (m.content or "").strip() and (m.content or "").strip() != "…"
    ]
    entries, used, truncated = fit_to_budget(newest_first, budget, max_entries)

    summary: str | None = None
    room_meta = (
        await db.execute(select(Room.metadata_).where(Room.id == room_id))
    ).scalar_one_or_none()
    if isinstance(room_meta, dict):
        cs = room_meta.get("context_summary")
        if isinstance(cs, dict) and isinstance(cs.get("text"), str) and cs["text"].strip():
            summary = cs["text"]

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
    "build_context",
    "entry_from_message",
    "entry_kind",
    "estimate_tokens",
    "fit_to_budget",
]
