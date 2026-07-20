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
    DELETE /knowledge/collections/{id}                   delete a collection
    GET    /knowledge/collections/{id}/usage             what a delete would break
    POST   /knowledge/collections/{id}/documents         upload + index a doc
    GET    /knowledge/collections/{id}/documents         list a collection's docs
    DELETE /knowledge/collections/{id}/documents/{doc}   delete a doc + its vectors
    POST   /knowledge/collections/{id}/documents/{doc}/reindex  retry indexing
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
    Query,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import (
    get_current_user,
    get_db,
    get_settings_dep,
    is_room_member,
    rate_limit,
    require_room_member,
)
from app.models.knowledge import (
    KnowledgeCollection,
    KnowledgeDocument,
    RoomKnowledge,
)
from app.models.room import Room
from app.security.upload_guard import (
    is_dangerous_content_type,
    sniff_is_markup,
)
from app.services.knowledge_service import (
    RETRIEVAL_UNAVAILABLE,
    knowledge_service,
)

logger = structlog.get_logger(__name__)

router = APIRouter()

# Shown whenever the retrieval plane could not be reached. Deliberately states
# what is NOT known: an unreachable index tells us nothing about whether a match
# exists, so we must not report it as "no matches".
UNAVAILABLE_DETAIL = (
    "Knowledge retrieval is unavailable \u2014 the search index could not be "
    "reached, so we cannot tell you whether your knowledge bases contain a "
    "match. Answers in this room are NOT grounded in them right now."
)

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


class UsageRoom(BaseModel):
    """A room that would lose this Knowledge Base if it were deleted."""

    id: uuid.UUID
    display_name: str


class CollectionUsageResponse(BaseModel):
    """What deleting a Knowledge Base would take with it.

    Shown to the user BEFORE they confirm, because a delete cascades the
    ``room_knowledge`` bindings away — every room in ``rooms`` silently stops
    being able to answer from these documents.

    ``rooms`` only lists rooms the CALLER is a member of; rooms they cannot see
    are counted in ``hidden_room_count`` instead of being named, so the warning
    is honest ("2 other rooms also use this") without leaking room names.
    """

    collection_id: uuid.UUID
    document_count: int
    room_count: int
    rooms: list[UsageRoom]
    hidden_room_count: int


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
    """One retrieved excerpt, with the locator that makes it openable.

    ``collection_id`` + ``document_id`` + ``chunk_idx`` are the LOCATOR: they
    are what lets the panel point back at the exact indexed text this excerpt
    came from, instead of showing a filename the reader cannot click. This
    mirrors ``internal_knowledge.KnowledgeSearchHit`` field for field — the two
    surfaces run the SAME retrieval, so a hit a human sees in the panel must be
    as navigable as the same hit cited on an agent answer. Dropping the ids here
    is not cosmetic: it silently strands the user on a dead-end result.
    """

    text: str
    filename: str
    score: float
    collection_id: str | None = None
    document_id: str | None = None
    chunk_idx: int | None = None


class KnowledgeSearchResponse(BaseModel):
    results: list[KnowledgeSearchHit]


class RetrievalHealthResponse(BaseModel):
    """Whether knowledge retrieval can run at all.

    Lets a client state the honest thing up front — "search is down" — instead
    of running a query and mislabelling the resulting silence as "no matches".
    """

    available: bool
    qdrant: str
    infinity: str
    detail: str


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


async def _authz_collection(
    db: AsyncSession,
    collection_id: uuid.UUID,
    user: dict[str, Any],
    settings: Settings,
    *,
    write: bool = False,
) -> KnowledgeCollection:
    """Load a collection and authorize the caller (B5: KB tenant isolation).

    Access is granted iff ONE of:
      1. the caller created it (``created_by``), OR
      2. this is a per-org instance and the collection belongs to that org
         (``org_id`` == ``settings.instance_org_id``) — colleagues in the same
         org share Knowledge Bases, which is the whole point of offering C, OR
      3. (READS only) the collection is attached to a room the caller is a
         member of — a KB shared into a room is readable by that room's members.

    Anything else is ``404`` (not 403) so a probing user can't even confirm a
    collection id exists. Writes never fall through to the room-membership
    branch: being in a room a KB is attached to does not grant upload rights.
    """
    collection = await _load_collection(db, collection_id)
    participant_id = user["participant_id"]

    # 1) Creator.
    if collection.created_by is not None and str(collection.created_by) == str(
        participant_id
    ):
        return collection

    # 2) Same-org sharing (only when an instance org is configured).
    org = settings.instance_org_id
    if org is not None and collection.org_id is not None and str(
        collection.org_id
    ) == str(org):
        return collection

    # 3) Read via room attachment.
    if not write:
        attached_rooms = (
            await db.execute(
                select(RoomKnowledge.room_id).where(
                    RoomKnowledge.collection_id == collection_id
                )
            )
        ).scalars().all()
        for room_id in attached_rooms:
            if await is_room_member(db, room_id, participant_id):
                return collection

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="Collection not found"
    )


def _unlink_stored(settings: Settings, stored_name: str | None) -> None:
    """Remove an uploaded file from disk. Best-effort and path-confined.

    ``stored_name`` is generated server-side (``<32hex><suffix>``) but is read
    back out of the DB here, so it is re-validated and resolved INSIDE
    ``upload_dir`` before anything is unlinked — a delete route must not be a
    way to remove arbitrary files. A failure here is logged, never raised: the
    authoritative deletions (vectors, then the row) have already happened and a
    leftover blob is not a correctness or disclosure problem the way an
    orphaned vector is.
    """
    if not stored_name:
        return
    try:
        upload_dir = Path(settings.upload_dir).resolve()
        target = (upload_dir / Path(stored_name).name).resolve()
        if target.parent != upload_dir:
            logger.warning("kb_unlink_outside_upload_dir", stored=stored_name)
            return
        target.unlink(missing_ok=True)
    except Exception:
        logger.warning("kb_unlink_failed", stored=stored_name, exc_info=True)


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
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _rl: Annotated[
        None, Depends(rate_limit("kb_create", "rate_limit_kb_create_per_min"))
    ] = None,
) -> CollectionResponse:
    """Create a new Knowledge Base."""
    collection = await knowledge_service.create_collection(
        db,
        name=body.name,
        description=body.description,
        created_by=user["participant_id"],
    )
    # B5: stamp the instance org so same-org colleagues can share it (per-org
    # deploy). On a community box ``instance_org_id`` is None → ownership-only.
    collection.org_id = settings.instance_org_id
    await db.commit()
    await db.refresh(collection)
    return _collection_to_response(collection)


@router.get("/knowledge/health", response_model=RetrievalHealthResponse)
async def knowledge_health(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> RetrievalHealthResponse:
    """Report whether knowledge retrieval can run (vector index + embeddings).

    Cheap, authenticated, and never raises — a client can call this before or
    alongside a search so it can tell the user "search is down" instead of
    quietly rendering an ungrounded answer as though it were sourced.
    """
    health = await knowledge_service.retrieval_health(settings)
    return RetrievalHealthResponse(
        available=bool(health.get("available")),
        qdrant=str(health.get("qdrant") or "unknown"),
        infinity=str(health.get("infinity") or "unknown"),
        detail=str(health.get("detail") or ""),
    )


@router.get("/knowledge/collections", response_model=list[CollectionResponse])
async def list_collections(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[CollectionResponse]:
    """List the caller's Knowledge Bases (most-recent first).

    B5: deny-by-default — returns the caller's own KBs plus, on a per-org
    instance, every KB in the caller's org (shared org knowledge). Previously
    this listed EVERY org's KBs to any authenticated user.
    """
    from sqlalchemy import or_

    conds = [KnowledgeCollection.created_by == user["participant_id"]]
    org = settings.instance_org_id
    if org is not None:
        conds.append(KnowledgeCollection.org_id == org)

    rows = (
        await db.execute(
            select(KnowledgeCollection)
            .where(or_(*conds))
            .order_by(KnowledgeCollection.created_at.desc())
        )
    ).scalars().all()
    return [_collection_to_response(c) for c in rows]


@router.get(
    "/knowledge/collections/{collection_id}", response_model=CollectionResponse
)
async def get_collection(
    collection_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CollectionResponse:
    """Get one Knowledge Base by id (B5: caller must be authorized)."""
    collection = await _authz_collection(db, collection_id, user, settings)
    return _collection_to_response(collection)


# ---------------------------------------------------------------------------
# Document routes (user-auth) — upload-to-disk + fire-and-forget index
# ---------------------------------------------------------------------------


async def _enforce_kb_quota(
    db: AsyncSession, settings: Settings, participant_id: Any
) -> None:
    """B7: cap the total documents a single user owns across their collections.

    Bytes are bounded transitively: each doc is ≤ ``MAX_FILE_BYTES`` (20 MB),
    so the document count is the effective disk/GPU-queue ceiling. 0 disables.
    """
    cap = int(getattr(settings, "max_kb_documents_per_user", 0) or 0)
    if cap <= 0:
        return
    count = (
        await db.execute(
            select(func.count())
            .select_from(KnowledgeDocument)
            .join(
                KnowledgeCollection,
                KnowledgeCollection.id == KnowledgeDocument.collection_id,
            )
            .where(KnowledgeCollection.created_by == participant_id)
        )
    ).scalar() or 0
    if count >= cap:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Knowledge-Base document quota reached ({cap}). "
                "Delete documents or contact your admin to raise the limit."
            ),
        )


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
    _rl: Annotated[
        None, Depends(rate_limit("kb_upload", "rate_limit_kb_upload_per_min"))
    ] = None,
) -> DocumentResponse:
    """Upload a document into a collection and index it (fire-and-forget).

    Saves the file under ``settings.upload_dir`` with a UUID-prefixed stored
    name (the same disk-save approach as ``app/api/uploads.py``), creates a
    ``KnowledgeDocument`` (status ``indexing``), then kicks
    ``knowledge_service.index_kb_document`` off as a background task — exactly
    like ``messages.py`` schedules ``index_message_attachments``. The returned
    document is ``indexing``; clients poll the list endpoint for ``ready``.
    """
    # B5: only the owner / same-org colleague may write into a collection —
    # NOT merely someone who shares a room it's attached to (write=True).
    await _authz_collection(db, collection_id, user, settings, write=True)

    # B7: per-user footprint quota — cap total docs + bytes across the user's
    # own collections so one account can't fill the shared disk / GPU queue.
    await _enforce_kb_quota(db, settings, user["participant_id"])

    content_type = (file.content_type or "").lower() or (
        mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    )
    if not any(content_type.startswith(p) for p in ALLOWED_PREFIXES):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"File type not allowed: {content_type}",
        )
    # B4: block browser-executable markup even in the doc-ingest path (defense
    # in depth — a poisoned "document" is also an indirect prompt-injection
    # vector into agents that later read it).
    if is_dangerous_content_type(content_type):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"File type not allowed (executable/markup): {content_type}",
        )

    body = await file.read(MAX_FILE_BYTES + 1)
    if len(body) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {MAX_FILE_BYTES // (1024 * 1024)} MB limit",
        )
    if sniff_is_markup(body):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="File content looks like HTML/SVG/script and is not allowed",
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
    app's session factory (the same one ``get_db`` uses).

    This wrapper is the OUTERMOST layer of the indexing path, which makes it
    the last place that can stop a document from being stranded. The retry loop
    lives inside ``index_kb_document``; anything that fails BEFORE we get there
    (notably resolving the session factory) used to be swallowed by a bare
    ``except`` — leaving the row on ``indexing`` with no live task and no
    record of why, which is precisely the "permanently stuck" bug. So:

      * the session factory has a fallback (own engine from settings) rather
        than being a single point of failure, and
      * if we still cannot run, the row is marked ``failed`` on a best-effort
        independent session, because a document the user can SEE has failed
        (and can retry) is strictly better than a spinner that never resolves.
    """
    engine = None
    try:
        from app.main import app as _app  # late import to avoid a cycle

        session_factory = getattr(_app.state, "db_session_factory", None)
        if session_factory is None:
            raise RuntimeError("app.state.db_session_factory is not set")
    except Exception:
        # The app-wide factory is unavailable (not yet initialised, or this
        # task is running outside the served app). Stand up our own rather
        # than abandoning the document.
        logger.warning("kb_index_session_factory_fallback", exc_info=True)
        try:
            from sqlalchemy.ext.asyncio import (
                async_sessionmaker,
                create_async_engine,
            )

            engine = create_async_engine(settings.database_url)
            session_factory = async_sessionmaker(engine, expire_on_commit=False)
        except Exception:
            logger.warning("kb_index_task_failed", exc_info=True)
            return

    try:
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
        # index_kb_document is itself fail-safe, so reaching here means the
        # session/transport failed. Do not leave the row claiming to be in
        # progress: mark it failed so the UI shows a retry instead of a
        # forever-spinner.
        logger.warning("kb_index_task_failed", exc_info=True)
        try:
            async with session_factory() as session:
                await knowledge_service._safe_mark(
                    session, document_id, "failed", 0
                )
        except Exception:
            logger.warning("kb_index_task_mark_failed", exc_info=True)
    finally:
        if engine is not None:
            try:
                await engine.dispose()
            except Exception:
                pass


@router.get(
    "/knowledge/collections/{collection_id}/documents",
    response_model=list[DocumentResponse],
)
async def list_documents(
    collection_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[DocumentResponse]:
    """List a collection's documents (most-recent first). B5: authorized only."""
    await _authz_collection(db, collection_id, user, settings)
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
    must belong to the addressed collection (404 otherwise). ``chunks: []`` means
    nothing is indexed (e.g. a ``failed`` or still-``indexing`` doc). If the
    document is ``ready`` but the index cannot be reached, this returns **503**
    rather than showing a ready document as empty.
    """
    await _authz_collection(db, collection_id, user, settings)
    document = await db.get(KnowledgeDocument, document_id)
    if document is None or document.collection_id != collection_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )

    content = await knowledge_service.get_document_chunks_detailed(
        settings=settings, document_id=document_id
    )
    if content["status"] == RETRIEVAL_UNAVAILABLE and document.status == "ready":
        # The document IS indexed, so empty chunks would misrepresent it as
        # blank. Say the reader is unavailable instead.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=UNAVAILABLE_DETAIL,
        )
    chunks = content["chunks"]
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
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CollectionResponse:
    """Attach a Knowledge Base to a room (caller must be a member).

    B5: the caller must also be authorized FOR THE COLLECTION (own it, or same
    org) — ``write=True`` so being in the room isn't enough to graft an
    arbitrary KB (by guessed UUID) into it and read its chunks via RAG.

    Idempotent: re-attaching an already-bound collection returns it without
    creating a duplicate (UNIQUE(room_id, collection_id) also guards this).
    """
    collection = await _authz_collection(
        db, body.collection_id, user, settings, write=True
    )

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
    using the identical ``knowledge_service`` retrieval the agent uses via
    ``internal_knowledge`` (embed -> hybrid qdrant search over the room's
    ``collection_id``s -> rerank). Only the auth differs: a room member's
    Keycloak token here vs. the shared LiveKit secret there, so results a human
    sees match what the agent would surface.

    A room with no attached KBs, or a genuine miss, returns ``{"results": []}``.
    An unreachable retrieval plane returns **503** — NOT an empty result set.
    Those are different facts and the UI renders them differently: "nothing
    matched" vs "we could not look".
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

    search = await knowledge_service.search_knowledge_detailed(
        settings=settings,
        collection_ids=collection_ids,
        query=body.query,
        k=body.k,
    )
    if search["status"] == RETRIEVAL_UNAVAILABLE:
        # An empty result set here would be a lie: we never reached the index,
        # so "no matches" is a claim we cannot make. Fail loudly instead.
        health = await knowledge_service.retrieval_health(settings)
        logger.warning(
            "kb_search_unavailable",
            room_id=str(room_id),
            qdrant=health.get("qdrant"),
            infinity=health.get("infinity"),
            detail=health.get("detail"),
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=UNAVAILABLE_DETAIL,
        )
    hits = search["results"]
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
            # Carry the locator through. ``search_knowledge_detailed`` returns
            # these; the internal (agent) route forwards them and the chat
            # citation UI uses them to open the source. The panel gets the same.
            document_id=(
                str(h["document_id"])
                if h.get("document_id") is not None
                else None
            ),
            chunk_idx=(
                h["chunk_idx"] if isinstance(h.get("chunk_idx"), int) else None
            ),
        )
        for h in (hits or [])
        if (h.get("text") or "").strip()
    ]
    return KnowledgeSearchResponse(results=results)


# ---------------------------------------------------------------------------
# Deletion (destructive) + indexing retry
#
# Deletion is the half of the lifecycle that was missing: the quota error tells
# users to "Delete documents" and there was no way to. Two rules govern it.
#
#   1. AUTHORIZATION is the manage boundary, not the read one. Every delete
#      goes through ``_authz_collection(..., write=True)`` — the same check
#      that gates uploads and attaching — so being a member of a room the KB
#      happens to be attached to does NOT let you destroy it.
#
#   2. VECTORS COME FIRST. Every tenant's chunks share one qdrant collection,
#      separated only by a payload field, so a Postgres-only delete leaves the
#      text searchable by anyone whose query reaches those points. We purge
#      qdrant, VERIFY the purge (count == 0), and only then drop the row. If
#      the purge cannot be confirmed we return 503 and keep the row, because a
#      user who still owns a visible document can retry — a user whose row we
#      deleted has no handle on the vectors that outlived it.
# ---------------------------------------------------------------------------


@router.get(
    "/knowledge/collections/{collection_id}/usage",
    response_model=CollectionUsageResponse,
)
async def get_collection_usage(
    collection_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CollectionUsageResponse:
    """Report what deleting this Knowledge Base would break.

    Read-only. The UI calls this when the user opens the delete confirmation so
    the dialog can name the rooms that depend on the KB instead of asking for a
    blind confirmation.
    """
    await _authz_collection(db, collection_id, user, settings, write=True)

    room_ids = await knowledge_service.collection_room_ids(db, collection_id)
    doc_count = await knowledge_service.collection_document_count(
        db, collection_id
    )

    visible: list[UsageRoom] = []
    hidden = 0
    for rid in room_ids:
        if await is_room_member(db, rid, user["participant_id"]):
            room = await db.get(Room, rid)
            if room is not None:
                visible.append(
                    UsageRoom(
                        id=room.id,
                        display_name=room.display_name or room.name,
                    )
                )
                continue
        hidden += 1

    return CollectionUsageResponse(
        collection_id=collection_id,
        document_count=doc_count,
        room_count=len(room_ids),
        rooms=visible,
        hidden_room_count=hidden,
    )


@router.delete(
    "/knowledge/collections/{collection_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_collection(
    collection_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    force: Annotated[
        bool,
        Query(
            description=(
                "Acknowledge that rooms still using this Knowledge Base will "
                "lose it. Required when the KB is attached to any room."
            )
        ),
    ] = False,
) -> None:
    """Delete a Knowledge Base, its documents, and all of their vectors.

    Refuses with **409** when the KB is still attached to at least one room and
    ``force`` was not passed — the response names the rooms (that the caller can
    see) so "this will break something" is a statement about WHAT, not a vague
    warning. Re-issue with ``?force=true`` to proceed.

    Returns **503** without deleting anything if the vector purge cannot be
    confirmed. Irreversible on success.
    """
    await _authz_collection(db, collection_id, user, settings, write=True)

    room_ids = await knowledge_service.collection_room_ids(db, collection_id)
    if room_ids and not force:
        names: list[str] = []
        hidden = 0
        for rid in room_ids:
            room = (
                await db.get(Room, rid)
                if await is_room_member(db, rid, user["participant_id"])
                else None
            )
            if room is not None:
                names.append(room.display_name or room.name)
            else:
                hidden += 1
        described = ", ".join(f"\u201c{n}\u201d" for n in names)
        if hidden:
            more = f"{hidden} other room{'s' if hidden != 1 else ''} you cannot see"
            described = f"{described}, plus {more}" if described else more
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"This Knowledge Base is still attached to {len(room_ids)} "
                f"room{'s' if len(room_ids) != 1 else ''} ({described}). "
                "Deleting it removes that knowledge from those rooms and their "
                "agents will no longer be able to answer from it. Detach it "
                "first, or confirm to delete anyway."
            ),
        )

    # Vectors first, and only proceed on a CONFIRMED purge. A collection-scoped
    # purge covers every document at once (they all carry this collection_id).
    if not await knowledge_service.delete_collection_vectors(
        settings, collection_id
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "The Knowledge Base was NOT deleted: its indexed text could "
                "not be removed from the search index (the index is "
                "unreachable or the purge could not be confirmed). Nothing "
                "was changed \u2014 try again once the index is reachable, so we "
                "don't leave searchable copies of documents you deleted."
            ),
        )

    # Best-effort disk cleanup before the rows go (we need stored_name).
    documents = (
        await db.execute(
            select(KnowledgeDocument).where(
                KnowledgeDocument.collection_id == collection_id
            )
        )
    ).scalars().all()
    for doc in documents:
        _unlink_stored(settings, doc.stored_name)

    # FKs are ON DELETE CASCADE for both knowledge_documents and room_knowledge.
    await db.execute(
        delete(KnowledgeCollection).where(
            KnowledgeCollection.id == collection_id
        )
    )
    await db.commit()

    logger.info(
        "kb_collection_deleted",
        participant_id=str(user["participant_id"]),
        collection_id=str(collection_id),
        documents=len(documents),
        detached_rooms=len(room_ids),
        forced=bool(force),
    )
    return None


@router.delete(
    "/knowledge/collections/{collection_id}/documents/{document_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_document(
    collection_id: uuid.UUID,
    document_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    """Delete one document, its vectors, and its file on disk. Irreversible.

    Returns **503** without deleting the row if the vector purge cannot be
    confirmed \u2014 see the section note above for why that ordering matters.
    """
    await _authz_collection(db, collection_id, user, settings, write=True)

    document = await db.get(KnowledgeDocument, document_id)
    if document is None or document.collection_id != collection_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )
    stored_name = document.stored_name

    if not await knowledge_service.delete_document_vectors(
        settings, document_id
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "The document was NOT deleted: its indexed text could not be "
                "removed from the search index (the index is unreachable or "
                "the purge could not be confirmed). Nothing was changed \u2014 try "
                "again once the index is reachable, so we don't leave a "
                "searchable copy of a document you deleted."
            ),
        )

    await db.execute(
        delete(KnowledgeDocument).where(KnowledgeDocument.id == document_id)
    )
    await db.commit()
    _unlink_stored(settings, stored_name)

    logger.info(
        "kb_document_deleted",
        participant_id=str(user["participant_id"]),
        collection_id=str(collection_id),
        document_id=str(document_id),
        stored=stored_name,
    )
    return None


@router.post(
    "/knowledge/collections/{collection_id}/documents/{document_id}/reindex",
    response_model=DocumentResponse,
)
async def reindex_document(
    collection_id: uuid.UUID,
    document_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _rl: Annotated[
        None, Depends(rate_limit("kb_upload", "rate_limit_kb_upload_per_min"))
    ] = None,
) -> DocumentResponse:
    """Retry indexing a document that ended up ``failed`` or stranded.

    This is the user-driven half of the retry story (the automatic half is the
    backoff loop inside ``knowledge_service.index_kb_document`` plus the
    startup sweep for rows stranded by a restart). It is the ONLY way to
    recover a document that already failed \u2014 the alternative was delete and
    re-upload, which was itself impossible until now.

    The row is put back into ``indexing`` and the same background task the
    upload path uses is scheduled. Re-indexing purges the document's existing
    points first, so a partially-indexed document does not end up with both its
    old and new chunks searchable.
    """
    await _authz_collection(db, collection_id, user, settings, write=True)

    document = await db.get(KnowledgeDocument, document_id)
    if document is None or document.collection_id != collection_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )
    if not document.stored_name:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This document has no stored file to re-read, so it cannot be "
                "re-indexed. Delete it and upload the file again."
            ),
        )
    stored_path = Path(settings.upload_dir) / document.stored_name
    if not stored_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "The uploaded file backing this document is no longer on "
                "disk, so it cannot be re-indexed. Delete it and upload the "
                "file again."
            ),
        )

    document.status = "indexing"
    document.chunk_count = 0
    await db.commit()
    await db.refresh(document)

    stored_name = document.stored_name
    filename = document.filename
    content_type = document.content_type or "application/octet-stream"

    try:
        import asyncio as _asyncio

        from app.config import get_settings as _get_settings

        _asyncio.create_task(
            _index_document_task(
                settings=_get_settings(),
                collection_id=collection_id,
                document_id=document_id,
                stored_name=stored_name,
                filename=filename,
                content_type=content_type,
            )
        )
    except Exception:
        logger.warning("kb_reindex_schedule_failed", exc_info=True)
        # Don't leave the row claiming to be in progress when nothing is.
        document.status = "failed"
        await db.commit()
        await db.refresh(document)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not schedule re-indexing right now. Try again.",
        ) from None

    logger.info(
        "kb_document_reindex_requested",
        participant_id=str(user["participant_id"]),
        collection_id=str(collection_id),
        document_id=str(document_id),
    )
    return _document_to_response(document)
