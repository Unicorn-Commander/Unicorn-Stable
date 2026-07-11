from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_user, get_db
from app.models.agent import AgentConfig, AgentRun, AgentRunStatus, AgentType
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.schemas.agent import (
    AgentActionRequest,
    AgentConfigCreate,
    AgentConfigResponse,
    AgentConfigUpdate,
    AgentRunResponse,
)

logger = structlog.get_logger(__name__)

router = APIRouter()


def _agent_to_response(
    config: AgentConfig, include_prompt: bool = True
) -> AgentConfigResponse:
    return AgentConfigResponse(
        id=config.id,
        participant_id=config.participant_id,
        username=config.participant.username if config.participant else None,
        display_name=config.participant.display_name if config.participant else None,
        agent_type=config.agent_type.value,
        model_provider=config.model_provider,
        model_name=config.model_name,
        system_prompt=config.system_prompt if include_prompt else "",
        voice_id=config.voice_id,
        voice_provider=config.voice_provider,
        capabilities=config.capabilities,
        auto_join_rooms=config.auto_join_rooms,
        is_persistent=config.is_persistent,
        max_concurrent_rooms=config.max_concurrent_rooms,
        rate_limit_rpm=config.rate_limit_rpm,
        created_at=config.created_at,
        updated_at=config.updated_at,
    )


def _require_admin(user: dict[str, Any]) -> None:
    """Check that the user has an admin role."""
    roles = user.get("roles", [])
    if "admin" not in roles and "realm-admin" not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )


@router.get("/agents", response_model=list[AgentConfigResponse])
async def list_agents(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[AgentConfigResponse]:
    """List all agent configurations."""
    result = await db.execute(
        select(AgentConfig).order_by(AgentConfig.created_at.desc())
    )
    configs = result.scalars().all()
    # The LIST surface omits system_prompt (an agent's internal instructions);
    # the admin create/update/get responses still include it.
    return [_agent_to_response(c, include_prompt=False) for c in configs]


@router.post("/agents", response_model=AgentConfigResponse, status_code=status.HTTP_201_CREATED)
async def create_agent(
    body: AgentConfigCreate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AgentConfigResponse:
    """Create a new agent configuration. Admin only."""
    _require_admin(user)

    # Check username uniqueness
    existing = await db.execute(
        select(Participant).where(Participant.username == body.username)
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Username '{body.username}' is already taken",
        )

    # Create the participant record for the agent
    participant = Participant(
        keycloak_sub=f"agent-{body.username}",
        username=body.username,
        display_name=body.display_name,
        participant_type=ParticipantType.AGENT,
        status=ParticipantStatus.OFFLINE,
    )
    db.add(participant)
    await db.flush()

    # Create the agent config
    config = AgentConfig(
        participant_id=participant.id,
        agent_type=AgentType(body.agent_type),
        model_provider=body.model_provider,
        model_name=body.model_name,
        system_prompt=body.system_prompt,
        voice_id=body.voice_id,
        voice_provider=body.voice_provider,
        capabilities=body.capabilities,
        auto_join_rooms=[str(r) for r in body.auto_join_rooms],
        is_persistent=body.is_persistent,
        max_concurrent_rooms=body.max_concurrent_rooms,
        rate_limit_rpm=body.rate_limit_rpm,
    )
    db.add(config)
    await db.commit()
    await db.refresh(config)
    await db.refresh(participant)

    logger.info(
        "agent_created",
        agent_id=str(config.id),
        username=body.username,
        agent_type=body.agent_type,
    )
    return _agent_to_response(config)


@router.patch("/agents/{agent_id}", response_model=AgentConfigResponse)
async def update_agent(
    agent_id: uuid.UUID,
    body: AgentConfigUpdate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AgentConfigResponse:
    """Update an agent configuration. Admin only."""
    _require_admin(user)

    result = await db.execute(
        select(AgentConfig).where(AgentConfig.id == agent_id)
    )
    config = result.scalar_one_or_none()
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent config not found",
        )

    update_data = body.model_dump(exclude_unset=True)

    # Handle participant-level fields
    if "display_name" in update_data and update_data["display_name"] is not None:
        participant_result = await db.execute(
            select(Participant).where(Participant.id == config.participant_id)
        )
        participant = participant_result.scalar_one()
        participant.display_name = update_data.pop("display_name")

    # Handle agent_type enum conversion
    if "agent_type" in update_data and update_data["agent_type"] is not None:
        update_data["agent_type"] = AgentType(update_data["agent_type"])

    # Handle auto_join_rooms UUID conversion
    if "auto_join_rooms" in update_data and update_data["auto_join_rooms"] is not None:
        update_data["auto_join_rooms"] = [str(r) for r in update_data["auto_join_rooms"]]

    for field, value in update_data.items():
        if value is not None and hasattr(config, field):
            setattr(config, field, value)

    await db.commit()
    await db.refresh(config)

    logger.info("agent_updated", agent_id=str(agent_id))
    return _agent_to_response(config)


@router.post("/agents/{agent_id}/actions", response_model=AgentRunResponse, status_code=status.HTTP_201_CREATED)
async def request_agent_action(
    agent_id: uuid.UUID,
    body: AgentActionRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AgentRunResponse:
    """Request an agent action, creating an AgentRun for the approval flow.

    Admin-only. These rows feed a human approval queue; creating them is a
    privileged operation, not something any authenticated user may do.
    """
    _require_admin(user)

    # Verify agent exists
    config_result = await db.execute(
        select(AgentConfig).where(AgentConfig.id == agent_id)
    )
    config = config_result.scalar_one_or_none()
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent config not found",
        )

    run = AgentRun(
        agent_config_id=agent_id,
        room_id=body.room_id,
        action_type=body.action_type,
        action_detail=body.action_detail,
        status=AgentRunStatus.PENDING_APPROVAL,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    logger.info(
        "agent_action_requested",
        run_id=str(run.id),
        agent_id=str(agent_id),
        action_type=body.action_type,
    )

    return AgentRunResponse(
        id=run.id,
        agent_config_id=run.agent_config_id,
        room_id=run.room_id,
        action_type=run.action_type,
        action_detail=run.action_detail,
        status=run.status.value,
        approved_by=run.approved_by,
        started_at=run.started_at,
        completed_at=run.completed_at,
        error_message=run.error_message,
    )


@router.post("/agent-runs/{run_id}/approve", response_model=AgentRunResponse)
async def approve_agent_run(
    run_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AgentRunResponse:
    """Approve a pending agent action — NOT YET IMPLEMENTED.

    Admin-only. This endpoint historically set status=APPROVED and claimed
    success, but nothing in the system consumes ``AgentRunStatus.APPROVED``:
    there is no executor that runs an approved action, and ``EXECUTED`` is
    never reached. Rather than imply an action ran, we admin-gate the route
    and return 501 without mutating state. When an execution engine is built,
    replace this body with the real approve→execute transition.
    """
    _require_admin(user)

    result = await db.execute(
        select(AgentRun).where(AgentRun.id == run_id)
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent run not found",
        )

    if run.status != AgentRunStatus.PENDING_APPROVAL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot approve run with status: {run.status.value}",
        )

    logger.warning(
        "agent_run_approve_not_implemented",
        run_id=str(run_id),
        requested_by=str(user["participant_id"]),
    )
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=(
            "Agent action approval is not implemented: no executor consumes "
            "approved runs. The run remains pending. Use /reject to dismiss it."
        ),
    )


@router.post("/agent-runs/{run_id}/reject", response_model=AgentRunResponse)
async def reject_agent_run(
    run_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AgentRunResponse:
    """Reject a pending agent action. Admin-only."""
    _require_admin(user)

    result = await db.execute(
        select(AgentRun).where(AgentRun.id == run_id)
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent run not found",
        )

    if run.status != AgentRunStatus.PENDING_APPROVAL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot reject run with status: {run.status.value}",
        )

    run.status = AgentRunStatus.REJECTED
    run.approved_by = user["participant_id"]
    run.completed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(run)

    logger.info(
        "agent_run_rejected",
        run_id=str(run_id),
        rejected_by=str(user["participant_id"]),
    )

    return AgentRunResponse(
        id=run.id,
        agent_config_id=run.agent_config_id,
        room_id=run.room_id,
        action_type=run.action_type,
        action_detail=run.action_detail,
        status=run.status.value,
        approved_by=run.approved_by,
        started_at=run.started_at,
        completed_at=run.completed_at,
        error_message=run.error_message,
    )
