"""Knowledge Bases REST API.

Persistent document collections ("Knowledge Bases") + their room bindings.
Mirrors ``app/api/artifacts.py``: ``APIRouter`` mounted under ``/api/v1``,
Keycloak auth via ``get_current_user``, and room-scoped authz via
``require_room_member`` for the attach/detach/list-on-a-room verbs (room
membership is the live access boundary — tenancy/RLS is not enforced in the
deployed schema). Document indexing reuses the doc-RAG plane via
``knowledge_service`` (which itself reuses ``rag_service``), fired off as a
fire-and-forget task exactly like ``messages.py``'s ``index_message_attachments``.

Routes (mounted under ``/api/v1``):
    POST   /knowledge/collections                       create a collection
    GET    /knowledge/collections                        list collections
    GET    /knowledge/collections/{id}                   read one collection
    POST   /knowledge/collections/{id}/documents         upload + index a doc
    GET    /knowledge/collections/{id}/documents         list a collection's docs
    POST   /rooms/{room_id}/knowledge                    attach a collection
    DELETE /rooms/{room_id}/knowledge/{collection_id}    detach a collection
    GET    /rooms/{room_id}/knowledge                    list a room's collections
"""

from __future__ import annotations

import mimetypes
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import (
    get_current_user,
    get_db,
    get_settings_dep,
    require_room_member,
)
from app.models.knowledge import (
    KnowledgeCollection,
    KnowledgeDocument,
    RoomKnowledge,
)
from app.services.knowledge_service import knowledge_service

logger = structlog.get_logger(__name__)

router = APIRouter()

# Same per-file cap + allowed types as app/api/uploads.py (document subset).
MAX_FILE_BYTES = 20 * 1024 * 1024  # 20 MB
ALLOWED_PREFIXES = (
    "application/pdf",
    "application/vnd.openxmlformats-officedocument",
    "application/msword",
    "text/",
    "application/json",
)


# ---------------------------------------------------------------------------
# Schemas (inline, matching the artifacts.py style)
# ---------------------------------------------------------------------------


class CollectionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = Field(None, max_length=2000)


class CollectionResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID | None
    name: str
    description: str | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class DocumentResponse(BaseModel):
    id: uuid.UUID
    collection_id: uuid.UUID
    filename: str
    content_type: str | None
    chunk_count: int
    status: str
    created_at: datetime


class AttachBody(BaseModel):
    collection_id: uuid.UUID


class DocumentChunk(BaseModel):
    chunk_idx: int
    text: str


class DocumentContentResponse(BaseModel):
    """A document's human-readable extracted text, chunk by chunk."""

    document_id: uuid.UUID
    filename: str
    status: str
    chunk_count: int
    chunks: list[DocumentChunk]


class KnowledgeSearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    k: int = Field(8, ge=1, le=50)


class KnowledgeSearchHit(BaseModel):
    text: str
    filename: str
    score: float
    collection_id: str | None = None


class KnowledgeSearchResponse(BaseModel):
    results: list[KnowledgeSearchHit]


def _collection_to_response(c: KnowledgeCollection) -> CollectionResponse:
    return CollectionResponse(
        id=c.id,
        org_id=c.org_id,
        name=c.name,
        description=c.description,
        created_by=c.created_by,
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


def _document_to_response(d: KnowledgeDocument) -> DocumentResponse:
    return DocumentResponse(
        id=d.id,
        collection_id=d.collection_id,
        filename=d.filename,
        content_type=d.content_type,
        chunk_count=d.chunk_count,
        status=d.status,
        created_at=d.created_at,
    )


async def _load_collection(
    db: AsyncSession, collection_id: uuid.UUID
) -> KnowledgeCollection:
    collection = await db.get(KnowledgeCollection, collection_id)
    if collection is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Collection not found"
        )
    return collection


# ---------------------------------------------------------------------------
# Collection routes (user-auth)
# ---------------------------------------------------------------------------


@router.post(
    "/knowledge/collections",
    response_model=CollectionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_collection(
    body: CollectionCreate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CollectionResponse:
    """Create a new Knowledge Base."""
    collection = await knowledge_service.create_collection(
        db,
        name=body.name,
        description=body.description,
        created_by=user["participant_id"],
    )
    await db.commit()
    await db.refresh(collection)
    return _collection_to_response(collection)


@router.get("/knowledge/collections", response_model=list[CollectionResponse])
async def list_collections(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[CollectionResponse]:
    """List all Knowledge Bases (most-recent first)."""
    rows = (
        await db.execute(
            select(KnowledgeCollection).order_by(
                KnowledgeCollection.created_at.desc()
            )
        )
    ).scalars().all()
    return [_collection_to_response(c) for c in rows]


@router.get(
    "/knowledge/collections/{collection_id}", response_model=CollectionResponse
)
async def get_collection(
    collection_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CollectionResponse:
    """Get one Knowledge Base by id."""
    collection = await _load_collection(db, collection_id)
    return _collection_to_response(collection)


# ---------------------------------------------------------------------------
# Document routes (user-auth) — upload-to-disk + fire-and-forget index
# ---------------------------------------------------------------------------


@router.post(
    "/knowledge/collections/{collection_id}/documents",
    response_model=DocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_document(
    collection_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    file: UploadFile = File(...),
) -> DocumentResponse:
    """Upload a document into a collection and index it (fire-and-forget).

    Saves the file under ``settings.upload_dir`` with a UUID-prefixed stored
    name (the same disk-save approach as ``app/api/uploads.py``), creates a
    ``KnowledgeDocument`` (status ``indexing``), then kicks
    ``knowledge_service.index_kb_document`` off as a background task — exactly
    like ``messages.py`` schedules ``index_message_attachments``. The returned
    document is ``indexing``; clients poll the list endpoint for ``ready``.
    """
    await _load_collection(db, collection_id)

    content_type = (file.content_type or "").lower() or (
        mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    )
    if not any(content_type.startswith(p) for p in ALLOWED_PREFIXES):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"File type not allowed: {content_type}",
        )

    body = await file.read(MAX_FILE_BYTES + 1)
    if len(body) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {MAX_FILE_BYTES // (1024 * 1024)} MB limit",
        )

    # Save to disk (same scheme as uploads.py: random-hex name + safe suffix).
    original = Path(file.filename or "file").name
    suffix = Path(original).suffix.lower() or (
        mimetypes.guess_extension(content_type) or ""
    )
    if suffix and not re.fullmatch(r"\.[A-Za-z0-9]{1,16}", suffix):
        suffix = ""
    stored_name = f"{uuid.uuid4().hex}{suffix}"
    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / stored_name).write_bytes(body)

    document = KnowledgeDocument(
        collection_id=collection_id,
        filename=original,
        content_type=content_type,
        stored_name=stored_name,
        status="indexing",
        chunk_count=0,
    )
    db.add(document)
    await db.commit()
    await db.refresh(document)

    logger.info(
        "kb_document_uploaded",
        participant_id=str(user["participant_id"]),
        collection_id=str(collection_id),
        document_id=str(document.id),
        filename=original,
        stored=stored_name,
        size=len(body),
        content_type=content_type,
    )

    # Fire-and-forget indexing (mirrors messages.py). knowledge_service opens
    # its own session via the app session factory so it outlives this request's
    # ``db`` (which the dependency closes when the response is sent).
    try:
        import asyncio as _asyncio

        from app.config import get_settings as _get_settings

        _asyncio.create_task(
            _index_document_task(
                settings=_get_settings(),
                collection_id=collection_id,
                document_id=document.id,
                stored_name=stored_name,
                filename=original,
                content_type=content_type,
            )
        )
    except Exception:
        logger.warning("kb_index_schedule_failed", exc_info=True)

    return _document_to_response(document)


async def _index_document_task(
    settings: Settings,
    collection_id: uuid.UUID,
    document_id: uuid.UUID,
    stored_name: str,
    filename: str,
    content_type: str,
) -> None:
    """Background indexing wrapper with its OWN DB session.

    The request-scoped ``db`` session is closed once the response is returned,
    so the background task must not use it. We open a fresh session from the
    app's session factory (the same one ``get_db`` uses). Fully fail-safe.
    """
    try:
        from app.config import get_settings  # noqa: F401  (settings passed in)
        from app.main import app as _app  # late import to avoid a cycle

        session_factory = _app.state.db_session_factory
        async with session_factory() as session:
            await knowledge_service.index_kb_document(
                settings=settings,
                db=session,
                collection_id=collection_id,
                document_id=document_id,
                stored_name=stored_name,
                filename=filename,
                content_type=content_type,
            )
    except Exception:
        logger.warning("kb_index_task_failed", exc_info=True)


@router.get(
    "/knowledge/collections/{collection_id}/documents",
    response_model=list[DocumentResponse],
)
async def list_documents(
    collection_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[DocumentResponse]:
    """List a collection's documents (most-recent first)."""
    await _load_collection(db, collection_id)
    rows = (
        await db.execute(
            select(KnowledgeDocument)
            .where(KnowledgeDocument.collection_id == collection_id)
            .order_by(KnowledgeDocument.created_at.desc())
        )
    ).scalars().all()
    return [_document_to_response(d) for d in rows]


@router.get(
    "/knowledge/collections/{collection_id}/documents/{document_id}/chunks",
    response_model=DocumentContentResponse,
)
async def get_document_content(
    collection_id: uuid.UUID,
    document_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> DocumentContentResponse:
    """Read one document's extracted text as the indexed chunks (human-viewable).

    Makes the agent-only content human-readable: the chunks a document was split
    into (and embedded from) are fetched from the SAME qdrant collection the
    room agent searches, so what a user reads here is exactly what the agent
    retrieves over. Scoped like the neighbouring document routes — the document
    must belong to the addressed collection (404 otherwise). Content-fetch is
    fail-safe (``chunks: []`` when nothing is indexed, e.g. a ``failed`` doc).
    """
    await _load_collection(db, collection_id)
    document = await db.get(KnowledgeDocument, document_id)
    if document is None or document.collection_id != collection_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )

    chunks = await knowledge_service.get_document_chunks(
        settings=settings, document_id=document_id
    )
    return DocumentContentResponse(
        document_id=document.id,
        filename=document.filename,
        status=document.status,
        chunk_count=document.chunk_count,
        chunks=[
            DocumentChunk(chunk_idx=c["chunk_idx"], text=c["text"]) for c in chunks
        ],
    )


# ---------------------------------------------------------------------------
# Room binding routes (room-member auth)
# ---------------------------------------------------------------------------


@router.post(
    "/rooms/{room_id}/knowledge",
    response_model=CollectionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def attach_collection(
    room_id: uuid.UUID,
    body: AttachBody,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CollectionResponse:
    """Attach a Knowledge Base to a room (caller must be a member).

    Idempotent: re-attaching an already-bound collection returns it without
    creating a duplicate (UNIQUE(room_id, collection_id) also guards this).
    """
    collection = await _load_collection(db, body.collection_id)

    existing = (
        await db.execute(
            select(RoomKnowledge).where(
                RoomKnowledge.room_id == room_id,
                RoomKnowledge.collection_id == body.collection_id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            RoomKnowledge(room_id=room_id, collection_id=body.collection_id)
        )
        await db.commit()
    return _collection_to_response(collection)


@router.delete(
    "/rooms/{room_id}/knowledge/{collection_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def detach_collection(
    room_id: uuid.UUID,
    collection_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    """Detach a Knowledge Base from a room (caller must be a member).

    Idempotent: detaching a collection that isn't bound is a no-op 204."""
    await db.execute(
        delete(RoomKnowledge).where(
            RoomKnowledge.room_id == room_id,
            RoomKnowledge.collection_id == collection_id,
        )
    )
    await db.commit()
    return None


@router.get(
    "/rooms/{room_id}/knowledge", response_model=list[CollectionResponse]
)
async def list_room_collections(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[CollectionResponse]:
    """List the Knowledge Bases attached to a room (caller must be a member)."""
    rows = (
        await db.execute(
            select(KnowledgeCollection)
            .join(
                RoomKnowledge,
                RoomKnowledge.collection_id == KnowledgeCollection.id,
            )
            .where(RoomKnowledge.room_id == room_id)
            .order_by(RoomKnowledge.created_at.desc())
        )
    ).scalars().all()
    return [_collection_to_response(c) for c in rows]


@router.post(
    "/rooms/{room_id}/knowledge/search",
    response_model=KnowledgeSearchResponse,
)
async def search_room_knowledge(
    room_id: uuid.UUID,
    body: KnowledgeSearchBody,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> KnowledgeSearchResponse:
    """Run — as a human — the SAME KB search the room's agent runs.

    Retrieves the top excerpts across every Knowledge Base attached to the room,
    using the identical ``knowledge_service.search_knowledge`` retrieval the
    agent uses via ``internal_knowledge`` (embed -> hybrid qdrant search over the
    room's ``collection_id``s -> rerank). Only the auth differs: a room member's
    Keycloak token here vs. the shared LiveKit secret there, so results a human
    sees match what the agent would surface. A room with no attached KBs (or any
    internal failure) returns ``{"results": []}`` — never an error.
    """
    collection_ids = (
        await db.execute(
            select(RoomKnowledge.collection_id).where(
                RoomKnowledge.room_id == room_id
            )
        )
    ).scalars().all()
    collection_ids = [str(c) for c in collection_ids]
    if not collection_ids:
        return KnowledgeSearchResponse(results=[])

    hits = await knowledge_service.search_knowledge(
        settings=settings,
        collection_ids=collection_ids,
        query=body.query,
        k=body.k,
    )
    results = [
        KnowledgeSearchHit(
            text=h.get("text") or "",
            filename=h.get("filename") or "document",
            score=float(h.get("score") or 0.0),
            collection_id=(
                str(h["collection_id"])
                if h.get("collection_id") is not None
                else None
            ),
        )
        for h in (hits or [])
        if (h.get("text") or "").strip()
    ]
    return KnowledgeSearchResponse(results=results)
