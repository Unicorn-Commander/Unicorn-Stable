"""Internal Knowledge-Base search route — Brigade agent tool callback.

The KB analogue of ``app/api/internal_artifacts.py``: a Brigade-driven agent
(e.g. Majik) calls a ``search_knowledge`` tool, the tool makes an HTTP call
back into Stable here, and we return the most relevant excerpts across every
Knowledge Base bound to the agent's room.

MIRRORS the internal-artifact auth/room-resolution exactly (reused, not
re-implemented):
  * Auth via the shared LiveKit secret (``_check_agent_secret``) — the same
    ``Authorization: Bearer <settings.livekit_api_secret>`` the agent worker
    uses. No Keycloak user is involved.
  * The room is addressed by ``room_id`` OR ``livekit_room_name`` and resolved
    by ``_resolve_room``.

Resolution: room -> bound ``collection_id``s (via ``RoomKnowledge``) ->
``knowledge_service.search_knowledge_detailed``.

The response NEVER conflates "the knowledge bases have no answer" with "we
could not ask them". Every reply carries an explicit ``status``:

  * ``ok``          — we reached the index. ``results`` is the real answer,
                      including a truthful empty list (a genuine miss, or no
                      Knowledge Base attached to this room).
  * ``unavailable`` — we could NOT reach the index (embedder / vector store
                      down), or could not even resolve the room. ``results`` is
                      empty but carries NO information, and ``notice`` says so
                      in plain language the model can repeat to the user.

This route stays HTTP 200 in both cases on purpose: the agent tool that calls
it must be able to READ the failure and tell the human about it, which it
cannot do if the call raises and the reply path swallows the exception. The
honesty lives in the body, and ``notice`` is written to be quoted verbatim.

An agent that answers from nothing while retrieval is down is indistinguishable
from one that answers from knowledge — that is the failure this prevents.

Route (mounted under ``/api/v1``):
    POST /internal/knowledge/search    retrieve excerpts for the room's KBs
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.internal_artifacts import _check_agent_secret, _resolve_room
from app.config import get_settings
from app.deps import get_db
from app.models.knowledge import RoomKnowledge
from app.services.knowledge_service import (
    RETRIEVAL_OK,
    RETRIEVAL_UNAVAILABLE,
    knowledge_service,
)

logger = structlog.get_logger(__name__)

router = APIRouter()


class KnowledgeSearchRequest(BaseModel):
    """Room-addressing + query for an agent KB search.

    Same room-addressing contract as the internal-artifact tools: the room may
    be addressed by its Stable ``room_id`` OR its ``livekit_room_name``; exactly
    one must be supplied.
    """

    room_id: uuid.UUID | None = None
    livekit_room_name: str | None = None
    brigade_agent_id: str = Field(..., min_length=1, max_length=128)
    query: str = Field(..., min_length=1)
    k: int = Field(5, ge=1, le=50)

    @model_validator(mode="after")
    def _require_room_ref(self) -> "KnowledgeSearchRequest":
        if self.room_id is None and not (self.livekit_room_name or "").strip():
            raise ValueError("one of room_id or livekit_room_name is required")
        return self


class KnowledgeSearchHit(BaseModel):
    """One retrieved excerpt.

    ``collection_id`` + ``document_id`` + ``chunk_idx`` are the LOCATOR: they
    are what lets the caller (and the UI downstream of it) point back at the
    exact indexed text this excerpt came from, instead of citing a bare
    filename the reader cannot open.
    """

    text: str
    filename: str
    score: float
    collection_id: str | None = None
    document_id: str | None = None
    chunk_idx: int | None = None


class KnowledgeSearchResponse(BaseModel):
    """Retrieval outcome — ``status`` is part of the answer, not decoration.

    ``results: []`` means nothing on its own. Read ``status`` first: ``ok``
    makes the empty list a real finding; ``unavailable`` makes it an absence of
    knowledge about whether anything matched, and ``notice`` then holds the
    sentence to tell the user.
    """

    status: str = RETRIEVAL_OK
    notice: str | None = None
    results: list[KnowledgeSearchHit]


def _unavailable(notice: str) -> KnowledgeSearchResponse:
    """Build the "we could not look" answer.

    Empty results carrying an explicit ``unavailable`` status and a sentence
    the model can repeat. The alternative — a bare ``results: []`` — is the bug
    this route exists to avoid: it reads to the agent as "the knowledge base
    has nothing", which is a claim we have no basis for.
    """
    return KnowledgeSearchResponse(
        status=RETRIEVAL_UNAVAILABLE, notice=notice, results=[]
    )


@router.post("/internal/knowledge/search", response_model=KnowledgeSearchResponse)
async def agent_search_knowledge(
    body: KnowledgeSearchRequest,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> KnowledgeSearchResponse:
    """Search every Knowledge Base bound to the agent's room.

    Auth (shared LiveKit secret) + room resolution are reused from
    ``internal_artifacts``.

    Returns ``status=ok`` whenever we actually reached the index — including
    the truthful empty answers (no KB attached, or nothing matched). Returns
    ``status=unavailable`` when we could not look at all, so the agent can say
    "I could not search the knowledge base" instead of answering from nothing
    and sounding exactly as confident as if it had.
    """
    _check_agent_secret(request)

    try:
        room = await _resolve_room(db, body)
    except Exception:
        # _resolve_room raises 404 when the room is unknown. We did not search,
        # so we must not imply we searched and found nothing.
        logger.warning("kb_search_room_unresolved", exc_info=True)
        return _unavailable(
            "The knowledge base could not be searched: this room could not be "
            "resolved, so no knowledge base was consulted for this answer."
        )

    try:
        collection_ids = (
            await db.execute(
                select(RoomKnowledge.collection_id).where(
                    RoomKnowledge.room_id == room.id
                )
            )
        ).scalars().all()
        collection_ids = [str(c) for c in collection_ids]
    except Exception:
        # We could not even determine WHICH knowledge bases to search.
        logger.warning("kb_search_bindings_failed", exc_info=True)
        return _unavailable(
            "The knowledge base could not be searched: this room's knowledge "
            "base attachments could not be read."
        )

    if not collection_ids:
        # A real, knowable fact: there is nothing attached to search.
        return KnowledgeSearchResponse(
            status=RETRIEVAL_OK,
            notice=(
                "This room has no knowledge bases attached, so there is "
                "nothing to search."
            ),
            results=[],
        )

    try:
        search = await knowledge_service.search_knowledge_detailed(
            settings=get_settings(),
            collection_ids=collection_ids,
            query=body.query,
            k=body.k,
        )
    except Exception:
        # search_knowledge_detailed is already fail-safe; this is belt-and-
        # braces, and an unexpected raise is still "we could not look".
        logger.warning("kb_internal_search_failed", exc_info=True)
        return _unavailable(
            "The knowledge base could not be searched: the retrieval service "
            "returned an unexpected error."
        )

    if search.get("status") == RETRIEVAL_UNAVAILABLE:
        detail = ""
        try:
            health = await knowledge_service.retrieval_health(get_settings())
            detail = str(health.get("detail") or "")
            logger.warning(
                "kb_internal_search_unavailable",
                room_id=str(room.id),
                brigade_agent_id=body.brigade_agent_id,
                qdrant=health.get("qdrant"),
                infinity=health.get("infinity"),
                detail=detail,
            )
        except Exception:
            logger.warning("kb_internal_health_probe_failed", exc_info=True)
        return _unavailable(
            "The knowledge base could not be searched: the retrieval service "
            "is unavailable, so this answer is NOT grounded in this room's "
            "knowledge bases. Tell the user that retrieval is down rather than "
            "answering as though the knowledge base were empty."
            + (" (detail: %s)" % detail if detail else "")
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
            document_id=(
                str(h["document_id"])
                if h.get("document_id") is not None
                else None
            ),
            chunk_idx=(
                h["chunk_idx"] if isinstance(h.get("chunk_idx"), int) else None
            ),
        )
        for h in (search.get("results") or [])
        if (h.get("text") or "").strip()
    ]
    return KnowledgeSearchResponse(
        status=RETRIEVAL_OK,
        notice=(
            None
            if results
            else "The knowledge bases attached to this room were searched and "
            "contained no relevant match."
        ),
        results=results,
    )
