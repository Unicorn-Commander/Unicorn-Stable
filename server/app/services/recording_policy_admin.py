"""Bulk recording-policy changes — the operator's tool (design §8).

Before this lane, ``CALL_RECORDING_ENABLED=true`` meant EVERY call on the
instance was recorded (audio). Now the ROOM's ``recording_policy`` decides
and the migration (023) defaults every room to ``off`` — which would
silently stop dogfood recording on deploy. This module is how an operator
keeps (or changes) that behaviour on purpose, in bulk, with a receipt:

* ``POST /admin/recording/policy`` (api/recording.py) — instance admins.
* ``python scripts/set_recording_policy.py`` — same function, from inside
  the backend container, right after the migration.

Every changed room gets an append-only ``agent_events`` audit row
(``event_type=recording_policy_changed``) naming who/what changed it, from
what, to what.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent import AgentEvent
from app.models.room import RECORDING_KINDS, RECORDING_POLICIES, Room

logger = structlog.get_logger(__name__)

AUDIT_EVENT_TYPE = "recording_policy_changed"
AUDIT_AGENT_TYPE = "admin"


class PolicyChangeError(ValueError):
    """Bad input to a bulk change (reported as 400 by the API, exit 2 by the CLI)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def validate(policy: str, kind: str | None) -> tuple[str, str | None]:
    policy = str(policy or "").strip().lower()
    if policy not in RECORDING_POLICIES:
        raise PolicyChangeError(
            f"policy must be one of {', '.join(RECORDING_POLICIES)}; got {policy!r}"
        )
    if kind is not None:
        kind = str(kind).strip().lower()
        if kind not in RECORDING_KINDS:
            raise PolicyChangeError(
                f"kind must be one of {', '.join(RECORDING_KINDS)}; got {kind!r}"
            )
    return policy, kind


async def select_rooms(
    db: AsyncSession,
    *,
    room_ids: Iterable[Any] | None = None,
    all_active: bool = False,
) -> list[Room]:
    """The rooms a change applies to: explicit ids, or every non-archived room."""
    if all_active:
        stmt = select(Room).where(Room.is_archived.is_(False)).order_by(Room.created_at.asc())
        return list((await db.execute(stmt)).scalars().all())
    ids: list[uuid.UUID] = []
    for raw in room_ids or []:
        try:
            ids.append(uuid.UUID(str(raw)))
        except (ValueError, TypeError):
            raise PolicyChangeError(f"not a room id: {raw!r}")
    if not ids:
        raise PolicyChangeError("no rooms selected: pass room ids or all_active")
    stmt = select(Room).where(Room.id.in_(ids))
    rooms = list((await db.execute(stmt)).scalars().all())
    found = {r.id for r in rooms}
    missing = [str(i) for i in ids if i not in found]
    if missing:
        raise PolicyChangeError(f"unknown room ids: {', '.join(missing)}")
    return rooms


def audit_row(
    room: Room,
    *,
    previous_policy: str,
    previous_kind: str,
    policy: str,
    kind: str,
    actor: str,
    via: str,
) -> AgentEvent:
    return AgentEvent(
        org_id=getattr(room, "org_id", None),
        agent_identity=actor,
        agent_type=AUDIT_AGENT_TYPE,
        event_type=AUDIT_EVENT_TYPE,
        room_ref=str(room.id),
        correlation_id=None,
        event_data={
            "room_id": str(room.id),
            "room_name": getattr(room, "name", None),
            "previous": {"policy": previous_policy, "kind": previous_kind},
            "policy": policy,
            "kind": kind,
            "via": via,
        },
        occurred_at=_now(),
    )


async def apply_recording_policy(
    db: AsyncSession,
    *,
    policy: str,
    kind: str | None = None,
    room_ids: Iterable[Any] | None = None,
    all_active: bool = False,
    actor: str,
    via: str = "api",
    dry_run: bool = False,
) -> dict[str, Any]:
    """Set ``recording_policy`` (and optionally ``recording_kind``) on rooms.

    Returns a summary: every matched room with its previous and new values
    and whether it changed. ``dry_run`` computes the same summary and writes
    nothing. Every changed room gets an audit row in the same transaction.
    """
    policy, kind = validate(policy, kind)
    rooms = await select_rooms(db, room_ids=room_ids, all_active=all_active)
    changed: list[dict[str, Any]] = []
    unchanged: list[dict[str, Any]] = []
    for room in rooms:
        prev_policy = getattr(room, "recording_policy", None) or "off"
        prev_kind = getattr(room, "recording_kind", None) or "audio"
        new_kind = kind or prev_kind
        entry = {
            "room_id": str(room.id),
            "name": getattr(room, "name", None),
            "previous": {"policy": prev_policy, "kind": prev_kind},
            "policy": policy,
            "kind": new_kind,
        }
        if prev_policy == policy and prev_kind == new_kind:
            unchanged.append(entry)
            continue
        changed.append(entry)
        if dry_run:
            continue
        room.recording_policy = policy
        room.recording_kind = new_kind
        db.add(
            audit_row(
                room,
                previous_policy=prev_policy,
                previous_kind=prev_kind,
                policy=policy,
                kind=new_kind,
                actor=actor,
                via=via,
            )
        )
    if changed and not dry_run:
        await db.commit()
    logger.info(
        "recording_policy_bulk_change",
        policy=policy,
        kind=kind,
        matched=len(rooms),
        changed=len(changed),
        dry_run=dry_run,
        actor=actor,
        via=via,
    )
    return {
        "policy": policy,
        "kind": kind,
        "dry_run": dry_run,
        "matched": len(rooms),
        "changed": len(changed),
        "unchanged": len(unchanged),
        "rooms": changed + unchanged,
    }


__all__ = [
    "AUDIT_EVENT_TYPE",
    "PolicyChangeError",
    "validate",
    "select_rooms",
    "audit_row",
    "apply_recording_policy",
]
