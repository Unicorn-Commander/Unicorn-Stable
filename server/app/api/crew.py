"""``GET /api/v1/crew`` — the agents the caller can talk to (Nav v3, C3).

The sidebar's Crew section and the phone's Crew tab read this; New → Talk to
an agent offers its runner seats. Membership, presence and ranking live in
``services/crew.py`` and are shared with ``/home/summary``.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_user, get_db, get_redis
from app.services.crew import CrewEntry, apply_role_lines, build_crew, load_brigade_role_lines

logger = structlog.get_logger(__name__)

router = APIRouter()


class CrewRow(BaseModel):
    """One agent on the caller's crew (design C3)."""

    agent_id: str
    participant_id: str
    display_name: str
    avatar_url: str | None = None
    #: Brigade title/description, or the seat's own description. Null when
    #: neither exists.
    role_line: str | None = None
    #: ``runner`` (a gateway seat) | ``brigade``.
    backend: str
    #: ``seat`` (a runner on someone's computer) | ``brigade`` (design §2.0).
    kind: Literal["seat", "brigade"]
    #: The username that owns a seat (``metadata.owner``); null for Brigade.
    owner: str | None = None
    #: ``own_seat`` (owner == you) | ``house`` (Brigade) | ``partner``
    #: (someone else's seat that shares a room with you).
    group: Literal["own_seat", "house", "partner"]
    #: Seats: ``online`` while the runner is calling the gateway (R8). House
    #: agents: Brigade's roster says registered + enabled, or a worker
    #: heartbeat landed in the last 6 minutes.
    presence: Literal["online", "offline"]
    #: The caller's OWN hub with this agent (R7), when one exists.
    hub_room_id: str | None = None
    #: What the runner announced through ``PUT /gateway/me`` (harness,
    #: default_model, default_effort, models[], efforts[], updated_at); null
    #: for Brigade agents and for seats that have not announced yet.
    seat_capabilities: dict[str, Any] | None = None
    last_line: str | None = None
    last_at: datetime | None = None
    #: Unread in the caller's hub with this agent; 0 when unknown / no hub.
    unread: int = 0


def crew_row(entry: CrewEntry) -> CrewRow:
    return CrewRow(
        agent_id=entry.agent_id,
        participant_id=entry.participant_id,
        display_name=entry.display_name,
        avatar_url=entry.avatar_url,
        role_line=entry.role_line,
        backend=entry.backend,
        kind="seat" if entry.kind == "seat" else "brigade",
        owner=entry.owner,
        group=entry.group,  # type: ignore[arg-type]
        presence="online" if entry.presence == "online" else "offline",
        hub_room_id=entry.hub_room_id,
        seat_capabilities=entry.seat_capabilities,
        last_line=entry.last_line,
        last_at=entry.last_at,
        unread=entry.unread,
    )


@router.get("/crew", response_model=list[CrewRow])
async def list_crew(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> list[CrewRow]:
    """The caller's crew, ranked: own seats, then house agents heard from in
    the last 14 days (most recent first), then partner seats, then the rest
    by name (design §2.1 / §2.0). Guest agents and integrations never
    appear. Brigade role lines load alongside the roster (Redis-cached,
    1 s cap, in-process fallback) and never delay or fail it."""
    now = datetime.now(timezone.utc)
    roles, entries = await asyncio.gather(
        load_brigade_role_lines(redis),
        build_crew(
            db,
            user["participant_id"],
            now,
            caller_username=user.get("username"),
            redis=redis,
        ),
    )
    apply_role_lines(entries, roles)
    return [crew_row(entry) for entry in entries]
