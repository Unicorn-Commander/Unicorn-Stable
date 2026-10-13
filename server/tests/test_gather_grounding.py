"""Regression tests for ``_gather_grounding``'s honesty contract.

Run inside the backend image with this worktree's ``server/`` mounted:

    docker run --rm -v <worktree>/server:/home/stable/server -w /home/stable/server \
      unicorn-stable-backend:main-d3412fe python tests/test_gather_grounding.py

No pytest dependency — the backend image does not ship one.

The contract under test is what the reply is allowed to CLAIM about retrieval:

  ``None``          nothing was searched, so say nothing. The plain room with no
                    knowledge base and no shared document is this case, and it is
                    the most common room in the deployment — a disclaimer here is
                    a confident false statement about a search that never happened.
  ``"none"``        a real surface was searched and genuinely had no match.
  ``"unavailable"`` a real surface could not be searched.
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from typing import Any

sys.path.insert(0, "/home/stable/server")

from app.config import Settings  # noqa: E402
from app.services import agent_chat_responder as acr  # noqa: E402

FAILURES: list[str] = []


def check(name: str, got: Any, want: Any) -> None:
    if got != want:
        FAILURES.append(f"{name}: expected {want!r}, got {got!r}")


class FakeResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def scalars(self) -> "FakeResult":
        return self

    def all(self) -> list[Any]:
        return self._rows

    def first(self) -> Any | None:
        return self._rows[0] if self._rows else None


class FakeDB:
    """Dispatches on the table named in the compiled statement."""

    def __init__(
        self,
        kb_ids: list[str] | None = None,
        message_metadata: list[dict | None] | None = None,
        raise_on_messages: bool = False,
    ) -> None:
        self.kb_ids = kb_ids or []
        self.message_metadata = message_metadata or []
        self.raise_on_messages = raise_on_messages
        self.queried: list[str] = []

    async def execute(
        self, stmt: Any, _params: dict[str, Any] | None = None
    ) -> FakeResult:
        sql = str(stmt)
        if "room_knowledge" in sql:
            self.queried.append("room_knowledge")
            return FakeResult(list(self.kb_ids))
        if "knowledge_collections" in sql:
            self.queried.append("knowledge_collections")
            return FakeResult([(i, f"KB {i}") for i in self.kb_ids])
        if "messages" in sql:
            self.queried.append("messages")
            if self.raise_on_messages:
                raise RuntimeError("database hiccup")
            # The production query returns a row only for attachment content
            # types the indexer can actually search. Preserve that behavior in
            # the fake instead of treating any attachment (for example a PNG)
            # as a document surface.
            searchable = []
            for metadata in self.message_metadata:
                attachments = (metadata or {}).get("attachments") or []
                for attachment in attachments:
                    content_type = str(attachment.get("content_type") or "").lower()
                    if content_type.startswith("text/") or content_type in {
                        "application/pdf",
                        "application/json",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    }:
                        searchable.append((1,))
                        break
            return FakeResult(searchable)
        raise AssertionError(f"unexpected query: {sql}")


class FakeRoom:
    def __init__(self) -> None:
        self.id = uuid.uuid4()


def doc_attachment(content_type: str = "application/pdf") -> dict:
    return {
        "attachments": [
            {
                "filename": "runbook.pdf",
                "content_type": content_type,
                "url": "/api/v1/uploads/" + "a" * 32 + ".pdf",
            }
        ]
    }


class RagStub:
    """Stands in for ``rag_service``; records whether retrieval was attempted."""

    def __init__(self, hits: list[dict] | None = None, explode: bool = False) -> None:
        self.hits = hits or []
        self.explode = explode
        self.called = 0

    async def retrieve(self, **_kw: Any) -> list[dict]:
        self.called += 1
        if self.explode:
            raise RuntimeError("qdrant is down")
        return self.hits

    def format_context(self, hits: list[dict]) -> str:
        return "ctx" if hits else ""


def install_rag(stub: RagStub) -> None:
    import app.services.rag_service as rs

    rs.rag_service = stub


class HealthStub:
    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.called = 0

    async def retrieval_health(self, _settings: Any) -> dict:
        self.called += 1
        return {"available": self.available, "detail": None}

    async def search_knowledge_detailed(self, **_kw: Any) -> dict:
        return {"status": "ok", "results": []}


def install_knowledge(stub: Any) -> None:
    import app.services.knowledge_service as ks

    stub.__dict__.setdefault("_orig", None)
    ks.knowledge_service = stub


def run(coro: Any) -> Any:
    return asyncio.get_event_loop().run_until_complete(coro)


def gather(db: FakeDB, settings: Settings) -> dict:
    return run(
        acr._gather_grounding(
            settings=settings, db=db, room=FakeRoom(), query="what is the runbook?"
        )
    )


def main() -> int:
    # Document RAG is optional and off by default (no internal Qdrant/Infinity
    # address ships in code any more; .env.example documents RAG_ENABLED=false
    # as the self-host default). Assert the default so a silent flip is caught,
    # then switch it on explicitly: every case below is about the honesty of
    # grounding WITH rag on, and must never pass because rag happened to be off.
    defaults = Settings()
    check("rag_enabled default", defaults.rag_enabled, False)
    settings = Settings()
    settings.rag_enabled = True

    # 1. THE PLAIN ROOM: no knowledge base, no shared document, rag on.
    #    Nothing was searched, so nothing may be claimed — and retrieval and
    #    the health probe must not even run.
    rag = RagStub(hits=[{"text": "x", "filename": "f"}])
    install_rag(rag)
    health = HealthStub(available=True)
    install_knowledge(health)
    db = FakeDB(kb_ids=[], message_metadata=[])
    res = gather(db, settings)
    check("plain room grounding", res["grounding"], None)
    check("plain room citations", res["citations"], [])
    check("plain room did not retrieve", rag.called, 0)
    check("plain room did not probe health", health.called, 0)

    # 2. Non-document attachments (images) are not a search surface: RAG skips
    #    them at index time, so claiming to have searched them would be false.
    rag = RagStub()
    install_rag(rag)
    health = HealthStub(available=True)
    install_knowledge(health)
    db = FakeDB(message_metadata=[doc_attachment("image/png")])
    res = gather(db, settings)
    check("image-only room grounding", res["grounding"], None)
    check("image-only room did not retrieve", rag.called, 0)

    # 3. A REAL MISS against a real surface still reports honestly.
    rag = RagStub(hits=[])
    install_rag(rag)
    health = HealthStub(available=True)
    install_knowledge(health)
    db = FakeDB(message_metadata=[doc_attachment()])
    res = gather(db, settings)
    check("real miss grounding", res["grounding"], "none")
    check("real miss did retrieve", rag.called, 1)

    # 4. A real surface plus a retrieval outage still reports unavailable.
    rag = RagStub(explode=True)
    install_rag(rag)
    install_knowledge(HealthStub(available=True))
    db = FakeDB(message_metadata=[doc_attachment()])
    res = gather(db, settings)
    check("outage grounding", res["grounding"], "unavailable")

    # 5. A miss against a real surface while the plane is down is an outage,
    #    not an empty answer.
    rag = RagStub(hits=[])
    install_rag(rag)
    install_knowledge(HealthStub(available=False))
    db = FakeDB(message_metadata=[doc_attachment()])
    res = gather(db, settings)
    check("miss during outage grounding", res["grounding"], "unavailable")

    # 6. Hits produce citations and a knowledge claim.
    rag = RagStub(hits=[{"text": "the runbook says", "filename": "runbook.pdf", "score": 0.9}])
    install_rag(rag)
    install_knowledge(HealthStub(available=True))
    db = FakeDB(message_metadata=[doc_attachment()])
    res = gather(db, settings)
    check("hit grounding", res["grounding"], "knowledge")
    check("hit citations", len(res["citations"]), 1)

    # 7. The surface probe itself failing means we do not know there was a
    #    surface. Retrieval still runs (a db hiccup must not cost the agent
    #    context), but an empty result claims nothing.
    rag = RagStub(hits=[])
    install_rag(rag)
    health = HealthStub(available=True)
    install_knowledge(health)
    db = FakeDB(raise_on_messages=True)
    res = gather(db, settings)
    check("probe-failed grounding", res["grounding"], None)
    check("probe-failed still retrieved", rag.called, 1)
    check("probe-failed did not probe health", health.called, 0)

    # 8. Feature switched off entirely: nothing searched, nothing claimed.
    rag = RagStub(hits=[])
    install_rag(rag)
    install_knowledge(HealthStub(available=True))
    off = Settings()
    off.rag_enabled = False
    db = FakeDB(message_metadata=[doc_attachment()])
    res = gather(db, off)
    check("rag off grounding", res["grounding"], None)
    check("rag off did not retrieve", rag.called, 0)

    if FAILURES:
        print("FAIL")
        for f in FAILURES:
            print("  -", f)
        return 1
    print("PASS — all grounding-honesty cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
