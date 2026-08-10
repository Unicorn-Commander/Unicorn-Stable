"""Admin API for per-user agent access grants.

Instance-admin only (Keycloak realm roles ∩ STABLE_ADMIN_ROLES — the same
mechanism ``api/instance_meta.py`` uses). API-first v1: the Settings UI can
come later; these three routes are the whole management surface:

  GET    /agent-access/grants   → the instance default + every grant row
  PUT    /agent-access/grants   → upsert one (participant, agent) grant
  DELETE /agent-access/grants   → drop one grant (pair reverts to the default)

Enforcement itself lives in ``services/agent_access.py`` and is exercised by
the brigade invite + room member-invite routes.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_settings_dep
from app.models.agent_access import AgentAccessEffect, AgentAccessGrant
from app.models.participant import Participant, ParticipantType
from app.services.agent_access import require_instance_admin

logger = structlog.get_logger(__name__)

router = APIRouter()


class AgentAccessGrantResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    participant_id: uuid.UUID
    agent_id: str
    effect: AgentAccessEffect
    granted_by: uuid.UUID | None = None
    created_at: datetime


class AgentAccessGrantsEnvelope(BaseModel):
    """The grants plus the default they override — a grant list is not
    interpretable without knowing which direction the instance falls."""

    default: Literal["open", "closed"]
    grants: list[AgentAccessGrantResponse]


class UpsertGrantBody(BaseModel):
    participant_id: uuid.UUID
    agent_id: str
    effect: AgentAccessEffect


@router.get("/agent-access/grants", response_model=AgentAccessGrantsEnvelope)
async def list_agent_access_grants(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    participant_id: uuid.UUID | None = Query(None),
    agent_id: str | None = Query(None, max_length=128),
) -> AgentAccessGrantsEnvelope:
    """List grants (optionally filtered by participant and/or agent). Admin only."""
    require_instance_admin(user)
    stmt = select(AgentAccessGrant).order_by(AgentAccessGrant.created_at)
    if participant_id is not None:
        stmt = stmt.where(AgentAccessGrant.participant_id == participant_id)
    if agent_id:
        stmt = stmt.where(AgentAccessGrant.agent_id == agent_id)
    rows = (await db.execute(stmt)).scalars().all()
    return AgentAccessGrantsEnvelope(
        default="closed" if settings.agent_access_default == "closed" else "open",
        grants=[AgentAccessGrantResponse.model_validate(r) for r in rows],
    )


@router.put("/agent-access/grants", response_model=AgentAccessGrantResponse)
async def upsert_agent_access_grant(
    body: UpsertGrantBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AgentAccessGrantResponse:
    """Create or update the grant for one (participant, agent) pair. Admin only.

    Grants target HUMANS: an agent-typed participant is never a grantee (the
    worker runtime is exempt from enforcement by principal type, not by grant).
    """
    require_instance_admin(user)

    agent_id = body.agent_id.strip()
    if not agent_id:
        raise HTTPException(status_code=422, detail="agent_id required")

    target = (
        await db.execute(
            select(Participant).where(Participant.id == body.participant_id)
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="Participant not found")
    if target.participant_type == ParticipantType.AGENT:
        raise HTTPException(
            status_code=400,
            detail="Grants apply to human participants, not agents.",
        )

    existing = (
        await db.execute(
            select(AgentAccessGrant).where(
                AgentAccessGrant.participant_id == body.participant_id,
                AgentAccessGrant.agent_id == agent_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.effect = body.effect
        existing.granted_by = user["participant_id"]
        grant = existing
    else:
        grant = AgentAccessGrant(
            participant_id=body.participant_id,
            agent_id=agent_id,
            effect=body.effect,
            granted_by=user["participant_id"],
        )
        db.add(grant)
    await db.commit()
    await db.refresh(grant)
    logger.info(
        "agent_access_grant_upserted",
        participant_id=str(body.participant_id),
        agent_id=agent_id,
        effect=body.effect.value,
        granted_by=str(user.get("participant_id")),
    )
    return AgentAccessGrantResponse.model_validate(grant)


@router.delete("/agent-access/grants", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent_access_grant(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    participant_id: Annotated[uuid.UUID, Query()],
    agent_id: Annotated[str, Query(max_length=128)],
) -> None:
    """Remove a grant — the pair falls back to the instance default. Admin only."""
    require_instance_admin(user)
    await db.execute(
        delete(AgentAccessGrant).where(
            AgentAccessGrant.participant_id == participant_id,
            AgentAccessGrant.agent_id == agent_id,
        )
    )
    await db.commit()
    logger.info(
        "agent_access_grant_removed",
        participant_id=str(participant_id),
        agent_id=agent_id,
        removed_by=str(user.get("participant_id")),
    )
    return None
