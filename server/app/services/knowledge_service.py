"""Knowledge-Base service — persistent document collections over the RAG plane.

This is the doc-RAG pipeline (``app.services.rag_service``) pointed at a
``collection_id`` payload instead of a ``messages``' ``room_id`` payload. It
REUSES ``rag_service`` for every heavy/IO step and adds ZERO duplicate
embed/qdrant/rerank logic of its own:

  * extract + chunk      -> ``doc_extract`` (via ``rag_service``'s deps; we call
                            the same module functions rag_service.index_document
                            uses).
  * embed                -> ``rag_service.embed`` (Infinity, batched <=16).
  * qdrant collection    -> the SAME ``settings.rag_collection``
                            (``stable_documents``); ``rag_service.ensure_collection``
                            / ``rag_service._upsert`` / the qdrant search URL.
  * rerank               -> ``rag_service._rerank`` (bge-reranker-v2-m3).

The ONLY thing that differs from the room path is the qdrant payload key and
the search filter: KB points carry ``collection_id`` (+ ``document_id`` +
``filename`` + ``text``) and KB search filters on ``collection_id`` IN
[...collection_ids] via a qdrant ``should`` (match-any) clause, whereas
rag_service points/filters on ``room_id``.

EVERYTHING here is fail-safe in the rag_service style: indexing swallows + logs
and marks the document ``failed`` (never raises into the fire-and-forget task);
search degrades to ``[]`` on any error. KB retrieval must never break a reply.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import httpx
import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models.knowledge import KnowledgeCollection, KnowledgeDocument
from app.services import doc_extract
from app.services.rag_service import _HTTP_TIMEOUT, _sparse_vector, rag_service

logger = structlog.get_logger(__name__)

# Retrieval-plane status. These two are NOT the same statement and must never
# be rendered to a human as if they were:
#   RETRIEVAL_OK          — we asked the index and it answered (possibly with
#                           zero hits: "your knowledge bases have no match").
#   RETRIEVAL_UNAVAILABLE — we could not ask the index at all (qdrant/Infinity
#                           unreachable), so we know NOTHING about whether a
#                           match exists. Callers must surface this, not
#                           silently degrade it into an empty result set.
RETRIEVAL_OK = "ok"
RETRIEVAL_UNAVAILABLE = "unavailable"

# Health probes are user-facing and must not hang a request.
_PROBE_TIMEOUT = httpx.Timeout(5.0, connect=3.0)


class KnowledgeService:
    """Stateless async helper (module-level singleton like ``rag_service``)."""

    # ---- Collections -----------------------------------------------------

    async def create_collection(
        self,
        db: AsyncSession,
        name: str,
        description: str | None,
        created_by: Any,
        org_id: Any | None = None,
    ) -> KnowledgeCollection:
        """Create + persist a new Knowledge Base. Caller commits."""
        collection = KnowledgeCollection(
            name=name,
            description=description,
            created_by=created_by,
            org_id=org_id,
        )
        db.add(collection)
        await db.flush()
        return collection

    # ---- Indexing (REUSES rag_service extract/chunk/embed/upsert) --------

    async def index_kb_document(
        self,
        settings: Settings,
        db: AsyncSession,
        collection_id: Any,
        document_id: Any,
        stored_name: str,
        filename: str,
        content_type: str,
    ) -> int:
        """Extract -> chunk -> embed -> upsert one document into a collection.

        Parallel to ``rag_service.index_document``'s room path: identical
        extract (``doc_extract``) + embed (``rag_service.embed``) + qdrant
        upsert (``rag_service._upsert`` into ``settings.rag_collection``), the
        ONLY change being the qdrant payload — ``collection_id`` + ``document_id``
        instead of ``room_id`` + ``message_id``.

        Updates the ``KnowledgeDocument`` row's ``status`` (-> ready/failed) and
        ``chunk_count``, commits, and returns the chunk count. Fire-and-forget
        safe: swallows + logs every error and marks the doc ``failed``.
        """
        n = 0
        try:
            # Safety net: same qdrant collection rag_service uses.
            await rag_service.ensure_collection(settings)

            path = os.path.join(settings.upload_dir, stored_name)
            if not os.path.isfile(path):
                logger.warning(
                    "kb_index_file_missing", stored_name=stored_name, path=path
                )
                return await self._mark(db, document_id, "failed", 0)

            text = doc_extract.extract_text(path, content_type, filename)
            if not text or not text.strip():
                logger.info(
                    "kb_index_no_text",
                    stored_name=stored_name,
                    filename=filename,
                    content_type=content_type,
                )
                # Nothing extractable (e.g. scanned image) — not an error, but
                # there is no searchable content, so it's not "ready".
                return await self._mark(db, document_id, "failed", 0)

            chunks = doc_extract.chunk_text(text)
            if not chunks:
                return await self._mark(db, document_id, "failed", 0)

            # Contextual retrieval: ground each chunk in its document, then
            # REUSE rag_service's Infinity embedder (batched <=16).
            summary = await rag_service._doc_summary(settings, text)
            embed_texts = rag_service._contextualize(chunks, filename, summary)
            vectors = await rag_service.embed(settings, embed_texts)
            if len(vectors) != len(chunks):
                logger.warning(
                    "kb_index_embed_count_mismatch",
                    chunks=len(chunks),
                    vectors=len(vectors),
                    stored_name=stored_name,
                )
            n = min(len(chunks), len(vectors))
            if n == 0:
                return await self._mark(db, document_id, "failed", 0)

            points = []
            for i in range(n):
                vec: dict[str, Any] = {"dense": vectors[i]}
                sp = _sparse_vector(chunks[i])
                if sp:
                    vec["sparse"] = sp
                points.append(
                    {
                        "id": str(uuid.uuid4()),
                        "vector": vec,
                        "payload": {
                            "collection_id": str(collection_id),
                            "document_id": str(document_id),
                            "stored_name": stored_name,
                            "filename": filename,
                            "chunk_idx": i,
                            "text": chunks[i],
                        },
                    }
                )
            # REUSE rag_service's qdrant upsert (same stable_documents collection).
            await rag_service._upsert(settings, points)
            logger.info(
                "kb_indexed_document",
                collection_id=str(collection_id),
                filename=filename,
                chunks=n,
            )
            return await self._mark(db, document_id, "ready", n)
        except Exception:
            logger.warning(
                "kb_index_document_failed",
                stored_name=stored_name,
                filename=filename,
                exc_info=True,
            )
            try:
                return await self._mark(db, document_id, "failed", n)
            except Exception:
                logger.warning("kb_index_mark_failed", exc_info=True)
                return 0

    async def _mark(
        self, db: AsyncSession, document_id: Any, status: str, chunk_count: int
    ) -> int:
        """Update a KnowledgeDocument's status + chunk_count and commit.

        Returns ``chunk_count`` for convenience. Best-effort: any failure is
        logged by the caller (this runs inside the fire-and-forget task)."""
        doc = await db.get(KnowledgeDocument, document_id)
        if doc is not None:
            doc.status = status
            doc.chunk_count = chunk_count
            await db.commit()
        return chunk_count

    # ---- Retrieval (REUSES rag_service embed + rerank; qdrant should-filter) ----

    async def retrieval_health(self, settings: Settings) -> dict[str, Any]:
        """Probe the two services retrieval depends on.

        Returns ``{available, qdrant, infinity, detail}``. Never raises.

        This exists so a HUMAN can be told the difference between "your
        knowledge bases returned no match" and "we could not reach the index,
        so nothing here is grounded". Rendering the second as the first is a
        lie, and this UI does not tell it.
        """
        qdrant_ok = False
        infinity_ok = False
        problems: list[str] = []

        try:
            url = (
                f"{settings.qdrant_url.rstrip('/')}/collections/"
                f"{settings.rag_collection}"
            )
            async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as http:
                resp = await http.get(url)
            qdrant_ok = resp.status_code == 200
            if not qdrant_ok:
                problems.append(f"vector index returned HTTP {resp.status_code}")
        except Exception as exc:
            problems.append(
                f"vector index unreachable at {settings.qdrant_url} "
                f"({type(exc).__name__})"
            )

        try:
            url = settings.infinity_url.rstrip("/") + "/models"
            async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as http:
                resp = await http.get(url)
            infinity_ok = resp.status_code == 200
            if not infinity_ok:
                problems.append(f"embedding service returned HTTP {resp.status_code}")
        except Exception as exc:
            problems.append(
                f"embedding service unreachable at {settings.infinity_url} "
                f"({type(exc).__name__})"
            )

        return {
            "available": qdrant_ok and infinity_ok,
            "qdrant": "ok" if qdrant_ok else "unreachable",
            "infinity": "ok" if infinity_ok else "unreachable",
            "detail": "; ".join(problems),
        }

    async def search_knowledge(
        self,
        settings: Settings,
        collection_ids: list[str],
        query: str,
        k: int = 5,
    ) -> list[dict[str, Any]]:
        """Excerpts only — back-compat wrapper over
        :meth:`search_knowledge_detailed`.

        Returns ``[]`` both when nothing matched AND when retrieval is down;
        that ambiguity is exactly why the detailed variant exists. Any caller
        that shows results to a human should use the detailed one so it can say
        which of the two happened. Kept for the agent-side callers whose
        contract is "context or no context".
        """
        detailed = await self.search_knowledge_detailed(
            settings=settings, collection_ids=collection_ids, query=query, k=k
        )
        return detailed["results"]

    async def search_knowledge_detailed(
        self,
        settings: Settings,
        collection_ids: list[str],
        query: str,
        k: int = 5,
    ) -> dict[str, Any]:
        """Retrieve the most relevant excerpts across one or more collections,
        reporting whether the retrieval plane could be reached at all.

        ``rag_service.embed(query)`` -> qdrant search filtered on
        ``collection_id`` IN ``collection_ids`` (a ``should`` / match-any
        clause) -> ``rag_service._rerank`` -> top ``k`` excerpts.

        Returns ``{"status": RETRIEVAL_OK | RETRIEVAL_UNAVAILABLE,
        "results": [{text, filename, score, collection_id}]}``.

        ``RETRIEVAL_OK`` with an empty list is a real answer ("no match").
        ``RETRIEVAL_UNAVAILABLE`` means the embedder or the vector index could
        not be reached, so the empty list carries NO information — callers must
        say so rather than presenting it as "nothing found". Reranking failure
        is not unavailability: it degrades to vector order and stays ``ok``.
        """
        ids = [str(c) for c in (collection_ids or []) if c]
        q = (query or "").strip()
        # Nothing asked / nothing attached is a truthful empty answer, not an
        # outage — no need to touch the network to know that.
        if not ids or not q:
            return {"status": RETRIEVAL_OK, "results": []}

        # REUSE rag_service's embedder. A failure here is the embedding service
        # being down, not an absence of matches.
        try:
            q_vectors = await rag_service.embed(settings, [q])
        except Exception:
            logger.warning("kb_search_embed_failed", exc_info=True)
            return {"status": RETRIEVAL_UNAVAILABLE, "results": []}
        if not q_vectors:
            logger.warning("kb_search_embed_empty")
            return {"status": RETRIEVAL_UNAVAILABLE, "results": []}

        # Over-fetch then rerank for precision (same shape as rag_service:
        # k_search ~ 4x final, capped). Filter is the only KB-specific bit.
        k_search = max(20, k * 4)
        try:
            hits = await self._search_collections(
                settings, q_vectors[0], _sparse_vector(q), ids, k_search
            )
        except Exception:
            logger.warning("kb_search_query_failed", exc_info=True)
            return {"status": RETRIEVAL_UNAVAILABLE, "results": []}

        if not hits:
            return {"status": RETRIEVAL_OK, "results": []}

        try:
            candidates: list[dict[str, Any]] = []
            for h in hits:
                payload = h.get("payload") or {}
                text = payload.get("text")
                if not isinstance(text, str) or not text.strip():
                    continue
                chunk_idx = payload.get("chunk_idx")
                candidates.append(
                    {
                        "text": text,
                        "filename": payload.get("filename") or "document",
                        "collection_id": payload.get("collection_id"),
                        "document_id": payload.get("document_id"),
                        "chunk_idx": chunk_idx if isinstance(chunk_idx, int) else None,
                        "score": float(h.get("score") or 0.0),
                    }
                )
            if not candidates:
                return {"status": RETRIEVAL_OK, "results": []}

            # REUSE rag_service's reranker; fall back to vector order on failure.
            # Rerank is a precision nicety — losing it is NOT unavailability.
            reranked = await rag_service._rerank(
                settings, q, [c["text"] for c in candidates]
            )
            if reranked:
                ordered: list[dict[str, Any]] = []
                for r in sorted(
                    reranked,
                    key=lambda x: x.get("relevance_score", 0.0),
                    reverse=True,
                ):
                    idx = r.get("index")
                    if isinstance(idx, int) and 0 <= idx < len(candidates):
                        c = dict(candidates[idx])
                        c["score"] = float(r.get("relevance_score") or 0.0)
                        ordered.append(c)
                candidates = ordered or candidates

            return {"status": RETRIEVAL_OK, "results": candidates[:k]}
        except Exception:
            # Shaping the already-fetched hits blew up — we DID reach the index,
            # but we cannot vouch for the result, so do not claim "no match".
            logger.warning("kb_search_failed", exc_info=True)
            return {"status": RETRIEVAL_UNAVAILABLE, "results": []}

    # ---- Human-viewable extracted content (qdrant scroll by document) ----

    async def get_document_chunks(
        self,
        settings: Settings,
        document_id: Any,
        limit: int = 2000,
    ) -> list[dict[str, Any]]:
        """Chunks only — back-compat wrapper over
        :meth:`get_document_chunks_detailed`. ``[]`` conflates "nothing indexed"
        with "index unreachable"; prefer the detailed variant for anything a
        human reads."""
        detailed = await self.get_document_chunks_detailed(
            settings=settings, document_id=document_id, limit=limit
        )
        return detailed["chunks"]

    async def get_document_chunks_detailed(
        self,
        settings: Settings,
        document_id: Any,
        limit: int = 2000,
    ) -> dict[str, Any]:
        """Fetch every indexed chunk for ONE document, ordered by ``chunk_idx``.

        Reads the SAME ``settings.rag_collection`` (``stable_documents``) the
        indexer upserts into, via qdrant's scroll API filtered on the
        ``document_id`` payload (unique per document — each chunk carries it).
        Returns ``[{chunk_idx, text}]`` sorted by chunk order so a human can
        read the document's extracted text exactly as it was chunked/embedded.

        Returns ``{"status": RETRIEVAL_OK | RETRIEVAL_UNAVAILABLE, "chunks":
        [{chunk_idx, text}]}``. Fail-safe in the rag_service style — viewing
        content never raises — but an unreachable index is reported as such
        instead of masquerading as an empty document.
        """
        try:
            url = (
                f"{settings.qdrant_url.rstrip('/')}/collections/"
                f"{settings.rag_collection}/points/scroll"
            )
            body = {
                "filter": {
                    "must": [
                        {
                            "key": "document_id",
                            "match": {"value": str(document_id)},
                        }
                    ]
                },
                "limit": limit,
                "with_payload": True,
                "with_vector": False,
            }
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
                resp = await http.post(url, json=body)
                resp.raise_for_status()
                points = (resp.json().get("result") or {}).get("points") or []

            chunks: list[dict[str, Any]] = []
            for p in points:
                payload = p.get("payload") or {}
                text = payload.get("text")
                if not isinstance(text, str) or not text.strip():
                    continue
                idx = payload.get("chunk_idx")
                chunks.append(
                    {
                        "chunk_idx": idx if isinstance(idx, int) else 0,
                        "text": text,
                    }
                )
            chunks.sort(key=lambda c: c["chunk_idx"])
            return {"status": RETRIEVAL_OK, "chunks": chunks}
        except Exception:
            logger.warning("kb_get_document_chunks_failed", exc_info=True)
            return {"status": RETRIEVAL_UNAVAILABLE, "chunks": []}

    async def _search_collections(
        self,
        settings: Settings,
        dense: list[float],
        sparse: dict | None,
        collection_ids: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        """Hybrid (dense + sparse, RRF) qdrant search filtered to
        ``collection_id`` IN collection_ids.

        Reuses ``rag_service._hybrid_query`` (same ``stable_documents``
        collection); the only KB-specific bit is the filter — a ``should``
        (match-any) over the collection ids instead of a single ``room_id``."""
        qfilter = {
            "should": [
                {"key": "collection_id", "match": {"value": cid}}
                for cid in collection_ids
            ]
        }
        return await rag_service._hybrid_query(settings, dense, sparse, qfilter, limit)


# Module-level singleton — routes import this.
knowledge_service = KnowledgeService()
