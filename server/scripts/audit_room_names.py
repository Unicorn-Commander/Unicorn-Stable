#!/usr/bin/env python3
"""Audit room and agent names without changing the database.

The room audit reads ``rooms.name``, ``rooms.display_name``,
``rooms.metadata`` and message existence.  The agent-seat audit reads the
``agent_configs`` row joined to its agent ``participants`` row, agent-hub room
metadata/display names, and (when the repository is mounted) the optional
``web/public/agent-puppets/manifest.json``.  The manifest is keyed by
``stable_username`` and is never required for the database audit.

Run from the backend container or from ``server/`` in a checkout:

    python -m scripts.audit_room_names

This command only issues SELECTs. It prints a compact table and exits 1 when
one or more disagreements are found.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from sqlalchemy import select

# ``python -m scripts.audit_room_names`` is run with ``server/`` as cwd in the
# image. This also makes the same module runnable from a source checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


BRIDGE_KEYS = ("bridge_pair", "bridge_purpose")
THREAD_PLACEHOLDER = "new thread"
PUPPET_MANIFEST_RELATIVE = Path("web/public/agent-puppets/manifest.json")


@dataclass(frozen=True)
class RoomSnapshot:
    room_id: str
    slug: str
    display_name: str | None
    metadata: Mapping[str, Any] | None
    has_messages: bool


@dataclass(frozen=True)
class AgentSeatSnapshot:
    agent_id: str
    config_name: str | None
    hub_names: tuple[str, ...]
    puppet_name: str | None
    seat_id: str | None = None


@dataclass(frozen=True)
class AuditFinding:
    category: str
    identifier: str
    label: str
    observed: str
    issues: tuple[str, ...]
    sources: str


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _fold(value: Any) -> str:
    return " ".join(_text(value).split()).casefold()


def _bridge_metadata_present(metadata: Mapping[str, Any] | None) -> bool:
    return isinstance(metadata, Mapping) and any(key in metadata for key in BRIDGE_KEYS)


def _human_readable_display(display_name: Any, slug: Any) -> bool:
    display = _fold(display_name)
    return bool(display) and display != _fold(slug) and display != THREAD_PLACEHOLDER


def room_findings(room: RoomSnapshot) -> list[AuditFinding]:
    """Return every naming issue for one room fixture/snapshot."""

    display = _text(room.display_name)
    folded_display = _fold(display)
    folded_slug = _fold(room.slug)
    issues: list[str] = []

    if not display:
        issues.append("empty_display_name")
    if display and folded_display == folded_slug:
        issues.append("display_name_equals_slug")
    if room.has_messages and folded_display == THREAD_PLACEHOLDER:
        issues.append("new_thread_with_messages")
    if _bridge_metadata_present(room.metadata) and not _human_readable_display(
        display, room.slug
    ):
        issues.append("bridge_metadata_without_human_title")

    if not issues:
        return []
    return [
        AuditFinding(
            category="room",
            identifier=room.room_id,
            label=room.slug,
            observed=display or "(empty)",
            issues=tuple(issues),
            sources="rooms + messages",
        )
    ]


def agent_findings(seat: AgentSeatSnapshot) -> list[AuditFinding]:
    """Compare all readable names for one fictional/fixture agent seat."""

    named_sources: list[tuple[str, str]] = []
    config_name = _text(seat.config_name)
    if config_name:
        named_sources.append(("agents config", config_name))
    for index, hub_name in enumerate(seat.hub_names, start=1):
        if _text(hub_name):
            named_sources.append((f"hub {index}", _text(hub_name)))
    puppet_name = _text(seat.puppet_name)
    if puppet_name:
        named_sources.append(("puppet manifest", puppet_name))

    if len(named_sources) < 2:
        return []
    values = {_fold(value) for _source, value in named_sources}
    if len(values) == 1:
        return []

    observed = "; ".join(f"{source}={value}" for source, value in named_sources)
    return [
        AuditFinding(
            category="agent-seat",
            identifier=seat.seat_id or seat.agent_id,
            label=seat.agent_id,
            observed=observed,
            issues=("agent_name_drift",),
            sources="agents config + agent hubs + optional puppet manifest",
        )
    ]


def load_puppet_names(manifest_path: Path) -> dict[str, str]:
    """Read stable username/id → display name from a puppet manifest.

    A backend-only image normally has no ``web/`` tree, so a missing or
    unreadable manifest is an intentional empty result rather than a failed
    room audit. Values are restricted to strings and the output is only used
    for comparison, never printed as raw JSON.
    """

    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(payload, dict):
        return {}

    names: dict[str, str] = {}
    for key, item in payload.items():
        if not isinstance(item, dict):
            continue
        display_name = _text(item.get("display_name"))
        if not display_name:
            continue
        names[str(key).casefold()] = display_name
        stable_username = _text(item.get("stable_username"))
        if stable_username:
            names[stable_username.casefold()] = display_name
    return names


def _agent_id_from_row(row: Any) -> str:
    metadata = getattr(row, "metadata_", None)
    if isinstance(metadata, dict):
        explicit = _text(metadata.get("agent_id"))
        if explicit:
            return explicit.casefold()
    for raw in (
        getattr(row, "keycloak_sub", None),
        getattr(row, "username", None),
    ):
        value = _text(raw)
        for prefix in ("brigade:", "agent:", "agent-"):
            if value.casefold().startswith(prefix):
                return value[len(prefix) :].casefold()
    return _text(getattr(row, "username", None)).casefold()


def _puppet_name(
    agent_id: str,
    participant: Any,
    puppet_names: Mapping[str, str],
) -> str | None:
    candidates = [
        _text(getattr(participant, "username", None)),
        f"agent-{agent_id}",
        agent_id,
    ]
    for candidate in candidates:
        name = puppet_names.get(candidate.casefold())
        if name:
            return name
    return None


def _agent_snapshots(
    config_rows: Iterable[tuple[Any, Any]],
    participant_rows: Iterable[Any],
    hub_rows: Iterable[Any],
    puppet_names: Mapping[str, str],
) -> list[AgentSeatSnapshot]:
    """Build comparison snapshots from ORM rows without issuing writes."""

    config_by_participant: dict[str, Any] = {}
    for config, participant in config_rows:
        config_by_participant[str(getattr(participant, "id", ""))] = config

    hub_names_by_agent: dict[str, list[str]] = {}
    for hub in hub_rows:
        metadata = getattr(hub, "metadata_", None)
        agent_hub = metadata.get("agent_hub") if isinstance(metadata, dict) else None
        agent_id = _text(agent_hub.get("agent_id")) if isinstance(agent_hub, dict) else ""
        if not agent_id and isinstance(metadata, dict):
            agent_id = _text(metadata.get("brigade_agent_id"))
        if agent_id:
            hub_names_by_agent.setdefault(agent_id.casefold(), []).append(
                _text(getattr(hub, "display_name", None))
            )

    snapshots: list[AgentSeatSnapshot] = []
    seen: set[tuple[str, str]] = set()
    for participant in participant_rows:
        participant_id = str(getattr(participant, "id", ""))
        config = config_by_participant.get(participant_id)
        agent_id = _agent_id_from_row(participant)
        if not agent_id:
            continue
        key = (participant_id, agent_id)
        if key in seen:
            continue
        seen.add(key)
        # AgentConfig stores the seat's editable name on its linked
        # Participant, rather than duplicating a display_name column. Keep
        # every AGENT participant here as well: runner/Brigade seats may have
        # no legacy AgentConfig row but still have a hub and puppet identity
        # that must not drift.
        config_name = getattr(config, "display_name", None) or getattr(
            participant, "display_name", None
        )
        snapshots.append(
            AgentSeatSnapshot(
                agent_id=agent_id,
                config_name=config_name,
                hub_names=tuple(hub_names_by_agent.get(agent_id, [])),
                puppet_name=_puppet_name(agent_id, participant, puppet_names),
                seat_id=participant_id,
            )
        )
    return snapshots


def _parse(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help="checkout root containing web/public/agent-puppets/manifest.json",
    )
    return parser.parse_args(argv)


async def _collect(args: argparse.Namespace) -> tuple[list[AuditFinding], bool]:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.config import get_settings
    from app.models.agent import AgentConfig
    from app.models.message import Message
    from app.models.participant import Participant, ParticipantType
    from app.models.room import Room, RoomType

    repo_root = args.repo_root or Path(__file__).resolve().parents[2]
    manifest_path = repo_root / PUPPET_MANIFEST_RELATIVE
    puppet_names = load_puppet_names(manifest_path)

    settings = get_settings()
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as db:
            room_rows = list(
                (
                    await db.execute(
                        select(Room.id, Room.name, Room.display_name, Room.metadata_).order_by(
                            Room.name
                        )
                    )
                ).all()
            )
            message_room_ids = {
                str(room_id)
                for room_id in (
                    await db.execute(select(Message.room_id).distinct())
                ).scalars().all()
            }
            findings: list[AuditFinding] = []
            for room_id, name, display_name, metadata in room_rows:
                findings.extend(
                    room_findings(
                        RoomSnapshot(
                            room_id=str(room_id),
                            slug=_text(name),
                            display_name=display_name,
                            metadata=metadata if isinstance(metadata, Mapping) else None,
                            has_messages=str(room_id) in message_room_ids,
                        )
                    )
                )

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
                ).scalars().all()
            )
            hub_rows = list(
                (
                    await db.execute(
                        select(Room)
                        .where(Room.room_type == RoomType.AGENT_HUB)
                        .order_by(Room.name)
                    )
                ).scalars().all()
            )
            for seat in _agent_snapshots(
                config_rows, participant_rows, hub_rows, puppet_names
            ):
                findings.extend(agent_findings(seat))
            return findings, bool(puppet_names)
    finally:
        await engine.dispose()


def _short(value: str, limit: int = 96) -> str:
    compact = " ".join(value.split())
    return compact if len(compact) <= limit else compact[: limit - 1].rstrip() + "…"


def _print_table(findings: Iterable[AuditFinding], puppet_readable: bool) -> None:
    rows = [
        [
            finding.category,
            finding.identifier,
            finding.label,
            finding.observed,
            ",".join(finding.issues),
        ]
        for finding in findings
    ]
    headers = ["kind", "id", "slug/agent", "observed", "issues"]
    if not rows:
        print("No room or agent name drift found.")
    else:
        rows = [[_short(cell, 64) for cell in row] for row in rows]
        widths = [
            max(len(headers[index]), *(len(row[index]) for row in rows))
            for index in range(len(headers))
        ]
        print("  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
        print("  ".join("-" * width for width in widths))
        for row in rows:
            print("  ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)))
    manifest_state = "readable" if puppet_readable else "not readable (optional)"
    print(
        "sources: rooms/messages, agent_configs + participants, agent_hub metadata/display_name, "
        f"{PUPPET_MANIFEST_RELATIVE} ({manifest_state})"
    )
    print(f"findings={len(rows)}")


async def _run(args: argparse.Namespace) -> int:
    findings, puppet_readable = await _collect(args)
    _print_table(findings, puppet_readable)
    return 1 if findings else 0


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
