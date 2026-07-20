"""Internal artifact (canvas) routes — Brigade agent tool callbacks.

Lets a Brigade-driven agent (e.g. Majik) author into a room's canvas. Brigade
owns tool-calling; when the agent calls a ``create_artifact`` /
``rewrite_artifact`` / ``edit_artifact`` tool, the tool makes an HTTP call back
into Stable against the routes here.

This module is the canvas analogue of the internal agent-message routes in
``app/api/messages.py`` (``POST /internal/agent-messages`` etc.). It MIRRORS
that pattern exactly:

  * Auth via the shared LiveKit secret — ``Authorization: Bearer
    <settings.livekit_api_secret>`` — the same secret the agent worker uses to
    mint LiveKit tokens. No Keycloak user is involved.
  * The room is addressed by ``room_id`` OR ``livekit_room_name``.
  * On first call for a given ``brigade_agent_id`` an agent-typed Participant
    row (``keycloak_sub == "brigade:<id>"``) is auto-created and joined to the
    room, so the artifact's ``author_id`` is a first-class participant and the
    canvas version history attributes the agent correctly.

The actual artifact writes go through the framework-agnostic
``app.services.artifact_service`` (same calls the human REST routes in
``app/api/artifacts.py`` use), with ``author_kind=AGENT``. Realtime fan-out and
the structured-edit-error → 422 contract are identical to ``artifacts.py`` so
the canvas live-updates and the model can self-correct a failed edit.

Routes (mounted under ``/api/v1``):
    POST /internal/artifacts/create     create a new artifact (seq-1)
    POST /internal/artifacts/rewrite    whole-document new version
    POST /internal/artifacts/edit       deterministic search/replace edits
"""

from __future__ import annotations

import uuid
from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._internal_auth import verify_internal_bearer
from app.api.artifacts import broadcast_artifact_event
from app.config import get_settings
from app.deps import get_db, get_livekit
from app.models.artifact import Artifact, ArtifactAuthorKind
from app.models.participant import (
    Participant,
    ParticipantStatus,
    ParticipantType,
)
from app.models.room import MemberRole, Room, RoomMember
from app.services import artifact_service as svc
from app.services.artifact_service import (
    ArtifactEditError,
    ArtifactError,
    ArtifactNotFound,
)
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas (inline, matching the messages.py / artifacts.py style)
# ---------------------------------------------------------------------------


class _AgentArtifactBase(BaseModel):
    """Shared room-addressing + agent-identity fields for every tool call.

    The room may be addressed by its Stable ``room_id`` OR its
    ``livekit_room_name`` (the agent worker generally knows the LiveKit room it
    is sitting in, not the Stable uuid). Exactly one must be supplied.
    """

    room_id: uuid.UUID | None = None
    livekit_room_name: str | None = None
    brigade_agent_id: str = Field(..., min_length=1, max_length=128)

    @model_validator(mode="after")
    def _require_room_ref(self) -> "_AgentArtifactBase":
        if self.room_id is None and not (self.livekit_room_name or "").strip():
            raise ValueError("one of room_id or livekit_room_name is required")
        return self


class AgentArtifactCreate(_AgentArtifactBase):
    title: str = Field(..., min_length=1, max_length=255)
    kind: str = Field("markdown")
    language: str | None = Field(None, max_length=64)
    content: str = Field("")


class AgentArtifactRewrite(_AgentArtifactBase):
    artifact_id: uuid.UUID
    content: str
    summary: str | None = Field(None, max_length=500)


class AgentEditBlock(BaseModel):
    search: str
    replace: str
    replace_all: bool = False


class AgentArtifactEdit(_AgentArtifactBase):
    artifact_id: uuid.UUID
    edits: list[AgentEditBlock] = Field(..., min_length=1)
    summary: str | None = Field(None, max_length=500)


class AgentVersionResult(BaseModel):
    """Lean version-info payload returned to the Brigade tool.

    Deliberately small (the agent only needs to know the write landed and at
    what version); the full artifact + content is fetched by the browser over
    the data-channel broadcast that every write emits.
    """

    artifact_id: uuid.UUID
    current_version_id: uuid.UUID | None
    seq: int


# ---------------------------------------------------------------------------
# Helpers (mirrors messages.py auth/participant + artifacts.py error/broadcast)
# ---------------------------------------------------------------------------


def _check_agent_secret(request: Request) -> None:
    """Authn for the internal agent surface — constant-time bearer check
    against the split ``internal_agent_secret`` (see ``app.api._internal_auth``)."""
    verify_internal_bearer(request)


async def _resolve_room(db: AsyncSession, body: _AgentArtifactBase) -> Room:
    """Look the room up by id or livekit_room_name (whichever was supplied)."""
    if body.room_id is not None:
        stmt = select(Room).where(Room.id == body.room_id)
    else:
        stmt = select(Room).where(Room.livekit_room_name == body.livekit_room_name)
    room = (await db.execute(stmt)).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


async def _ensure_agent_member(
    db: AsyncSession, room: Room, brigade_agent_id: str
) -> Participant:
    """Find or auto-create the agent participant + its room membership.

    Byte-for-byte the same resolution ``post_agent_message`` does: an
    agent-typed Participant keyed on ``keycloak_sub == "brigade:<id>"`` joined
    to the room as a MEMBER (artifact writes need an author participant; the
    membership keeps the agent a first-class room resident).
    """
    pseudo_sub = f"brigade:{brigade_agent_id}"
    pseudo_username = f"agent-{brigade_agent_id}"
    agent_p = (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == pseudo_sub)
        )
    ).scalar_one_or_none()
    if agent_p is None:
        # Friendly display name: convert "col-finance" → "Col Finance".
        display = brigade_agent_id.replace("-", " ").title()
        agent_p = Participant(
            keycloak_sub=pseudo_sub,
            username=pseudo_username,
            display_name=display,
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
        )
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)

    existing_member = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == agent_p.id,
            )
        )
    ).scalar_one_or_none()
    if existing_member is None:
        db.add(
            RoomMember(
                room_id=room.id,
                participant_id=agent_p.id,
                role=MemberRole.MEMBER,
            )
        )
        await db.commit()
    return agent_p


def _raise_http(err: ArtifactError) -> None:
    """Translate a domain error into the right HTTP status + structured body.

    Same mapping as ``artifacts.py``: a non-matching SEARCH/REPLACE returns 422
    carrying the per-block reasons so the MODEL can self-correct (never a 500).
    """
    if isinstance(err, ArtifactNotFound):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=err.to_dict())
    if isinstance(err, ArtifactEditError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=err.to_dict()
        )
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.to_dict())


# Agent-authored changes fan out through the EXACT same function as human ones.
# This was a verbatim copy of artifacts.py's broadcaster, which meant the
# ws-plane fix had to be made twice or agents would stay invisible — and agents
# are the main authors of artifacts. Delegating removes that trap permanently.
_broadcast = broadcast_artifact_event


async def _load_agent_artifact(
    db: AsyncSession, artifact_id: uuid.UUID, room: Room
) -> Artifact:
    """Load an artifact and enforce it belongs to the resolved room.

    The agent is already proven a member of ``room`` (via _ensure_agent_member);
    pinning the artifact to that same room is the access boundary — it stops an
    agent in room A from editing room B's canvas by id.
    """
    try:
        artifact = await svc.get_artifact(db, artifact_id)
    except ArtifactNotFound as err:
        _raise_http(err)
    if artifact.room_id != room.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "artifact_not_in_room",
                "message": "Artifact does not belong to the addressed room.",
            },
        )
    return artifact


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/internal/artifacts/create",
    response_model=AgentVersionResult,
    status_code=status.HTTP_201_CREATED,
)
async def agent_create_artifact(
    body: AgentArtifactCreate,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> AgentVersionResult:
    """Create a new canvas artifact authored by a Brigade agent."""
    _check_agent_secret(request)
    room = await _resolve_room(db, body)
    agent_p = await _ensure_agent_member(db, room, body.brigade_agent_id)
    try:
        artifact = await svc.create_artifact(
            db,
            room_id=room.id,
            title=body.title,
            kind=body.kind,
            content=body.content,
            language=body.language,
            author_kind=ArtifactAuthorKind.AGENT,
            author_id=agent_p.id,
        )
        await db.commit()
        await db.refresh(artifact)
    except ArtifactError as err:
        await db.rollback()
        _raise_http(err)
    await _broadcast(livekit, db, artifact, "artifact_created", title=artifact.title)
    return AgentVersionResult(
        artifact_id=artifact.id,
        current_version_id=artifact.current_version_id,
        seq=1,
    )


@router.post("/internal/artifacts/rewrite", response_model=AgentVersionResult)
async def agent_rewrite_artifact(
    body: AgentArtifactRewrite,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> AgentVersionResult:
    """Replace an artifact's whole document, creating a new version.

    The weaker/local-model path (the model returns the ENTIRE new document
    rather than a surgical patch). Always succeeds — nothing to match.
    """
    _check_agent_secret(request)
    room = await _resolve_room(db, body)
    agent_p = await _ensure_agent_member(db, room, body.brigade_agent_id)
    artifact = await _load_agent_artifact(db, body.artifact_id, room)
    try:
        version = await svc.rewrite_artifact(
            db,
            artifact=artifact,
            content=body.content,
            author_kind=ArtifactAuthorKind.AGENT,
            author_id=agent_p.id,
            summary=body.summary,
        )
        await db.commit()
        await db.refresh(version)
        await db.refresh(artifact)
    except ArtifactError as err:
        await db.rollback()
        _raise_http(err)
    await _broadcast(
        livekit, db, artifact, "artifact_updated", seq=version.seq, op="rewrite"
    )
    return AgentVersionResult(
        artifact_id=artifact.id,
        current_version_id=artifact.current_version_id,
        seq=version.seq,
    )


@router.post("/internal/artifacts/edit", response_model=AgentVersionResult)
async def agent_edit_artifact(
    body: AgentArtifactEdit,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> AgentVersionResult:
    """Apply deterministic server-side SEARCH/REPLACE edits (frontier path).

    On a non-matching block, returns 422 with the structured
    ``ArtifactEditError`` body (per-block reasons + closest-snippet) so the
    model can fix-and-retry. Never no-ops, never 500s on a bad match.
    """
    _check_agent_secret(request)
    room = await _resolve_room(db, body)
    agent_p = await _ensure_agent_member(db, room, body.brigade_agent_id)
    artifact = await _load_agent_artifact(db, body.artifact_id, room)
    edits = [e.model_dump() for e in body.edits]
    try:
        version = await svc.edit_artifact(
            db,
            artifact=artifact,
            edits=edits,
            author_kind=ArtifactAuthorKind.AGENT,
            author_id=agent_p.id,
            summary=body.summary,
        )
        await db.commit()
        await db.refresh(version)
        await db.refresh(artifact)
    except ArtifactError as err:
        await db.rollback()
        _raise_http(err)
    await _broadcast(
        livekit, db, artifact, "artifact_updated", seq=version.seq, op="edit"
    )
    return AgentVersionResult(
        artifact_id=artifact.id,
        current_version_id=artifact.current_version_id,
        seq=version.seq,
    )
