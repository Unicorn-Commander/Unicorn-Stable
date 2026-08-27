"""Resident-agent SET semantics for a room's metadata.

A room used to hold exactly ONE resident Brigade agent, in
``metadata.brigade_agent_id``. Multiple voice agents in one call need that to
express a SET, so the canonical multi form is ``metadata.brigade_agent_ids`` —
an ordered, de-duplicated list in invite order.

**The scalar is still written and still means something.** It is the
"canonical responder" (last-invited wins) that every single-agent consumer
already depends on: the server text responder, the human-DM guard, the
sidebar/room-list persona, ``_is_pure_human_dm_room``. Nothing that reads the
scalar had to change — it keeps seeing exactly what it saw before. Readers who
want the whole roster call :func:`resident_agent_ids`, which falls back to the
scalar so a room written by an older build (or by hand, in SQL) still resolves
to a one-element set.

Kept deliberately dependency-free so it can be unit-tested without a DB.
"""

from __future__ import annotations

from typing import Any, Mapping

#: Hard ceiling on simultaneous resident agents in one room. Each one is a
#: LiveKit participant with its own STT+LLM+TTS pipeline; an unbounded list is
#: an unbounded way to melt the GPU box from a chat UI.
MAX_RESIDENT_AGENTS = 8


def resident_agent_ids(metadata: Mapping[str, Any] | None) -> list[str]:
    """Every Brigade agent resident in this room, in invite order.

    Backward compatible in both directions: the list form wins when present,
    the scalar is the one-element fallback, and the scalar is appended when it
    names an agent the list somehow missed (a half-written metadata blob must
    not lose the room's only agent).
    """
    meta = metadata or {}
    ids: list[str] = []
    raw = meta.get("brigade_agent_ids")
    if isinstance(raw, (list, tuple)):
        for item in raw:
            if isinstance(item, str) and item.strip() and item not in ids:
                ids.append(item.strip())
    scalar = meta.get("brigade_agent_id")
    if isinstance(scalar, str) and scalar.strip() and scalar.strip() not in ids:
        ids.append(scalar.strip())
    return ids[:MAX_RESIDENT_AGENTS]


def add_resident_agent(
    metadata: Mapping[str, Any] | None, agent_id: str
) -> dict[str, Any]:
    """Return a NEW metadata dict with ``agent_id`` resident.

    Writes both forms: the set gains the agent (moved to the end — invite
    order is recency order), and the scalar becomes this agent, preserving the
    documented "most-recently-invited is the canonical responder" rule.

    Returns a new dict rather than mutating: SQLAlchemy JSONB change detection
    needs a reassignment, and every caller here reassigns ``room.metadata_``.
    """
    meta = dict(metadata or {})
    agent = (agent_id or "").strip()
    if not agent:
        return meta
    ids = [i for i in resident_agent_ids(meta) if i != agent]
    ids.append(agent)
    meta["brigade_agent_ids"] = ids[-MAX_RESIDENT_AGENTS:]
    meta["brigade_agent_id"] = agent
    return meta


def remove_resident_agent(
    metadata: Mapping[str, Any] | None, agent_id: str
) -> dict[str, Any]:
    """Return a NEW metadata dict with ``agent_id`` evicted from both forms.

    The scalar is re-pointed at whoever is left (most recent first) so a kick
    never leaves the text responder answering as the agent that was kicked —
    the same invariant the single-agent kick path already enforced by popping
    the scalar.
    """
    meta = dict(metadata or {})
    agent = (agent_id or "").strip()
    ids = [i for i in resident_agent_ids(meta) if i != agent]
    if ids:
        meta["brigade_agent_ids"] = ids
        meta["brigade_agent_id"] = ids[-1]
    else:
        meta.pop("brigade_agent_ids", None)
        meta.pop("brigade_agent_id", None)
    return meta
