"""Brigade agents API — list available Brigade agents, invite into rooms."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_user, get_db, get_livekit
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter()


class BrigadeAgent(BaseModel):
    id: str
    name: str
    description: str = ""


class InviteAgentRequest(BaseModel):
    brigade_agent_id: str


class InviteAgentResponse(BaseModel):
    room_name: str
    brigade_agent_id: str
    dispatched: bool
    dispatch_id: str | None = None
    reason: str | None = None


async def _fetch_brigade_agents() -> list[BrigadeAgent]:
    """Proxy Brigade's /models endpoint to get the full agent roster."""
    settings = get_settings()
    if not settings.brigade_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Brigade not configured. Set BRIGADE_API_KEY in the Stable backend.",
        )

    url = settings.brigade_base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {settings.brigade_api_key}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
        try:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            body = resp.json()
        except httpx.HTTPError as e:
            logger.error("brigade_models_fetch_failed", url=url, error=str(e))
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Could not reach Brigade: {e}",
            )

    items = body.get("data", [])
    return [
        BrigadeAgent(
            id=item["id"],
            name=item.get("name") or item["id"],
            description=item.get("description") or "",
        )
        for item in items
    ]


@router.get("/brigade/agents", response_model=list[BrigadeAgent])
async def list_brigade_agents(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
) -> list[BrigadeAgent]:
    """List all Brigade agents (models) available to invite into rooms.

    Returns the upstream roster from Brigade (all agents configured in its
    database), not Stable's own agent_config table. This is deliberate —
    Brigade is the source of truth for agents.
    """
    return await _fetch_brigade_agents()


async def _ensure_agent_member(
    db: AsyncSession,
    room_id_or_lk: str,
    brigade_agent_id: str,
) -> str | None:
    """Ensure an agent-typed Participant exists and is a member of the room.

    Accepts either the Stable Postgres room UUID or the LiveKit room name.
    Returns the agent participant id (str) on success, None if room not found.
    """
    from sqlalchemy import select as _select

    from app.models.participant import (
        Participant as _P,
        ParticipantStatus as _PS,
        ParticipantType as _PT,
    )
    from app.models.room import MemberRole as _MR, Room as _Room, RoomMember as _RM

    # Resolve room
    room = (
        await db.execute(
            _select(_Room).where(_Room.livekit_room_name == room_id_or_lk)
        )
    ).scalar_one_or_none()
    if room is None:
        try:
            import uuid as _u

            uid = _u.UUID(room_id_or_lk)
            room = (
                await db.execute(_select(_Room).where(_Room.id == uid))
            ).scalar_one_or_none()
        except ValueError:
            room = None
    if room is None:
        return None

    # Find/create the agent Participant
    pseudo_sub = f"brigade:{brigade_agent_id}"
    pseudo_username = f"agent-{brigade_agent_id}"
    agent_p = (
        await db.execute(_select(_P).where(_P.keycloak_sub == pseudo_sub))
    ).scalar_one_or_none()
    if agent_p is None:
        display = brigade_agent_id.replace("-", " ").title()
        agent_p = _P(
            keycloak_sub=pseudo_sub,
            username=pseudo_username,
            display_name=display,
            participant_type=_PT.AGENT,
            status=_PS.ONLINE,
        )
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)

    # Add as room member if not already
    existing_member = (
        await db.execute(
            _select(_RM).where(
                _RM.room_id == room.id,
                _RM.participant_id == agent_p.id,
            )
        )
    ).scalar_one_or_none()
    if existing_member is None:
        db.add(
            _RM(
                room_id=room.id,
                participant_id=agent_p.id,
                role=_MR.MEMBER,
            )
        )
        await db.commit()

    return str(agent_p.id)


@router.post(
    "/rooms/{room_name}/invite-brigade-agent",
    response_model=InviteAgentResponse,
)
async def invite_brigade_agent(
    room_name: str,
    body: InviteAgentRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> InviteAgentResponse:
    """Spawn a Brigade-backed agent into an existing LiveKit room.

    The agent worker (WorkerOptions.agent_name = "stable-brigade") picks up
    the dispatch and runs `BrigadeBackedAgent`, which reads
    `brigade_agent_id` from the room metadata to decide which Brigade agent
    to act as.
    """
    settings = get_settings()

    # Sanity-check the requested agent exists in Brigade.
    agents = await _fetch_brigade_agents()
    valid_ids = {a.id for a in agents}
    if body.brigade_agent_id not in valid_ids:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown Brigade agent: {body.brigade_agent_id}",
        )

    result = await livekit.dispatch_agent(
        room_name=room_name,
        agent_name=settings.brigade_worker_agent_name,
        metadata={
            "agent_type": "brigade",
            "brigade_agent_id": body.brigade_agent_id,
            "invited_by": user.get("sub") or user.get("preferred_username") or "",
        },
    )

    # Make the agent visible in the participant strip immediately by creating
    # the agent Participant + room membership now (instead of waiting for the
    # agent to post its first message).
    try:
        await _ensure_agent_member(db, room_name, body.brigade_agent_id)
    except Exception:
        logger.warning("agent_member_create_failed", exc_info=True)

    # Persist brigade_agent_id on the Stable Room so the text-only reply path
    # (services/agent_chat_responder.py) can find it without joining members.
    # Single-agent assumption per room (DM/agent or channel + one resident agent);
    # multi-agent rooms keep the most-recently-invited as the canonical responder.
    try:
        from sqlalchemy import select as _select_meta
        from app.models.room import Room as _Room_meta
        room_row = (
            await db.execute(
                _select_meta(_Room_meta).where(
                    _Room_meta.livekit_room_name == room_name
                )
            )
        ).scalar_one_or_none()
        if room_row is None:
            try:
                import uuid as _uuid_meta
                room_row = (
                    await db.execute(
                        _select_meta(_Room_meta).where(
                            _Room_meta.id == _uuid_meta.UUID(room_name)
                        )
                    )
                ).scalar_one_or_none()
            except ValueError:
                room_row = None
        if room_row is not None:
            meta = dict(room_row.metadata_ or {})
            meta["brigade_agent_id"] = body.brigade_agent_id
            room_row.metadata_ = meta
            await db.commit()
    except Exception:
        logger.warning("room_metadata_brigade_id_set_failed", exc_info=True)

    return InviteAgentResponse(
        room_name=room_name,
        brigade_agent_id=body.brigade_agent_id,
        dispatched=bool(result.get("dispatched")),
        dispatch_id=result.get("dispatch_id"),
        reason=result.get("reason"),
    )


@router.delete(
    "/rooms/{room_name}/brigade-agents/{brigade_agent_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_brigade_agent(
    room_name: str,
    brigade_agent_id: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> None:
    """Kick a Brigade agent from a room.

    1. Remove the agent's RoomMember row so they disappear from the strip.
    2. Tell LiveKit to evict the agent participant (if connected).
    """
    from sqlalchemy import delete as _delete, select as _select

    from app.models.participant import Participant as _P, ParticipantType as _PT
    from app.models.room import Room as _Room, RoomMember as _RM

    _ = user
    room = (
        await db.execute(_select(_Room).where(_Room.livekit_room_name == room_name))
    ).scalar_one_or_none()
    if room is None:
        try:
            import uuid as _u

            uid = _u.UUID(room_name)
            room = (
                await db.execute(_select(_Room).where(_Room.id == uid))
            ).scalar_one_or_none()
        except ValueError:
            room = None
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    pseudo_sub = f"brigade:{brigade_agent_id}"
    agent_p = (
        await db.execute(
            _select(_P).where(
                _P.keycloak_sub == pseudo_sub,
                _P.participant_type == _PT.AGENT,
            )
        )
    ).scalar_one_or_none()
    if agent_p is not None:
        await db.execute(
            _delete(_RM).where(
                _RM.room_id == room.id,
                _RM.participant_id == agent_p.id,
            )
        )
        await db.commit()

    # Best-effort eviction from LiveKit. Identity is whatever the worker
    # registered with — we don't track it precisely, so we try a few patterns.
    try:
        for identity in (
            f"agent-{brigade_agent_id}",
            f"agent-brigade-{brigade_agent_id}",
        ):
            try:
                await livekit.remove_participant(
                    room_name=room.livekit_room_name,
                    identity=identity,
                )
            except Exception:
                pass
    except Exception:
        logger.debug("livekit_evict_failed", exc_info=True)
    return None
