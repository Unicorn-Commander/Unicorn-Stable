"""Artifacts (canvas) REST API.

Mirrors ``app/api/messages.py``: ``APIRouter`` mounted under ``/api/v1``,
Keycloak auth via ``get_current_user``, room-scoped authz via
``require_room_member`` / ``ensure_room_member`` (room membership is the live
access boundary — tenancy/RLS is not enforced in the deployed schema), and
realtime fan-out over the LiveKit data channel (same pattern MessageService
uses) so other clients re-render the canvas live.

Write verbs map to the framework-agnostic service:
    POST   /rooms/{room_id}/artifacts                 create
    GET    /rooms/{room_id}/artifacts                  list (room)
    GET    /artifacts/{artifact_id}                    read + current content
    GET    /artifacts/{artifact_id}/versions           version history
    POST   /artifacts/{artifact_id}/rewrite            whole-doc new version
    POST   /artifacts/{artifact_id}/edit               server-side search/replace
    POST   /artifacts/{artifact_id}/restore            restore-to-version
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import (
    ensure_room_member,
    get_current_user,
    get_db,
    get_livekit,
    require_room_member,
)
from app.models.artifact import Artifact, ArtifactAuthorKind, ArtifactVersion
from app.services import artifact_service as svc
from app.services.artifact_service import ArtifactEditError, ArtifactError, ArtifactNotFound
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas (inline, matching the messages.py style)
# ---------------------------------------------------------------------------


class ArtifactCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    kind: str = Field("markdown")
    content: str = Field("")
    language: str | None = Field(None, max_length=64)


class RewriteBody(BaseModel):
    content: str
    summary: str | None = Field(None, max_length=500)


class EditBlock(BaseModel):
    search: str
    replace: str
    replace_all: bool = False


class EditBody(BaseModel):
    edits: list[EditBlock] = Field(..., min_length=1)
    summary: str | None = Field(None, max_length=500)


class RestoreBody(BaseModel):
    version_id: uuid.UUID


class VersionResponse(BaseModel):
    id: uuid.UUID
    artifact_id: uuid.UUID
    seq: int
    content: str
    parent_version_id: uuid.UUID | None
    author_kind: str
    author_id: uuid.UUID | None
    edit_op: dict[str, Any] | None
    created_at: datetime


class ArtifactResponse(BaseModel):
    id: uuid.UUID
    room_id: uuid.UUID
    org_id: uuid.UUID | None
    title: str
    kind: str
    language: str | None
    current_version_id: uuid.UUID | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    # Convenience: head content + seq, populated on single-artifact reads.
    content: str | None = None
    current_seq: int | None = None


def _version_to_response(v: ArtifactVersion) -> VersionResponse:
    return VersionResponse(
        id=v.id,
        artifact_id=v.artifact_id,
        seq=v.seq,
        content=v.content,
        parent_version_id=v.parent_version_id,
        author_kind=v.author_kind.value if v.author_kind else "human",
        author_id=v.author_id,
        edit_op=v.edit_op or {},
        created_at=v.created_at,
    )


def _artifact_to_response(
    a: Artifact, content: str | None = None, current_seq: int | None = None
) -> ArtifactResponse:
    return ArtifactResponse(
        id=a.id,
        room_id=a.room_id,
        org_id=a.org_id,
        title=a.title,
        kind=a.kind.value if a.kind else "markdown",
        language=a.language,
        current_version_id=a.current_version_id,
        created_by=a.created_by,
        created_at=a.created_at,
        updated_at=a.updated_at,
        content=content,
        current_seq=current_seq,
    )


def _raise_http(err: ArtifactError) -> None:
    """Translate a domain error into the right HTTP status + structured body."""
    if isinstance(err, ArtifactNotFound):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=err.to_dict())
    if isinstance(err, ArtifactEditError):
        # 422: the edit was well-formed but no block matched — body carries the
        # per-block reasons so the model/UI can self-correct.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=err.to_dict()
        )
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST, detail=err.to_dict()
    )


async def _broadcast(
    livekit: LiveKitService, db: AsyncSession, artifact: Artifact, event: str, **extra: Any
) -> None:
    """Fan an artifact event out over the room's LiveKit data channel.

    Best-effort, exactly like MessageService — a broadcast failure never fails
    the request.
    """
    from sqlalchemy import select as _select

    from app.models.room import Room as _Room

    try:
        lk_name = (
            await db.execute(
                _select(_Room.livekit_room_name).where(_Room.id == artifact.room_id)
            )
        ).scalar_one_or_none()
        if not lk_name:
            return
        await livekit.send_data(
            room_name=lk_name,
            data={
                "type": event,
                "room_id": str(artifact.room_id),
                "artifact_id": str(artifact.id),
                "current_version_id": str(artifact.current_version_id)
                if artifact.current_version_id
                else None,
                **extra,
            },
        )
    except Exception:
        logger.debug("artifact_broadcast_failed", broadcast_event=event, exc_info=True)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/rooms/{room_id}/artifacts",
    response_model=ArtifactResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_artifact(
    room_id: uuid.UUID,
    body: ArtifactCreate,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> ArtifactResponse:
    """Create a new canvas artifact in a room (caller must be a member)."""
    try:
        artifact = await svc.create_artifact(
            db,
            room_id=room_id,
            title=body.title,
            kind=body.kind,
            content=body.content,
            language=body.language,
            author_kind=ArtifactAuthorKind.HUMAN,
            author_id=user["participant_id"],
        )
        await db.commit()
        await db.refresh(artifact)
    except ArtifactError as err:
        await db.rollback()
        _raise_http(err)
    await _broadcast(livekit, db, artifact, "artifact_created", title=artifact.title)
    return _artifact_to_response(artifact, content=body.content, current_seq=1)


@router.get("/rooms/{room_id}/artifacts", response_model=list[ArtifactResponse])
async def list_artifacts(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[ArtifactResponse]:
    """List all artifacts in a room (metadata only; no content body)."""
    rows = await svc.list_room_artifacts(db, room_id)
    return [_artifact_to_response(a) for a in rows]


async def _load_artifact_checked(
    db: AsyncSession, artifact_id: uuid.UUID, user: dict[str, Any]
) -> Artifact:
    """Load an artifact and enforce membership of its room."""
    try:
        artifact = await svc.get_artifact(db, artifact_id)
    except ArtifactNotFound as err:
        _raise_http(err)
    await ensure_room_member(db, artifact.room_id, user)
    return artifact


@router.get("/artifacts/{artifact_id}", response_model=ArtifactResponse)
async def get_artifact(
    artifact_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ArtifactResponse:
    """Get one artifact with its current head content."""
    artifact = await _load_artifact_checked(db, artifact_id, user)
    content = await svc.get_current_content(db, artifact)
    seq = None
    if artifact.current_version_id is not None:
        cv = artifact.current_version
        seq = cv.seq if cv is not None else None
    return _artifact_to_response(artifact, content=content, current_seq=seq)


@router.get("/artifacts/{artifact_id}/versions", response_model=list[VersionResponse])
async def get_artifact_versions(
    artifact_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[VersionResponse]:
    """Get the full (oldest-first) version history of an artifact."""
    artifact = await _load_artifact_checked(db, artifact_id, user)
    versions = await svc.get_versions(db, artifact.id)
    return [_version_to_response(v) for v in versions]


@router.post("/artifacts/{artifact_id}/rewrite", response_model=VersionResponse)
async def rewrite_artifact(
    artifact_id: uuid.UUID,
    body: RewriteBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> VersionResponse:
    """Replace the whole document, creating a new version (weaker-model path)."""
    artifact = await _load_artifact_checked(db, artifact_id, user)
    try:
        version = await svc.rewrite_artifact(
            db,
            artifact=artifact,
            content=body.content,
            author_kind=ArtifactAuthorKind.HUMAN,
            author_id=user["participant_id"],
            summary=body.summary,
        )
        await db.commit()
        await db.refresh(version)
        await db.refresh(artifact)
    except ArtifactError as err:
        await db.rollback()
        _raise_http(err)
    await _broadcast(livekit, db, artifact, "artifact_updated", seq=version.seq, op="rewrite")
    return _version_to_response(version)


@router.post("/artifacts/{artifact_id}/edit", response_model=VersionResponse)
async def edit_artifact(
    artifact_id: uuid.UUID,
    body: EditBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> VersionResponse:
    """Apply deterministic server-side SEARCH/REPLACE edits (frontier path).

    On a non-matching block, returns 422 with per-block reasons (the structured
    ``ArtifactEditError`` body) so the caller can fix-and-retry. Never no-ops.
    """
    artifact = await _load_artifact_checked(db, artifact_id, user)
    edits = [e.model_dump() for e in body.edits]
    try:
        version = await svc.edit_artifact(
            db,
            artifact=artifact,
            edits=edits,
            author_kind=ArtifactAuthorKind.HUMAN,
            author_id=user["participant_id"],
            summary=body.summary,
        )
        await db.commit()
        await db.refresh(version)
        await db.refresh(artifact)
    except ArtifactError as err:
        await db.rollback()
        _raise_http(err)
    await _broadcast(livekit, db, artifact, "artifact_updated", seq=version.seq, op="edit")
    return _version_to_response(version)


@router.post("/artifacts/{artifact_id}/restore", response_model=VersionResponse)
async def restore_artifact_version(
    artifact_id: uuid.UUID,
    body: RestoreBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> VersionResponse:
    """Restore to a prior version by appending a copy as the new head."""
    artifact = await _load_artifact_checked(db, artifact_id, user)
    try:
        version = await svc.restore_version(
            db,
            artifact=artifact,
            target_version_id=body.version_id,
            author_kind=ArtifactAuthorKind.HUMAN,
            author_id=user["participant_id"],
        )
        await db.commit()
        await db.refresh(version)
        await db.refresh(artifact)
    except ArtifactError as err:
        await db.rollback()
        _raise_http(err)
    await _broadcast(
        livekit, db, artifact, "artifact_updated", seq=version.seq, op="restore"
    )
    return _version_to_response(version)
