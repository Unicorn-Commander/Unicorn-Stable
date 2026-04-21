"""Brigade agents API — list available Brigade agents, invite into rooms."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings
from app.deps import get_current_user, get_livekit
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


@router.post(
    "/rooms/{room_name}/invite-brigade-agent",
    response_model=InviteAgentResponse,
)
async def invite_brigade_agent(
    room_name: str,
    body: InviteAgentRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
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

    return InviteAgentResponse(
        room_name=room_name,
        brigade_agent_id=body.brigade_agent_id,
        dispatched=bool(result.get("dispatched")),
        dispatch_id=result.get("dispatch_id"),
        reason=result.get("reason"),
    )
