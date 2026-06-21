"""Document-RAG service for Stable rooms ("chat with your documents").

Thin async client over two services reachable from the backend container:

  * Infinity proxy (``settings.infinity_url``): OpenAI-shaped ``/embeddings``
    (BAAI/bge-m3, 1024-dim) and ``/rerank`` (BAAI/bge-reranker-v2-m3).
  * Qdrant (``settings.qdrant_url``): vector store, collection
    ``settings.rag_collection`` (size 1024, Cosine), no auth.

Flow:
  index  — when a user posts a document attachment, extract → chunk → embed →
           upsert points scoped to the room (payload carries room_id, filename,
           chunk text, …).
  retrieve — when the room's agent answers, embed the user's question, vector-
             search filtered by room_id, rerank the candidates, return the top
             excerpts to inject as context.

EVERYTHING here is FAIL-SAFE. Any error (network, extract, embed, qdrant) is
caught and logged; indexing is fire-and-forget and retrieval degrades to "no
context". RAG must never break message send or the chat reply.
"""

from __future__ import annotations

import uuid
from typing import Any
from urllib.parse import urlparse

import httpx
import structlog

from app.config import Settings
from app.services import doc_extract

logger = structlog.get_logger(__name__)

# Keep embedding batches small — the shared Infinity server caps GPU batch at
# 16 and re-chunks larger requests (see reference_uc_infinity_embeddings).
_EMBED_BATCH = 16
_HTTP_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_VECTOR_SIZE = 1024

# Content types we can extract text from in v1. Anything else is skipped.
_DOC_CONTENT_TYPES = (
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/json",
)
_DOC_CONTENT_PREFIXES = ("text/",)


def _is_doc_content_type(content_type: str) -> bool:
    ct = (content_type or "").lower()
    if ct in _DOC_CONTENT_TYPES:
        return True
    return any(ct.startswith(p) for p in _DOC_CONTENT_PREFIXES)


def _stored_name_from_url(url: str) -> str | None:
    """Derive the on-disk stored_name from an attachment url.

    Attachment urls look like ``/api/v1/uploads/<32hex>.<ext>?exp=...&sig=...``
    (or an absolute variant). We take the path basename and strip the query
    string. Returns None if nothing usable can be derived.
    """
    if not url or not isinstance(url, str):
        return None
    try:
        path = urlparse(url).path  # drops query string + fragment
        name = path.rsplit("/", 1)[-1].strip()
        return name or None
    except Exception:
        return None


class RagService:
    """Stateless async helper. One module-level singleton is fine; each call
    opens its own short-lived ``httpx.AsyncClient``."""

    # ---- Infinity: embeddings + rerank -----------------------------------

    async def embed(self, settings: Settings, texts: list[str]) -> list[list[float]]:
        """Embed texts via Infinity ``/embeddings`` (batched ≤16).

        Returns one vector per input, in order. Raises on hard failure so
        callers can decide; ``index_document``/``retrieve`` wrap this in their
        own try/except.
        """
        if not texts:
            return []
        url = settings.infinity_url.rstrip("/") + "/embeddings"
        out: list[list[float]] = []
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
            for i in range(0, len(texts), _EMBED_BATCH):
                batch = texts[i : i + _EMBED_BATCH]
                resp = await http.post(
                    url,
                    json={"model": settings.embedding_model, "input": batch},
                )
                resp.raise_for_status()
                data = resp.json()
                rows = data.get("data") or []
                # OpenAI shape includes an `index`; sort to be safe.
                rows = sorted(rows, key=lambda r: r.get("index", 0))
                for row in rows:
                    emb = row.get("embedding")
                    if isinstance(emb, list):
                        out.append(emb)
        return out

    async def _rerank(
        self, settings: Settings, query: str, documents: list[str]
    ) -> list[dict[str, Any]]:
        """Rerank candidate documents. Returns the raw ``results`` list
        ([{index, relevance_score}, ...]). On any error returns [] so the
        caller falls back to vector-search order."""
        if not documents:
            return []
        url = settings.infinity_url.rstrip("/") + "/rerank"
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
                resp = await http.post(
                    url,
                    json={
                        "model": settings.rerank_model,
                        "query": query,
                        "documents": documents,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                results = data.get("results")
                return results if isinstance(results, list) else []
        except Exception:
            logger.warning("rag_rerank_failed", exc_info=True)
            return []

    # ---- Qdrant ----------------------------------------------------------

    async def ensure_collection(self, settings: Settings) -> None:
        """Idempotently ensure the qdrant collection exists. The collection is
        pre-created in prod; this is a safety net for fresh environments.
        Swallows 'already exists' (409 / 4xx with that meaning) and all errors."""
        url = f"{settings.qdrant_url.rstrip('/')}/collections/{settings.rag_collection}"
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
                # Already present? Nothing to do.
                existing = await http.get(url)
                if existing.status_code == 200:
                    return
                resp = await http.put(
                    url,
                    json={
                        "vectors": {"size": _VECTOR_SIZE, "distance": "Cosine"}
                    },
                )
                if resp.status_code in (200, 201):
                    return
                if resp.status_code == 409:
                    return  # race: created concurrently
                logger.warning(
                    "rag_ensure_collection_unexpected",
                    status=resp.status_code,
                    body=resp.text[:200],
                )
        except Exception:
            logger.warning("rag_ensure_collection_failed", exc_info=True)

    async def _upsert(
        self, settings: Settings, points: list[dict[str, Any]]
    ) -> None:
        url = (
            f"{settings.qdrant_url.rstrip('/')}/collections/"
            f"{settings.rag_collection}/points"
        )
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
            resp = await http.put(url, json={"points": points})
            resp.raise_for_status()

    async def _search(
        self, settings: Settings, vector: list[float], room_id: str, limit: int
    ) -> list[dict[str, Any]]:
        url = (
            f"{settings.qdrant_url.rstrip('/')}/collections/"
            f"{settings.rag_collection}/points/search"
        )
        body = {
            "vector": vector,
            "limit": limit,
            "with_payload": True,
            "filter": {"must": [{"key": "room_id", "match": {"value": room_id}}]},
        }
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
            resp = await http.post(url, json=body)
            resp.raise_for_status()
            data = resp.json()
            return data.get("result") or []

    # ---- High-level: index + retrieve ------------------------------------

    async def index_document(
        self,
        settings: Settings,
        room_id: str,
        message_id: str,
        stored_name: str,
        filename: str,
        content_type: str,
    ) -> int:
        """Extract → chunk → embed → upsert a single document, scoped to a room.

        Returns the number of chunks indexed. Swallows and logs all errors,
        returning 0 on failure (fire-and-forget safe).
        """
        try:
            import os

            path = os.path.join(settings.upload_dir, stored_name)
            if not os.path.isfile(path):
                logger.warning(
                    "rag_index_file_missing", stored_name=stored_name, path=path
                )
                return 0

            text = doc_extract.extract_text(path, content_type, filename)
            if not text or not text.strip():
                logger.info(
                    "rag_index_no_text",
                    stored_name=stored_name,
                    filename=filename,
                    content_type=content_type,
                )
                return 0

            chunks = doc_extract.chunk_text(text)
            if not chunks:
                return 0

            vectors = await self.embed(settings, chunks)
            if len(vectors) != len(chunks):
                # Partial embedding — index only the chunks we have vectors for.
                logger.warning(
                    "rag_index_embed_count_mismatch",
                    chunks=len(chunks),
                    vectors=len(vectors),
                    stored_name=stored_name,
                )
            n = min(len(chunks), len(vectors))
            if n == 0:
                return 0

            points = [
                {
                    "id": str(uuid.uuid4()),
                    "vector": vectors[i],
                    "payload": {
                        "room_id": str(room_id),
                        "message_id": str(message_id),
                        "stored_name": stored_name,
                        "filename": filename,
                        "chunk_idx": i,
                        "text": chunks[i],
                    },
                }
                for i in range(n)
            ]
            await self._upsert(settings, points)
            logger.info(
                "rag_indexed_document",
                room_id=str(room_id),
                filename=filename,
                chunks=n,
            )
            return n
        except Exception:
            logger.warning(
                "rag_index_document_failed",
                stored_name=stored_name,
                filename=filename,
                exc_info=True,
            )
            return 0

    async def retrieve(
        self,
        settings: Settings,
        room_id: str,
        query: str,
        k_search: int = 20,
        k_final: int = 5,
    ) -> list[dict[str, Any]]:
        """Retrieve the most relevant document excerpts for a query in a room.

        embed(query) → qdrant search (filtered by room_id, top k_search) →
        rerank candidates → return top k_final ``{text, filename, score}``.
        Returns [] on any error or when nothing is indexed for the room.
        """
        try:
            q = (query or "").strip()
            if not q:
                return []
            q_vectors = await self.embed(settings, [q])
            if not q_vectors:
                return []
            hits = await self._search(settings, q_vectors[0], str(room_id), k_search)
            if not hits:
                return []

            candidates: list[dict[str, Any]] = []
            for h in hits:
                payload = h.get("payload") or {}
                text = payload.get("text")
                if not isinstance(text, str) or not text.strip():
                    continue
                candidates.append(
                    {
                        "text": text,
                        "filename": payload.get("filename") or "document",
                        "score": float(h.get("score") or 0.0),
                    }
                )
            if not candidates:
                return []

            # Rerank for precision. Fall back to vector order if rerank fails.
            reranked = await self._rerank(
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

            return candidates[:k_final]
        except Exception:
            logger.warning(
                "rag_retrieve_failed", room_id=str(room_id), exc_info=True
            )
            return []

    def format_context(self, hits: list[dict[str, Any]]) -> str:
        """Render retrieved excerpts into a compact context block citing the
        source filename per excerpt. Empty string when there are no hits."""
        if not hits:
            return ""
        lines = ["Relevant excerpts from documents shared in this room:", ""]
        for i, h in enumerate(hits, 1):
            filename = h.get("filename") or "document"
            text = (h.get("text") or "").strip()
            if not text:
                continue
            lines.append(f"[{i}] From \"{filename}\":")
            lines.append(text)
            lines.append("")
        block = "\n".join(lines).strip()
        return block

    # ---- Fire-and-forget message helper ----------------------------------

    async def index_message_attachments(
        self,
        settings: Settings,
        room_id: Any,
        message_id: Any,
        attachments: list[dict[str, Any]] | None,
    ) -> int:
        """Index every document attachment on a message. Fire-and-forget safe:
        filters to document content-types, derives stored_name from each
        attachment url, indexes each, and never raises. Returns total chunks
        indexed across all attachments."""
        try:
            if not attachments:
                return 0
            await self.ensure_collection(settings)
            total = 0
            for att in attachments:
                if not isinstance(att, dict):
                    continue
                content_type = str(att.get("content_type") or "")
                if not _is_doc_content_type(content_type):
                    # Skip images / unknown types — extraction would no-op.
                    continue
                stored_name = _stored_name_from_url(str(att.get("url") or ""))
                if not stored_name:
                    logger.warning(
                        "rag_attachment_no_stored_name", url=att.get("url")
                    )
                    continue
                filename = str(att.get("filename") or stored_name)
                total += await self.index_document(
                    settings=settings,
                    room_id=room_id,
                    message_id=message_id,
                    stored_name=stored_name,
                    filename=filename,
                    content_type=content_type,
                )
            return total
        except Exception:
            logger.warning(
                "rag_index_message_attachments_failed",
                room_id=str(room_id),
                exc_info=True,
            )
            return 0


# Module-level singleton — the brief's integration points import this.
rag_service = RagService()
