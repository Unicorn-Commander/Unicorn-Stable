#!/usr/bin/env python3
"""Repair placeholder thread and drifted agent-hub display names.

The default is a dry run.  Only child-thread slugs containing ``-t-`` whose
display name is empty or ``New thread`` are titled from their first message.
Top-level agent-hub rooms are aligned to the linked agent participant's
display name, which is the same source the read-only room-name audit calls
the agents config.  Channels, DMs, bridge rooms, and human-chosen titles are
not changed.

    python scripts/repair_room_names.py
    python scripts/repair_room_names.py --apply
    python scripts/repair_room_names.py --restore restore-20261106T123000Z.json

``--apply`` writes a restore JSON file in the current directory before
committing.  The restore file contains only the previous display names; it
never contains message content beyond the repaired title shown in the table.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from sqlalchemy import select

# Run from ``server/`` in the image or from this checkout.  Importing the
# audit helper keeps agent identity parsing byte-for-byte aligned with the
# read-only audit script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.audit_room_names import _agent_id_from_row  # noqa: E402


THREAD_PLACEHOLDER = "new thread"
TITLE_LIMIT = 60
ELLIPSIS = "…"

# These patterns cover the markdown emitted by the composer without adding a
# markdown dependency to the backend image.  Link labels survive while their
# destination and formatting markers do not.
_MARKDOWN_LINK_RE = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_MENTION_RE = re.compile(
    r"(?<![A-Za-z0-9_@])(?:<@!?[A-Za-z0-9_.-]+>|@\[[^\]]+\]|@[A-Za-z0-9_.-]{2,64})"
    r"(?:\s*[,;:]\s*)?"
)
_AUTOLINK_RE = re.compile(r"<https?://[^>]+>")
_LEADING_MARKER_RE = re.compile(r"(?m)^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)")


@dataclass(frozen=True)
class RoomChange:
    """One display-name change, suitable for printing and restoring."""

    kind: str
    room_id: str
    slug: str
    before: str | None
    after: str


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _display_value(room: Any) -> str | None:
    value = getattr(room, "display_name", None)
    return value if isinstance(value, str) else None


def _room_id(room: Any) -> str:
    return str(getattr(room, "id", ""))


def _room_slug(room: Any) -> str:
    return _text(getattr(room, "name", None))


def _is_placeholder_display(value: Any) -> bool:
    folded = _text(value).casefold()
    return not folded or folded == THREAD_PLACEHOLDER


def _is_thread_slug(slug: Any) -> bool:
    return "-t-" in _text(slug)


def _is_thread_room(room: Any) -> bool:
    """Require the slug marker and, for ORM rows, a parent room."""

    if not _is_thread_slug(getattr(room, "name", None)):
        return False
    # Production Room rows always have this mapped attribute.  A missing
    # attribute is accepted for small script fixtures that represent the
    # child relationship solely through the established slug convention.
    missing = object()
    parent_room_id = getattr(room, "parent_room_id", missing)
    return parent_room_id is missing or parent_room_id is not None


def _message_content(message: Any) -> str:
    if isinstance(message, str):
        return message
    return getattr(message, "content", "") if message is not None else ""


def _strip_markdown_and_mentions(content: str | None) -> str:
    """Turn one message into readable plain text for a room title."""

    text = content if isinstance(content, str) else ""
    text = _MARKDOWN_LINK_RE.sub(r"\1", text)
    text = _AUTOLINK_RE.sub(" ", text)
    text = _MENTION_RE.sub(" ", text)
    text = _LEADING_MARKER_RE.sub("", text)
    # Unescape a markdown punctuation escape before removing formatting.
    text = re.sub(r"\\([\\`*_[\]{}()#+.!~>-])", r"\1", text)
    text = re.sub(r"[*_~`]+", "", text)
    # A raw HTML tag is formatting, not title text.  The mention pattern above
    # runs first so ``<@fictional-seat>`` is removed as one token.
    text = re.sub(r"</?[A-Za-z][^>]*>", "", text)
    return " ".join(text.split())


def title_from_message(content: str | None, *, limit: int = TITLE_LIMIT) -> str:
    """Return a normalized, word-aware title no longer than ``limit``."""

    compact = _strip_markdown_and_mentions(content)
    if len(compact) <= limit:
        return compact

    prefix_limit = max(1, limit - len(ELLIPSIS))
    words = compact.split()
    words_that_fit: list[str] = []
    length = 0
    for word in words:
        candidate_length = len(word) if not words_that_fit else length + 1 + len(word)
        if candidate_length > prefix_limit:
            break
        words_that_fit.append(word)
        length = candidate_length

    if words_that_fit:
        return " ".join(words_that_fit) + ELLIPSIS

    # A single unbroken token has no word boundary before the limit.  Keep the
    # invariant (<= 60 chars) with the smallest possible character fallback.
    return compact[:prefix_limit].rstrip() + ELLIPSIS


def _first_message(first_messages: Mapping[Any, Any], room: Any) -> Any:
    room_uuid = getattr(room, "id", None)
    if room_uuid in first_messages:
        return first_messages[room_uuid]
    return first_messages.get(_room_id(room))


def plan_thread_changes(
    rooms: Iterable[Any], first_messages: Mapping[Any, Any]
) -> list[RoomChange]:
    """Plan eligible thread title changes from a first-message fixture."""

    changes: list[RoomChange] = []
    for room in rooms:
        slug = _room_slug(room)
        before = _display_value(room)
        if not _is_thread_room(room) or not _is_placeholder_display(before):
            continue
        message = _first_message(first_messages, room)
        if message is None:
            continue
        after = title_from_message(_message_content(message))
        # A message made only of markdown/mentions is not a useful title and
        # must not turn a placeholder into another empty placeholder.
        if not after or after == _text(before):
            continue
        changes.append(
            RoomChange(
                kind="thread",
                room_id=_room_id(room),
                slug=slug,
                before=before,
                after=after,
            )
        )
    return changes


def _hub_agent_id(room: Any) -> str:
    metadata = getattr(room, "metadata_", None)
    if not isinstance(metadata, Mapping):
        return ""
    agent_hub = metadata.get("agent_hub")
    if isinstance(agent_hub, Mapping):
        agent_id = _text(agent_hub.get("agent_id"))
        if agent_id:
            return agent_id.casefold()
    return _text(metadata.get("brigade_agent_id")).casefold()


def _config_name(config: Any, participant: Any) -> str:
    # AgentConfig currently stores the editable display name on its linked
    # Participant.  Keep the getattr fallback in lockstep with the audit so a
    # future config field remains the source of truth automatically.
    return _text(getattr(config, "display_name", None)) or _text(
        getattr(participant, "display_name", None)
    )


def _expected_agent_names(
    config_rows: Iterable[tuple[Any, Any]], participant_rows: Iterable[Any]
) -> dict[str, str]:
    expected: dict[str, str] = {}
    for config, participant in config_rows:
        agent_id = _agent_id_from_row(participant)
        name = _config_name(config, participant)
        if agent_id and name:
            expected[agent_id] = name
    # The audit also includes runner/Brigade seats without a legacy
    # AgentConfig row; their participant display name is the only config-like
    # source available and is therefore retained here.
    for participant in participant_rows:
        agent_id = _agent_id_from_row(participant)
        name = _text(getattr(participant, "display_name", None))
        if agent_id and name:
            expected.setdefault(agent_id, name)
    return expected


def plan_agent_changes(
    config_rows: Iterable[tuple[Any, Any]],
    participant_rows: Iterable[Any],
    hub_rooms: Iterable[Any],
) -> list[RoomChange]:
    """Plan top-level agent-hub changes, excluding child thread rooms."""

    expected = _expected_agent_names(config_rows, participant_rows)
    changes: list[RoomChange] = []
    for room in hub_rooms:
        slug = _room_slug(room)
        # Agent threads inherit room_type=agent_hub and brigade_agent_id.  The
        # thread rule owns those rows; a seat repair must never overwrite a
        # title just derived from the first message.
        if _is_thread_room(room):
            continue
        agent_id = _hub_agent_id(room)
        after = expected.get(agent_id)
        if not after:
            continue
        before = _display_value(room)
        if before == after:
            continue
        changes.append(
            RoomChange(
                kind="agent-hub",
                room_id=_room_id(room),
                slug=slug,
                before=before,
                after=after,
            )
        )
    return changes


def plan_repairs(
    rooms: Sequence[Any],
    first_messages: Mapping[Any, Any],
    config_rows: Iterable[tuple[Any, Any]],
    participant_rows: Iterable[Any],
    hub_rooms: Iterable[Any],
) -> list[RoomChange]:
    """Build one deterministic, de-duplicated repair plan."""

    changes = plan_thread_changes(rooms, first_messages)
    changed_ids = {change.room_id for change in changes}
    changes.extend(
        change
        for change in plan_agent_changes(config_rows, participant_rows, hub_rooms)
        if change.room_id not in changed_ids
    )
    kind_order = {"thread": 0, "agent-hub": 1}
    return sorted(
        changes,
        key=lambda change: (
            kind_order.get(change.kind, 99),
            change.slug,
            change.room_id,
        ),
    )


def _change_json(change: RoomChange) -> dict[str, str]:
    return {
        "kind": change.kind,
        "room_id": change.room_id,
        "slug": change.slug,
        "previous_display_name": change.before or "",
        "repaired_display_name": change.after,
    }


def restore_payload(changes: Iterable[RoomChange]) -> dict[str, Any]:
    """Serialize the minimum data needed by ``--restore``."""

    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "changes": [_change_json(change) for change in changes],
    }


def apply_changes(
    changes: Iterable[RoomChange], rooms_by_id: Mapping[str, Any]
) -> None:
    """Apply a validated plan to ORM-like room fixtures or real ORM rows."""

    for change in changes:
        room = rooms_by_id.get(change.room_id)
        if room is None:
            raise ValueError(f"room not found for change: {change.room_id}")
        room.display_name = change.after


def _restore_entries(path: Path) -> list[dict[str, str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read restore file {path}: {exc}") from exc
    if not isinstance(payload, Mapping) or payload.get("version") != 1:
        raise ValueError("restore file must have version=1")
    raw_changes = payload.get("changes")
    if not isinstance(raw_changes, list):
        raise ValueError("restore file changes must be a list")

    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_changes):
        if not isinstance(raw, Mapping):
            raise ValueError(f"restore change {index} is not an object")
        try:
            room_id = str(uuid.UUID(str(raw["room_id"])))
            previous = raw["previous_display_name"]
            slug = raw["slug"]
        except (KeyError, ValueError, TypeError) as exc:
            raise ValueError(f"restore change {index} has invalid room data") from exc
        if not isinstance(previous, str) or not isinstance(slug, str):
            raise ValueError(f"restore change {index} has invalid name data")
        if room_id in seen:
            raise ValueError(f"restore file repeats room {room_id}")
        seen.add(room_id)
        entries.append(
            {
                "room_id": room_id,
                "slug": slug,
                "previous_display_name": previous,
            }
        )
    return entries


def restore_changes(
    rooms: Iterable[Any], entries: Iterable[Mapping[str, str]]
) -> list[RoomChange]:
    """Build a restore plan and fail closed if any room is absent."""

    rooms_by_id = {_room_id(room): room for room in rooms}
    changes: list[RoomChange] = []
    for entry in entries:
        room_id = entry["room_id"]
        room = rooms_by_id.get(room_id)
        if room is None:
            raise ValueError(f"restore room not found: {room_id}")
        before = _display_value(room)
        after = entry["previous_display_name"]
        if before == after:
            continue
        changes.append(
            RoomChange(
                kind=f"restore:{entry['slug']}",
                room_id=room_id,
                slug=_room_slug(room),
                before=before,
                after=after,
            )
        )
    return sorted(changes, key=lambda change: (change.slug, change.room_id))


def _parse(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument(
        "--apply", action="store_true", help="write the planned display-name repairs"
    )
    action.add_argument(
        "--restore", type=Path, help="restore previous names from a --apply JSON file"
    )
    return parser.parse_args(argv)


def _print_value(value: str | None) -> str:
    compact = " ".join((value or "").split())
    return compact or "(empty)"


def print_changes(changes: Sequence[RoomChange], *, mode: str) -> None:
    print(f"mode={mode} changes={len(changes)}")
    if not changes:
        print("No display-name changes planned.")
        return
    print("kind  room_id                               slug  before -> after")
    print("----  -----------------------------------  ----  -----------------")
    for change in changes:
        print(
            f"{change.kind:<5} {change.room_id:<35}  {change.slug}  "
            f"{_print_value(change.before)} -> {_print_value(change.after)}"
        )


async def _collect_changes(db: Any) -> tuple[list[Any], list[RoomChange]]:
    from app.models.agent import AgentConfig
    from app.models.message import Message
    from app.models.participant import Participant, ParticipantType
    from app.models.room import Room, RoomType

    rooms = list((await db.execute(select(Room).order_by(Room.name))).scalars().all())
    thread_rooms = [room for room in rooms if _is_thread_room(room)]
    first_messages: dict[str, Any] = {}
    if thread_rooms:
        thread_ids = [room.id for room in thread_rooms]
        messages = list(
            (
                await db.execute(
                    select(Message)
                    .where(Message.room_id.in_(thread_ids))
                    .order_by(Message.room_id, Message.created_at, Message.id)
                )
            )
            .scalars()
            .all()
        )
        for message in messages:
            first_messages.setdefault(str(message.room_id), message)

    config_rows = list(
        (
            await db.execute(
                select(AgentConfig, Participant)
                .join(Participant, Participant.id == AgentConfig.participant_id)
                .order_by(Participant.username)
            )
        ).all()
    )
    participant_rows = list(
        (
            await db.execute(
                select(Participant)
                .where(Participant.participant_type == ParticipantType.AGENT)
                .order_by(Participant.username)
            )
        )
        .scalars()
        .all()
    )
    hub_rooms = list(
        (
            await db.execute(
                select(Room)
                .where(Room.room_type == RoomType.AGENT_HUB)
                .order_by(Room.name)
            )
        )
        .scalars()
        .all()
    )
    changes = plan_repairs(
        rooms,
        first_messages,
        config_rows,
        participant_rows,
        hub_rooms,
    )
    return rooms, changes


async def _restore_from_file(db: Any, path: Path) -> tuple[list[Any], list[RoomChange]]:
    from app.models.room import Room

    entries = _restore_entries(path)
    rooms = list((await db.execute(select(Room).order_by(Room.name))).scalars().all())
    return rooms, restore_changes(rooms, entries)


def _write_restore_file(changes: Sequence[RoomChange]) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = Path.cwd() / f"restore-{timestamp}.json"
    if path.exists():
        raise FileExistsError(f"restore file already exists: {path}")
    path.write_text(
        json.dumps(restore_payload(changes), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return path


async def _run(args: argparse.Namespace) -> int:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.config import get_settings

    settings = get_settings()
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions() as db:
            if args.restore is not None:
                rooms, changes = await _restore_from_file(db, args.restore)
                print_changes(changes, mode="restore")
                apply_changes(changes, {_room_id(room): room for room in rooms})
                await db.commit()
                print(f"restored={len(changes)}")
                return 0

            rooms, changes = await _collect_changes(db)
            mode = "apply" if args.apply else "dry-run"
            print_changes(changes, mode=mode)
            if not args.apply:
                return 0

            restore_path = _write_restore_file(changes)
            apply_changes(changes, {_room_id(room): room for room in rooms})
            await db.commit()
            print(f"restore_file={restore_path}")
            print(f"applied={len(changes)}")
            return 0
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    try:
        return asyncio.run(_run(_parse(argv)))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
