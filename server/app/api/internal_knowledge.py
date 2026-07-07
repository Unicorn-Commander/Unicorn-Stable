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
``knowledge_service.search_knowledge``. FULLY fail-safe: a room with NO bound
collections returns ``{"results": []}`` (NOT an error), and any internal error
also degrades to ``{"results": []}`` so the agent's reply never breaks.

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
from app.services.knowledge_service import knowledge_service

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
    text: str
    filename: str
    score: float
    collection_id: str | None = None


class KnowledgeSearchResponse(BaseModel):
    results: list[KnowledgeSearchHit]


@router.post("/internal/knowledge/search", response_model=KnowledgeSearchResponse)
async def agent_search_knowledge(
    body: KnowledgeSearchRequest,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> KnowledgeSearchResponse:
    """Search every Knowledge Base bound to the agent's room.

    Auth (shared LiveKit secret) + room resolution are reused from
    ``internal_artifacts``. No bound collections -> ``{"results": []}`` (not an
    error). Any internal failure also degrades to an empty result set.
    """
    _check_agent_secret(request)

    try:
        room = await _resolve_room(db, body)
    except Exception:
        # _resolve_room raises 404 when the room is unknown. The contract is
        # fail-safe retrieval, so degrade to empty rather than surface an error
        # into the agent's reply path.
        logger.info("kb_search_room_unresolved", exc_info=True)
        return KnowledgeSearchResponse(results=[])

    try:
        collection_ids = (
            await db.execute(
                select(RoomKnowledge.collection_id).where(
                    RoomKnowledge.room_id == room.id
                )
            )
        ).scalars().all()
        collection_ids = [str(c) for c in collection_ids]
        if not collection_ids:
            return KnowledgeSearchResponse(results=[])

        hits = await knowledge_service.search_knowledge(
            settings=get_settings(),
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
    except Exception:
        logger.warning("kb_internal_search_failed", exc_info=True)
        return KnowledgeSearchResponse(results=[])
