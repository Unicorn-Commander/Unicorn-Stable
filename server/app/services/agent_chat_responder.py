"""Text-only agent reply path.

Routes user messages in agent-attached rooms through Brigade's chat
endpoint and posts the reply back as a Stable message — no LiveKit
voice pipeline required. Lets agents respond in text DMs even when
STT/TTS plugins are unavailable or unconfigured.

Triggered from the message API after a user message is persisted.
The voice-path agent worker is told to ignore data-channel chat
when this responder owns text replies (see agent_runtime/base.py),
so users get exactly one reply, not two.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.models.message import ContentType, Message
from app.models.participant import (
    Participant,
    ParticipantStatus,
    ParticipantType,
)
from app.models.room import MemberRole, Room, RoomMember
from app.services import agent_status
from app.services.livekit_service import LiveKitService
from app.services.message_service import MessageService

logger = structlog.get_logger(__name__)


_HISTORY_LIMIT = 10
_BRIGADE_TIMEOUT = httpx.Timeout(180.0, connect=10.0)


_pub_redis = None


def _get_pub_redis():
    """Lazily-created Redis client for cross-worker ws fan-out via pub/sub.

    stable-backend runs ``uvicorn --workers 4``; the ws ConnectionManager is a
    per-process singleton, so a client's socket lives on ONE worker while this
    background responder runs on another. Publishing to Redis ``room:{id}`` —
    which the ws handler subscribes to on every worker — is the only delivery
    that reaches the browser regardless of which worker holds the socket."""
    global _pub_redis
    if _pub_redis is None:
        from redis.asyncio import Redis

        from app.config import get_settings

        _pub_redis = Redis.from_url(
            get_settings().redis_url, decode_responses=False
        )
    return _pub_redis


async def _ws_deliver_to_room(
    *,
    db: Any,
    room_id: uuid.UUID,
    envelope: dict[str, Any],
) -> None:
    """Best-effort deliver a ``{type, payload}`` envelope to a room's members
    over the web-client WebSocket plane.

    Publishes to Redis ``room:{id}`` (cross-worker) — see :func:`_get_pub_redis`.
    ``db`` is retained for signature stability but no longer used. Every delivery
    is wrapped: a fanout failure must never break the agent reply.
    """
    try:
        await _get_pub_redis().publish(f"room:{room_id}", json.dumps(envelope))
    except Exception:
        logger.debug("agent_chat_ws_deliver_failed", exc_info=True)


# A citation rides in the message row's JSON metadata and is re-sent on every
# history fetch, so excerpts are capped rather than stored whole. These bounds
# keep a cited answer readable without turning the message table into a second
# copy of the corpus.
_MAX_CITATIONS = 8
_MAX_CITATION_CHARS = 600


def _citation_excerpt(text: str) -> str:
    """Trim one retrieved chunk down to a quotable excerpt."""
    t = (text or "").strip()
    if len(t) <= _MAX_CITATION_CHARS:
        return t
    return t[:_MAX_CITATION_CHARS].rstrip() + "…"


def _format_citation_context(header: str, hits: list[dict[str, Any]]) -> str:
    """Render retrieved excerpts into a numbered context block for the model.

    Mirrors ``rag_service.format_context`` so both retrieval surfaces read the
    same way to the agent; only the header differs.
    """
    lines = [header, ""]
    n = 0
    for h in hits:
        text = (h.get("text") or "").strip()
        if not text:
            continue
        n += 1
        lines.append('[%d] From "%s":' % (n, h.get("filename") or "document"))
        lines.append(text)
        lines.append("")
    return "\n".join(lines).strip() if n else ""


# How many recent attachment-carrying messages to inspect when deciding whether
# a room has any shared document at all. Bounded so the check costs the same in
# a room with ten messages and a room with a hundred thousand.
_DOC_SCAN_LIMIT = 200


async def _room_has_shared_documents(db: Any, room: Room) -> bool | None:
    """Does this room contain a document that room-scoped RAG would have indexed?

    Answers the only question that licenses a "we searched and found nothing"
    claim about room-shared documents: was there anything to search? Room RAG is
    fed exclusively by document attachments posted to the room
    (``rag_service.index_message_attachments``, scheduled from ``messages.py``),
    so the presence of such an attachment is the presence of a search surface.

    Attachment content-types are judged with ``rag_service._is_doc_content_type``
    — the same predicate the indexer uses — so this cannot drift into claiming a
    surface exists for files RAG silently skips (images, unknown types).

    Returns True / False, or ``None`` when the question could not be answered.
    ``None`` is deliberately distinct from ``False``: not knowing whether a
    surface exists is not the same as knowing it does not, and neither one
    entitles us to describe a search we cannot vouch for.
    """
    try:
        from app.models.message import Message
        from app.services.rag_service import _is_doc_content_type

        rows = (
            await db.execute(
                select(Message.metadata_)
                .where(Message.room_id == room.id)
                .where(Message.metadata_.has_key("attachments"))  # noqa: W601
                .order_by(Message.created_at.desc())
                .limit(_DOC_SCAN_LIMIT)
            )
        ).scalars().all()
    except Exception:
        logger.warning("room_shared_documents_probe_failed", exc_info=True)
        return None

    for meta in rows:
        attachments = (meta or {}).get("attachments")
        if not isinstance(attachments, list):
            continue
        for att in attachments:
            if not isinstance(att, dict):
                continue
            if _is_doc_content_type(str(att.get("content_type") or "")):
                return True
    return False


async def _gather_grounding(
    settings: Settings,
    db: Any,
    room: Room,
    query: str,
) -> dict[str, Any]:
    """Retrieve the material an answer will be grounded in, and report honestly
    what retrieval actually did.

    Two surfaces are searched — the Knowledge Bases attached to the room
    (``knowledge_service``, which yields click-through locators) and the
    documents shared directly in the room (``rag_service``, filename-only) —
    and BOTH the model-facing context and the human-facing citations are built
    from the same hits, so what the agent read is what the reader is shown.

    Returns ``{citations, grounding, context_blocks}`` where ``grounding`` is:

      ``"knowledge"``   — excerpts were retrieved; they are in ``citations``.
      ``"none"``        — we looked and there was genuinely no match.
      ``"unavailable"`` — we could NOT look, so the answer is ungrounded and
                          the UI must say so.
      ``None``          — the room has no knowledge surface at all; assert
                          nothing rather than implying an absence of sources.
                          This is the ORDINARY room and the common case, not an
                          edge case: a disclaimer here would describe a search
                          that never happened, and a reader who trusts it would
                          conclude their knowledge base is empty or broken when
                          neither is true.

    The distinction between ``"none"`` and ``"unavailable"`` is the whole
    point: an outage that renders as "no match" lets an agent answer from
    nothing while looking exactly like an agent answering from knowledge.
    """
    citations: list[dict[str, Any]] = []
    context_blocks: list[str] = []
    attempted = False
    broken = False

    # -- Knowledge Bases attached to this room (clickable sources) ----------
    try:
        from app.models.knowledge import KnowledgeCollection, RoomKnowledge
        from app.services.knowledge_service import (
            RETRIEVAL_UNAVAILABLE,
            knowledge_service,
        )

        kb_ids = [
            str(c)
            for c in (
                await db.execute(
                    select(RoomKnowledge.collection_id).where(
                        RoomKnowledge.room_id == room.id
                    )
                )
            ).scalars().all()
        ]
        if kb_ids:
            attempted = True
            kb_search = await knowledge_service.search_knowledge_detailed(
                settings=settings, collection_ids=kb_ids, query=query, k=5
            )
            if kb_search.get("status") == RETRIEVAL_UNAVAILABLE:
                broken = True
                logger.warning(
                    "agent_chat_kb_retrieval_unavailable",
                    room_id=str(room.id),
                    collections=len(kb_ids),
                )
            else:
                kb_hits = kb_search.get("results") or []
                # Resolve display names so a citation reads as the Knowledge
                # Base a human recognises, not a bare uuid.
                names: dict[str, str] = {}
                try:
                    rows = (
                        await db.execute(
                            select(
                                KnowledgeCollection.id, KnowledgeCollection.name
                            ).where(KnowledgeCollection.id.in_(kb_ids))
                        )
                    ).all()
                    names = {str(r[0]): r[1] for r in rows}
                except Exception:
                    logger.warning("kb_citation_names_failed", exc_info=True)

                for h in kb_hits:
                    text = (h.get("text") or "").strip()
                    if not text:
                        continue
                    cid = h.get("collection_id")
                    citations.append(
                        {
                            "filename": h.get("filename") or "document",
                            "text": _citation_excerpt(text),
                            "score": float(h.get("score") or 0.0),
                            "collection_id": str(cid) if cid else None,
                            "collection_name": names.get(str(cid)) if cid else None,
                            "document_id": (
                                str(h["document_id"])
                                if h.get("document_id")
                                else None
                            ),
                            "chunk_idx": (
                                h["chunk_idx"]
                                if isinstance(h.get("chunk_idx"), int)
                                else None
                            ),
                        }
                    )
                block = _format_citation_context(
                    "Relevant excerpts from this room's knowledge bases:", kb_hits
                )
                if block:
                    context_blocks.append(block)
    except Exception:
        # We do not know whether a match existed, so this is "could not look",
        # not "nothing found".
        broken = True
        logger.warning("kb_context_inject_failed", exc_info=True)

    # -- Documents shared directly in this room ------------------------------
    # These carry no knowledge-base locator, so they cite by filename and
    # excerpt without a click-through target — which the UI renders as plain
    # (unlinked) sources rather than pretending they are openable.
    # ``rag_enabled`` only says the feature is switched on, and it defaults to
    # True — it is NOT evidence that this room has anything to search. Treating
    # it as an attempt stamped "we looked and found nothing" onto ordinary
    # conversation in every room without documents, which is the most common
    # room in this deployment. Only a room that actually holds a shared
    # document is a surface we may claim to have searched.
    rag_enabled = bool(getattr(settings, "rag_enabled", False))
    has_shared_docs = (
        await _room_has_shared_documents(db, room) if rag_enabled else False
    )
    # ``None`` (could not tell) still retrieves — a database hiccup should not
    # silently cost the agent context it could have used — but it never counts
    # as a searched surface, so nothing is claimed on its behalf either way.
    if rag_enabled and has_shared_docs is not False:
        try:
            from app.services.rag_service import rag_service

            attempted = attempted or bool(has_shared_docs)
            hits = await rag_service.retrieve(
                settings=settings, room_id=str(room.id), query=query
            )
            if hits:
                block = rag_service.format_context(hits)
                if block:
                    context_blocks.append(block)
                    logger.info(
                        "rag_context_injected",
                        room_id=str(room.id),
                        hits=len(hits),
                    )
                for h in hits:
                    text = (h.get("text") or "").strip()
                    if not text:
                        continue
                    citations.append(
                        {
                            "filename": h.get("filename") or "document",
                            "text": _citation_excerpt(text),
                            "score": float(h.get("score") or 0.0),
                        }
                    )
        except Exception:
            # Only a surface we established exists can be reported as one we
            # failed to search; otherwise there is nothing to be unavailable.
            broken = broken or bool(has_shared_docs)
            logger.warning("rag_context_inject_failed", exc_info=True)

    # -- Decide what we can honestly claim -----------------------------------
    grounding: str | None
    if citations:
        grounding = "knowledge"
        # Bound the metadata persisted onto every message.
        citations = citations[:_MAX_CITATIONS]
    elif broken:
        grounding = "unavailable"
    elif attempted:
        # We came back empty. ``rag_service.retrieve`` cannot tell a miss from
        # an outage (it returns [] for both), so before claiming "we looked and
        # there was nothing" — a statement a reader will trust — confirm the
        # retrieval plane was actually reachable. This probe runs only on the
        # empty path, so a normal answered turn never pays for it.
        try:
            from app.services.knowledge_service import knowledge_service

            health = await knowledge_service.retrieval_health(settings)
            grounding = "none" if health.get("available") else "unavailable"
            if not health.get("available"):
                logger.warning(
                    "agent_chat_retrieval_unavailable",
                    room_id=str(room.id),
                    detail=health.get("detail"),
                )
        except Exception:
            # Cannot even confirm the plane is up: do not claim "no match".
            logger.warning("retrieval_health_probe_failed", exc_info=True)
            grounding = "unavailable"
    else:
        # No knowledge surface in this room at all — assert nothing.
        grounding = None

    return {
        "citations": citations,
        "grounding": grounding,
        "context_blocks": context_blocks,
    }


def _stop_key(message_id: uuid.UUID | str) -> str:
    return f"stable:agentstop:{message_id}"


async def request_stop(message_id: uuid.UUID | str) -> None:
    """Signal an in-flight agent reply (the placeholder message) to stop.

    Cross-worker safe: the responder task runs on whichever uvicorn worker
    scheduled it, while a ``/stop`` request can land on any of the 4 — so we
    set a short-TTL Redis flag that the streaming loop polls between chunks,
    the same Redis path used for ws fan-out. Best-effort; a failure just means
    the reply finishes normally."""
    try:
        await _get_pub_redis().set(_stop_key(message_id), b"1", ex=120)
    except Exception:
        logger.debug("agent_chat_request_stop_failed", exc_info=True)


async def _is_stop_requested(message_id: uuid.UUID | str) -> bool:
    try:
        return bool(await _get_pub_redis().get(_stop_key(message_id)))
    except Exception:
        return False


async def _clear_stop(message_id: uuid.UUID | str) -> None:
    try:
        await _get_pub_redis().delete(_stop_key(message_id))
    except Exception:
        logger.debug("agent_chat_clear_stop_failed", exc_info=True)


def schedule_response(
    *,
    room_id: uuid.UUID,
    message_id: uuid.UUID,
    sender_id: uuid.UUID | None,
    settings: Settings,
    session_factory: async_sessionmaker,
    livekit: LiveKitService,
    model: str | None = None,
    is_regenerate: bool = False,
    pinned_agent_id: str | None = None,
) -> None:
    """Fire-and-forget background task to generate an agent reply.

    Returns immediately. Errors are logged, not raised. ``model`` optionally
    overrides the resident agent's underlying LLM for this reply (the
    OpenWebUI-style mid-conversation model switcher).

    ``is_regenerate`` marks an explicit user-driven regeneration: it bypasses
    the channel @-mention gate (the user clicked Regenerate on a known reply,
    so intent is unambiguous) and, with ``pinned_agent_id``, re-fires the SAME
    agent that authored the original reply rather than re-deriving one from the
    trigger's mentions (which could pick a different agent, or none).
    """
    if not settings.stable_text_agent_path_enabled:
        return
    if not settings.brigade_api_key or not settings.brigade_base_url:
        return

    asyncio.create_task(
        _safe_respond(
            room_id=room_id,
            message_id=message_id,
            sender_id=sender_id,
            settings=settings,
            session_factory=session_factory,
            livekit=livekit,
            model=model,
            is_regenerate=is_regenerate,
            pinned_agent_id=pinned_agent_id,
        )
    )


async def _safe_respond(**kwargs: Any) -> None:
    try:
        await _respond(**kwargs)
    except Exception:
        logger.exception(
            "agent_chat_responder_failed",
            room_id=str(kwargs.get("room_id")),
            message_id=str(kwargs.get("message_id")),
        )


async def _respond(
    *,
    room_id: uuid.UUID,
    message_id: uuid.UUID,
    sender_id: uuid.UUID | None,
    settings: Settings,
    session_factory: async_sessionmaker,
    livekit: LiveKitService,
    model: str | None = None,
    is_regenerate: bool = False,
    pinned_agent_id: str | None = None,
) -> None:
    async with session_factory() as db:
        msg = (
            await db.execute(select(Message).where(Message.id == message_id))
        ).scalar_one_or_none()
        if msg is None or msg.is_deleted:
            return

        # Skip messages already produced by this responder (or any agent path).
        if msg.metadata_ and isinstance(msg.metadata_, dict):
            if msg.metadata_.get("source") == "agent_chat_responder":
                return
            if msg.metadata_.get("agent_id"):
                return

        # Don't chain-react when an agent posted the trigger.
        if sender_id is not None:
            sender = (
                await db.execute(
                    select(Participant).where(Participant.id == sender_id)
                )
            ).scalar_one_or_none()
            if sender and sender.participant_type == ParticipantType.AGENT:
                return

        room = (
            await db.execute(select(Room).where(Room.id == room_id))
        ).scalar_one_or_none()
        if room is None or room.is_archived:
            return

        room_type = room.room_type.value if room.room_type else "channel"

        # On a regenerate we re-fire the SAME agent that authored the original
        # reply (its id is pinned), not whichever agent the trigger's mentions
        # would route to — otherwise a multi-agent channel could answer with a
        # different agent, or none. Fall back to normal resolution only if that
        # participant has since vanished.
        brigade_agent_id: str | None = None
        agent_participant: Participant | None = None
        if pinned_agent_id:
            agent_participant = (
                await db.execute(
                    select(Participant).where(
                        Participant.keycloak_sub == f"brigade:{pinned_agent_id}"
                    )
                )
            ).scalar_one_or_none()
            if agent_participant is not None:
                brigade_agent_id = pinned_agent_id
        if brigade_agent_id is None or agent_participant is None:
            brigade_agent_id, agent_participant = await _resolve_agent(
                db=db, room=room, content=msg.content or "", room_type=room_type
            )
        if not brigade_agent_id or agent_participant is None:
            return

        # Channel/group replies normally require an @-mention; an explicit
        # Regenerate is unambiguous intent on a known reply, so it bypasses the
        # gate (else regenerate could silently produce nothing after the old
        # reply was already deleted).
        if not is_regenerate and not _should_respond(
            room_type=room_type,
            content=msg.content or "",
            brigade_agent_id=brigade_agent_id,
        ):
            return

        # Which of the two agent kinds did we just resolve?
        #
        # A gateway/bridge agent is an EXTERNAL process that polls the gateway.
        # Nothing about it runs in here: it has no thinking signal, and this
        # responder cannot generate on its behalf because Brigade has no
        # persona under that id. Proceeding would (a) announce "<X> is
        # thinking…" for a process that is not thinking and was never asked,
        # and (b) post a "…" placeholder that finalizes to a fabricated
        # "_(I had trouble reaching Brigade)_" — ATTRIBUTED TO a real person's
        # Claude Code. Both are lies; the second is the worse one.
        #
        # This is the reported bug, in the room it was reported from.
        # `aaron-shafen-claudes` (a51ac1ce…) has NO `brigade_agent_id` and two
        # agent members, BOTH pure bridges (Aaron's and Shafen's Claude Code),
        # each holding an un-revoked key scoped to that room. On "@all" or
        # "@everyone" the mention router finds no specific name, so
        # _resolve_agent falls through to the "first agent member" fallback —
        # and their joined_at values are IDENTICAL, so it picks arbitrarily
        # between two different people's bridges — then _should_respond says
        # yes and we announce that whichever one it landed on is thinking.
        # "@claude-code" reaches the same end by the mention path. Any check
        # keyed on room metadata answers "not a bridge" here, because there is
        # no metadata; hence the observable-evidence predicate in agent_status:
        # an un-revoked gateway key SCOPED TO THIS ROOM. That is deliberately
        # the structural test, not the liveness one — a bridge that has not
        # polled in an hour is still a bridge with no Brigade persona behind
        # it, and gating this on recent activity would quietly re-open the lie
        # for every dormant bridge. Liveness is required only for the opposite
        # claim, that a relay is currently outstanding.
        #
        # A bridge's honest state is the one the gateway can actually witness:
        # we leave the relay marker set for this message standing, so the room
        # reads "Waiting for Stable bridge relay — <that exact agent>" until
        # the bridge reads or posts, and nothing at all once it has.
        try:
            if await agent_status.is_bridge_agent(
                db=db, room=room, agent_id=brigade_agent_id
            ):
                logger.info(
                    "agent_chat_responder_skipped_bridge_agent",
                    room_id=str(room.id),
                    brigade_agent_id=brigade_agent_id,
                )
                return
        except Exception:
            # A detection failure must not silence a genuine resident agent, so
            # fall through and answer. is_bridge_agent already swallows its own
            # errors and returns False; this is belt-and-braces.
            logger.warning("bridge_agent_check_failed", exc_info=True)

        oai_history = await _build_history(
            db=db,
            room_id=room.id,
            agent_participant_id=agent_participant.id,
        )

        # Retrieval: gather the excerpts this answer will actually be grounded
        # in, from BOTH surfaces the room has —
        #   * documents shared directly in the room (``rag_service``), and
        #   * Knowledge Bases attached to the room (``knowledge_service``).
        # The excerpts are prepended as a system message so the agent answers
        # FROM them, and the SAME excerpts are recorded as ``citations`` on the
        # reply (see ``final_meta`` below) so the human can see, and click
        # through to, the sources behind the answer. Injecting context without
        # recording it is how an answer ends up looking sourced while being
        # unauditable.
        #
        # ``grounding`` records what retrieval actually DID, and the three
        # outcomes are kept distinct on purpose:
        #   "knowledge"   — we retrieved excerpts; they are in ``citations``.
        #   "none"        — we looked and there was genuinely no match.
        #   "unavailable" — we could not look, so this answer is NOT grounded
        #                   and the UI must say so instead of rendering it like
        #                   any other answer.
        # Collapsing "unavailable" into "none" would let a broken index read as
        # an empty one, which is the exact failure this records against.
        grounding_result = await _gather_grounding(
            settings=settings, db=db, room=room, query=msg.content or ""
        )
        citations = grounding_result["citations"]
        grounding = grounding_result["grounding"]
        # Newest block first so the model reads knowledge-base excerpts ahead
        # of room-shared documents, matching the citation order the human sees.
        for block in reversed(grounding_result["context_blocks"]):
            oai_history = [{"role": "system", "content": block}] + oai_history

        logger.info(
            "agent_chat_grounding",
            room_id=str(room.id),
            grounding=grounding or "n/a",
            citations=len(citations),
        )

        # Facilitator mode (opt-in via the /facilitate composer command): when
        # the resident agent is an orchestrator, route this turn to the best
        # specialist and let IT answer in-room as itself (turn-capped to one
        # hand-off). Fully fail-safe — returns False on any issue so the
        # orchestrator just answers normally.
        if (
            not is_regenerate
            and isinstance(msg.metadata_, dict)
            and msg.metadata_.get("facilitate")
        ):
            try:
                from app.services.facilitator import try_facilitate

                if await try_facilitate(
                    db=db,
                    settings=settings,
                    livekit=livekit,
                    room=room,
                    user_msg=msg,
                    sender_id=sender_id,
                    orchestrator_id=brigade_agent_id,
                    orchestrator_participant=agent_participant,
                    history=oai_history,
                ):
                    return
            except Exception:
                logger.warning("facilitate_hook_failed", exc_info=True)

        # Council mode (opt-in via the /council composer command): answer the
        # question under several models in parallel and synthesize one reply.
        # Fail-safe — returns False so a normal single-model reply proceeds.
        if (
            not is_regenerate
            and isinstance(msg.metadata_, dict)
            and msg.metadata_.get("council")
        ):
            try:
                from app.services.council import try_council

                if await try_council(
                    db=db,
                    settings=settings,
                    livekit=livekit,
                    room=room,
                    user_msg=msg,
                    sender_id=sender_id,
                    agent_id=brigade_agent_id,
                    agent_participant=agent_participant,
                    history=oai_history,
                ):
                    return
            except Exception:
                logger.warning("council_hook_failed", exc_info=True)

        # Past the bridge gate, so this agent is genuinely ours to run and the
        # typing signal below is true. The two states are now disjoint by
        # construction — only bridges are ever marked relay-pending, and a
        # bridge never reaches this line — so retracting the marker is pure
        # belt-and-braces against a marker left by an earlier state of the
        # world (a key revoked or re-scoped mid-conversation). It deletes
        # nothing in the normal case and publishes only on a real transition,
        # so it costs nothing to keep and closes the one way an agent could
        # otherwise show two contradictory lines at once.
        try:
            await agent_status.clear_relay_pending(
                room_id=room.id, agent_id=brigade_agent_id
            )
        except Exception:
            logger.debug("responder_relay_clear_failed", exc_info=True)

        await _send_typing(
            livekit=livekit,
            livekit_room_name=room.livekit_room_name,
            room_id=room.id,
            brigade_agent_id=brigade_agent_id,
            typing=True,
            agent_label=agent_participant.display_name,
            participant_id=agent_participant.id,
        )

        # Everything from here to the finally below runs with typing ASSERTED,
        # so it all has to sit inside a try whose exit path retracts it. Before,
        # the try started only at the Brigade call, and a failure in between
        # (placeholder send, ws deliver, history/model setup) left the indicator
        # stuck on with no matching off-event — capped only by the client's 120s
        # backstop, which is the same "status lies for two minutes" failure this
        # change exists to remove.
        try:
            svc = MessageService(db=db, livekit=livekit)
            placeholder = await svc.send_message(
                room_id=room.id,
                sender_id=agent_participant.id,
                content="…",
                content_type="text",
                metadata={
                    "agent_id": brigade_agent_id,
                    "source": "agent_chat_responder",
                },
            )

            # Deliver the (placeholder) agent reply to the web client over the ws
            # plane in the exact WsMessageEvent shape. We reuse the REST serializer
            # so field names match the frontend exactly. Best-effort; lazy import
            # avoids an import cycle with app.api.messages.
            try:
                from app.api.messages import _msg_to_response as _serialize_msg

                await _ws_deliver_to_room(
                    db=db,
                    room_id=room.id,
                    envelope={
                        "type": "message",
                        "payload": {
                            "room_id": str(room.id),
                            # streaming:true positively marks this as a live reply so
                            # the client drives the Stop control off message.streaming
                            # alone (never the "…" content heuristic, which a crashed
                            # finalize could otherwise strand on a dead message).
                            "streaming": True,
                            "message": _serialize_msg(placeholder, 0).model_dump(
                                mode="json"
                            ),
                        },
                    },
                )
            except Exception:
                logger.debug("agent_chat_ws_new_message_failed", exc_info=True)

            # Effective LLM override: explicit per-message model wins; otherwise a
            # per-room override persisted on room metadata (set via the model
            # switcher / invite). None → Brigade uses the persona's default model.
            effective_model = model
            if not effective_model and isinstance(room.metadata_, dict):
                raw_override = room.metadata_.get("model_override")
                if isinstance(raw_override, str) and raw_override:
                    effective_model = raw_override
            if effective_model:
                # Governed-override audit trail: overridden traffic still runs on
                # Brigade's key (budgets/attribution hold); this line is the log.
                logger.info(
                    "model_override_used",
                    room_id=str(room.id),
                    agent=brigade_agent_id,
                    model=effective_model,
                    source="message" if model else "room_metadata",
                )

            accumulated = ""
            artifact_meta: dict[str, str] | None = None
            _last_push = [0.0]
            _last_stop_check = [0.0]
            stop_state: dict[str, bool] = {"stopped": False}

            async def _should_stop() -> bool:
                # Cross-worker stop check, throttled to ~4/s so we don't hit Redis
                # per token. The user pressed Stop on this exact placeholder reply.
                now = asyncio.get_running_loop().time()
                if now - _last_stop_check[0] < 0.25:
                    return False
                _last_stop_check[0] = now
                return await _is_stop_requested(placeholder.id)

            async def _on_progress(text: str, is_content: bool) -> None:
                # Stream the reply (and pre-reply tool progress) into the placeholder
                # over the ws plane as it arrives, so the user sees live activity
                # instead of a static "…" for the whole 5-15s. Tool-status updates
                # always push promptly; content tokens are throttled (~8/s).
                now = asyncio.get_running_loop().time()
                if (not is_content) or (now - _last_push[0] >= 0.12):
                    _last_push[0] = now
                    await _stream_patch(
                        room_id=room.id,
                        message_id=placeholder.id,
                        content=text,
                    )

        except Exception:
            logger.exception("agent_chat_responder_setup_failed")
            await _send_typing(
                livekit=livekit,
                livekit_room_name=room.livekit_room_name,
                room_id=room.id,
                brigade_agent_id=brigade_agent_id,
                typing=False,
                agent_label=agent_participant.display_name,
                participant_id=agent_participant.id,
            )
            return

        try:
            accumulated, artifact_meta = await _call_brigade(
                settings=settings,
                brigade_agent_id=brigade_agent_id,
                user_id=str(sender_id) if sender_id else "anonymous",
                messages=oai_history,
                room=room,
                model=effective_model,
                on_progress=_on_progress,
                should_stop=_should_stop,
                stop_state=stop_state,
            )
        except Exception as exc:
            logger.exception("brigade_chat_call_failed")
            if not accumulated:
                accumulated = (
                    f"_(I had trouble reaching Brigade: {exc.__class__.__name__})_"
                )
        finally:
            stopped = bool(stop_state.get("stopped"))
            if not accumulated.strip():
                accumulated = "_(stopped)_" if stopped else "_(empty reply)_"
            elif stopped:
                accumulated = accumulated.rstrip() + "\n\n_⏹ Stopped_"
            # If the agent used a canvas tool, attach the artifact reference to
            # this same reply message's metadata so the frontend can render an
            # "Open in canvas" chip (merged, never clobbering existing keys).
            # A `stopped` flag rides along when the user halted generation.
            final_meta: dict[str, Any] | None = dict(artifact_meta or {})
            if stopped:
                final_meta["stopped"] = True
            # The grounding record for THIS answer: which excerpts it was built
            # from, and — when there are none — whether that is because nothing
            # matched or because retrieval could not run. The UI reads these to
            # render sources, and to warn instead of sources when retrieval was
            # unavailable. Without this stamp the sources UI has no producer and
            # silently renders nothing on every message.
            if grounding:
                final_meta["grounding"] = grounding
            if citations:
                final_meta["citations"] = citations
            if not final_meta:
                final_meta = None
            # Guarded so a finalize failure cannot skip the typing=False below
            # it: the reply may be lost, but the indicator must not be left
            # asserting that an agent is still working on it.
            try:
                await _patch_message(
                    db=db,
                    livekit=livekit,
                    message_id=placeholder.id,
                    content=accumulated,
                    finalize=True,
                    extra_metadata=final_meta,
                )
                await _clear_stop(placeholder.id)
            except Exception:
                logger.exception("agent_chat_responder_finalize_failed")
            if artifact_meta:
                logger.info(
                    "agent_chat_responder_artifact_attached",
                    room_id=str(room.id),
                    artifact_id=artifact_meta.get("artifact_id"),
                )
            await _send_typing(
                livekit=livekit,
                livekit_room_name=room.livekit_room_name,
                room_id=room.id,
                brigade_agent_id=brigade_agent_id,
                typing=False,
                agent_label=agent_participant.display_name,
                participant_id=agent_participant.id,
            )
            logger.info(
                "agent_chat_responder_replied",
                room_id=str(room.id),
                brigade_agent_id=brigade_agent_id,
                chars=len(accumulated),
            )


async def _resolve_agent(
    *, db: Any, room: Room, content: str = "", room_type: str = "channel"
) -> tuple[str | None, Participant | None]:
    """Find the Brigade agent that should answer this message.

    Priority:
        0. MULTI-AGENT ROOMS (group_dm/channel with >1 agent member): the agent
           the message explicitly ``@``-mentions, so every invited agent is
           individually addressable. DMs and single-agent rooms skip this.
        1. ``room.metadata_["brigade_agent_id"]`` (canonical, set when an
           agent is invited).
        2. First agent-typed RoomMember with a ``keycloak_sub`` of the form
           ``brigade:<id>`` (legacy rooms or rooms invited without metadata).
    Returns (brigade_agent_id, agent_participant) or (None, None).
    """
    # 0. In a multi-agent group/channel, route to the @-mentioned member so a
    # message like "@maj-metrics ..." reaches that agent even though it isn't
    # the canonical (last-invited) one. Falls through when nobody specific is
    # named (e.g. @all), leaving the canonical agent + _should_respond in charge.
    if room_type != "dm" and content:
        agent_members = (
            await db.execute(
                select(Participant)
                .join(RoomMember, RoomMember.participant_id == Participant.id)
                .where(
                    RoomMember.room_id == room.id,
                    Participant.participant_type == ParticipantType.AGENT,
                )
            )
        ).scalars().all()
        if len(agent_members) > 1:
            lc = content.lower()
            for p in agent_members:
                sub = p.keycloak_sub or ""
                if not sub.startswith("brigade:"):
                    continue
                bid = sub.split(":", 1)[1]
                needles = {
                    bid.lower(),
                    bid.replace("-", " ").lower(),
                    (p.display_name or "").lower(),
                }
                if any(n and f"@{n}" in lc for n in needles):
                    return bid, p

    brigade_agent_id: str | None = None
    if room.metadata_ and isinstance(room.metadata_, dict):
        raw = room.metadata_.get("brigade_agent_id")
        if isinstance(raw, str) and raw:
            brigade_agent_id = raw

    if brigade_agent_id:
        pseudo_sub = f"brigade:{brigade_agent_id}"
        agent_p = (
            await db.execute(
                select(Participant).where(Participant.keycloak_sub == pseudo_sub)
            )
        ).scalar_one_or_none()
        if agent_p is not None:
            # Ensure room membership for clean broadcast paths.
            existing = (
                await db.execute(
                    select(RoomMember).where(
                        RoomMember.room_id == room.id,
                        RoomMember.participant_id == agent_p.id,
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                db.add(
                    RoomMember(
                        room_id=room.id,
                        participant_id=agent_p.id,
                        role=MemberRole.MEMBER,
                    )
                )
                await db.commit()
            return brigade_agent_id, agent_p

        # Metadata names an agent we've never seen — auto-create the
        # Participant so the reply can land. Mirrors the bootstrap in
        # /internal/agent-messages.
        display = brigade_agent_id.replace("-", " ").title()
        agent_p = Participant(
            keycloak_sub=pseudo_sub,
            username=f"agent-{brigade_agent_id}",
            display_name=display,
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
        )
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)
        db.add(
            RoomMember(
                room_id=room.id,
                participant_id=agent_p.id,
                role=MemberRole.MEMBER,
            )
        )
        await db.commit()
        return brigade_agent_id, agent_p

    # Fallback: pick the first agent member of the room.
    agent_p = (
        await db.execute(
            select(Participant)
            .join(RoomMember, RoomMember.participant_id == Participant.id)
            .where(
                RoomMember.room_id == room.id,
                Participant.participant_type == ParticipantType.AGENT,
            )
            .order_by(RoomMember.joined_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if agent_p is None:
        return None, None
    sub = agent_p.keycloak_sub or ""
    if sub.startswith("brigade:"):
        return sub.split(":", 1)[1], agent_p
    return None, None


def _should_respond(
    *, room_type: str, content: str, brigade_agent_id: str
) -> bool:
    """@-mention rule: DM = always respond; CHANNEL/GROUP_DM = only if mentioned.

    Mentions match ``@<brigade_agent_id>``, ``@<spaced display>``,
    ``@everyone``, or ``@all`` (case-insensitive).
    """
    if room_type == "dm":
        return True
    lc = content.lower()
    if "@everyone" in lc or "@all" in lc:
        return True
    needles = {
        brigade_agent_id.lower(),
        brigade_agent_id.replace("-", " ").lower(),
    }
    return any(f"@{n}" in lc for n in needles if n)


async def _build_history(
    *, db: Any, room_id: uuid.UUID, agent_participant_id: uuid.UUID
) -> list[dict[str, str]]:
    """Build OpenAI-shaped chat history (oldest first) from recent messages."""
    rows = (
        await db.execute(
            select(Message)
            .where(
                Message.room_id == room_id,
                Message.is_deleted == False,  # noqa: E712
                Message.parent_id == None,  # noqa: E711
            )
            .order_by(Message.created_at.desc())
            .limit(_HISTORY_LIMIT)
        )
    ).scalars().all()
    rows = list(reversed(rows))

    messages: list[dict[str, str]] = []
    for h in rows:
        text = (h.content or "").strip()
        if not text or text == "…":
            continue
        # A user-stopped reply was abandoned on purpose — don't replay its
        # partial text (or the "⏹ Stopped" UI marker) to the agent as if it
        # were real assistant context on the next turn.
        if isinstance(h.metadata_, dict) and h.metadata_.get("stopped"):
            continue
        role = "assistant" if h.sender_id == agent_participant_id else "user"
        messages.append({"role": role, "content": text})
    return messages


_CANVAS_TOOL_NAMES = {"canvas_create", "canvas_rewrite", "canvas_edit"}


def _extract_canvas_artifact(data: Any) -> dict[str, str] | None:
    """Pull a canvas artifact reference out of Brigade's ``toolCalls``.

    Brigade runs tools server-side and returns, alongside ``content``, a
    ``toolCalls`` array of ``{id, name, arguments, result, error}``. When the
    agent used a canvas tool, one entry's ``name`` is in
    :data:`_CANVAS_TOOL_NAMES` and its ``result`` carries the new/updated
    artifact id — either nested (``{"result": {"artifact_id": ...}}``) or flat
    (``{"artifact_id": ...}``). Returns
    ``{"artifact_id": <uuid>, "artifact_title": <title>}`` (title omitted when
    unknown) for the LAST successful canvas call, or ``None``.

    Fully defensive: any missing/oddly-shaped field is a no-op (never raises).
    The ``arguments`` may arrive as a dict or a JSON-encoded string.
    """
    try:
        if not isinstance(data, dict):
            return None
        tool_calls = data.get("toolCalls")
        if not isinstance(tool_calls, list):
            return None

        found: dict[str, str] | None = None
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            name = call.get("name")
            if name not in _CANVAS_TOOL_NAMES:
                continue
            if call.get("error"):
                continue

            result = call.get("result")
            if isinstance(result, str):
                try:
                    result = json.loads(result)
                except Exception:
                    result = None
            if not isinstance(result, dict):
                continue
            # Handle both nested ({"result": {...}}) and flat ({...}) shapes.
            inner = result.get("result")
            body = inner if isinstance(inner, dict) else result
            artifact_id = body.get("artifact_id")
            if not isinstance(artifact_id, str) or not artifact_id:
                continue

            meta: dict[str, str] = {"artifact_id": artifact_id}
            # Title only exists on create; pull from the tool arguments.
            args = call.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = None
            if isinstance(args, dict):
                title = args.get("title")
                if isinstance(title, str) and title.strip():
                    meta["artifact_title"] = title.strip()
            found = meta  # keep the last successful canvas call
        return found
    except Exception:
        logger.warning("brigade_toolcalls_parse_failed", exc_info=True)
        return None


_TOOL_STATUS = {
    "cdr_search": "🔍 _Searching the web…_",
    "cdr_quick_answer": "🔍 _Searching the web…_",
    "cdr_deep_research": "🔬 _Researching…_",
    "web_search": "🔍 _Searching the web…_",
    "search_knowledge": "📚 _Searching your documents…_",
    "canvas_create": "📝 _Writing to the canvas…_",
    "canvas_rewrite": "📝 _Updating the canvas…_",
    "canvas_edit": "📝 _Editing the canvas…_",
    "memory": "🧠 _Recalling…_",
    "delegate_to_agent": "👥 _Asking a specialist…_",
}


def _tool_status(name: str | None) -> str:
    if name and name in _TOOL_STATUS:
        return _TOOL_STATUS[name]
    return f"⚙️ _Using {name or 'a tool'}…_"


async def _stream_patch(
    *, room_id: uuid.UUID, message_id: uuid.UUID, content: str
) -> None:
    """Push an incremental streaming update of the agent's reply to the web
    client over the ws plane (a ``message_edit``), WITHOUT a DB write — the final
    ``_patch_message(finalize=True)`` persists the complete content, keeping the
    DB off the per-chunk hot path. Best-effort; a failure never breaks the reply."""
    from datetime import datetime, timezone

    try:
        await _ws_deliver_to_room(
            db=None,
            room_id=room_id,
            envelope={
                "type": "message_edit",
                "payload": {
                    "room_id": str(room_id),
                    "message_id": str(message_id),
                    "content": content,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "streaming": True,
                },
            },
        )
    except Exception:
        logger.debug("agent_chat_stream_patch_failed", exc_info=True)


def _brigade_error_reply(status: int, body: str) -> str:
    """Friendly room message for a failed Brigade call.

    Federated / edge agents (e.g. the laptop-backed ``companion``) return
    502/503 when their backing node is asleep, offline, or has sharing toggled
    off. Surface that plainly instead of a "check backend logs" reference so a
    room reads cleanly when a device drops out of rotation."""
    low = (body or "").lower()
    if (
        status in (502, 503)
        or "serviceunavailable" in low
        or "sharing disabled" in low
        or "no fallback model group" in low
        or "may be offline" in low
    ):
        return (
            "_This agent is offline right now \u2014 its backing node (e.g. a "
            "laptop) may be asleep or unavailable. It'll respond once it's back._"
        )
    return f"_(Brigade returned {status}; check backend logs.)_"


async def _call_brigade_streaming(
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    on_progress: Any,
    should_stop: Any = None,
    stop_state: dict[str, bool] | None = None,
) -> tuple[str, dict[str, Any] | None]:
    """Stream Brigade's reply over SSE (POST stream=true). Forwards token deltas
    (accumulated content) and pre-content tool_call events to
    ``on_progress(text, is_content)``. Returns (final content, artifact meta).

    If ``should_stop`` is given, it is awaited between SSE lines; when it returns
    True the stream is abandoned (the httpx context manager closes the upstream
    connection on break) and ``stop_state["stopped"]`` is set so the caller can
    finalize whatever was produced so far."""
    payload = {**payload, "stream": True}
    full = ""
    saw_token = False
    final_evt: dict[str, Any] | None = None
    tool_calls_log: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=_BRIGADE_TIMEOUT) as http:
        async with http.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code >= 300:
                body = (await resp.aread())[:300].decode("utf-8", "replace")
                logger.warning(
                    "brigade_chat_http_error",
                    status=resp.status_code,
                    body=body,
                    url=url,
                )
                return (
                    _brigade_error_reply(resp.status_code, body),
                    None,
                )
            async for line in resp.aiter_lines():
                if should_stop is not None:
                    try:
                        if await should_stop():
                            if stop_state is not None:
                                stop_state["stopped"] = True
                            logger.info("brigade_stream_stopped_by_user")
                            break
                    except Exception:
                        logger.debug("brigade_stream_stop_check_failed", exc_info=True)
                if not line or not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    evt = json.loads(chunk)
                except Exception:
                    continue
                etype = evt.get("type")
                if etype == "token":
                    tok = evt.get("content") or ""
                    if tok:
                        full += tok
                        saw_token = True
                        try:
                            await on_progress(full, True)
                        except Exception:
                            logger.debug("brigade_stream_progress_failed", exc_info=True)
                elif etype == "tool_call":
                    tool_calls_log.append(
                        {"name": evt.get("name"), "arguments": evt.get("arguments")}
                    )
                    if not saw_token:
                        try:
                            await on_progress(_tool_status(evt.get("name")), False)
                        except Exception:
                            logger.debug("brigade_stream_progress_failed", exc_info=True)
                elif etype == "complete":
                    final_evt = evt
    if final_evt and isinstance(final_evt.get("content"), str) and final_evt["content"].strip():
        full = final_evt["content"]
    tool_calls = (final_evt or {}).get("toolCalls") or tool_calls_log
    artifact_meta = _extract_canvas_artifact({"toolCalls": tool_calls, "content": full})
    if not full.strip():
        full = "_(empty reply from Brigade)_"
    return full, artifact_meta


async def _call_brigade(
    *,
    settings: Settings,
    brigade_agent_id: str,
    user_id: str,
    messages: list[dict[str, str]],
    room: Room,
    model: str | None = None,
    on_progress: Any = None,
    should_stop: Any = None,
    stop_state: dict[str, bool] | None = None,
) -> tuple[str, dict[str, str] | None]:
    """POST to Brigade's chat endpoint; return (reply text, canvas artifact meta).

    Uses ``POST {brigade_api_base_url}/agents/{agent_id}/chat`` with an
    ``X-API-Key`` header — the path the brief specifies as the full-tool-use
    contract. Non-streaming: Brigade returns ``{"content": "...", "toolCalls":
    [...]}`` once the upstream agent finishes its reasoning + tool round-trips
    (5–15s typical). ``room`` is threaded so the room context (id + livekit
    name) can be sent — Brigade's server-side canvas tools need it to know
    which room to write to. The second tuple element is the canvas artifact
    reference (``{"artifact_id", "artifact_title"?}``) when the agent used a
    canvas tool, else ``None``.
    """
    base = settings.brigade_api_base_url.rstrip("/")
    url = f"{base}/agents/{brigade_agent_id}/chat"
    headers = {
        "X-API-Key": settings.brigade_api_key,
        "Content-Type": "application/json",
    }
    last_user_msg = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user_msg = m.get("content", "")
            break
    # Brigade's ChatRequest reads PRIOR turns from `history` and appends
    # `message` as the current turn; it has NO `messages` field, so sending the
    # whole conversation as `messages` gave the agent zero memory turn-to-turn.
    # Send prior turns as `history` (current trailing user turn stripped off).
    _history = list(messages)
    if (_history and _history[-1].get("role") == "user"
            and _history[-1].get("content", "") == last_user_msg):
        _history = _history[:-1]
    payload: dict[str, Any] = {
        "message": last_user_msg,
        "history": _history,
        "user": user_id,
        # Room context for server-side tools (e.g. canvas) — additive; Brigade
        # ignores these if it doesn't use them.
        "room_id": str(room.id),
        "room_name": room.livekit_room_name,
    }
    # Per-conversation LLM override (model switcher). Brigade's /agents/{id}/chat
    # honors a `model` field that overrides the persona's configured model.
    if model:
        payload["model"] = model

    # Streaming path: when the caller wants live progress, POST with stream=true
    # and forward Brigade's SSE token / tool_call events through on_progress.
    if on_progress is not None:
        return await _call_brigade_streaming(
            url, headers, payload, on_progress, should_stop, stop_state
        )

    async with httpx.AsyncClient(timeout=_BRIGADE_TIMEOUT) as http:
        resp = await http.post(url, headers=headers, json=payload)
        if resp.status_code >= 300:
            logger.warning(
                "brigade_chat_http_error",
                status=resp.status_code,
                body=resp.text[:300],
                url=url,
            )
            return (
                _brigade_error_reply(resp.status_code, resp.text),
                None,
            )
        try:
            data = resp.json()
        except Exception:
            return resp.text or "_(empty reply)_", None

    artifact_meta = _extract_canvas_artifact(data)

    content = data.get("content") if isinstance(data, dict) else None
    if not isinstance(content, str) or not content.strip():
        # Some agent responses might use 'reply', 'text', or OpenAI-shaped
        # 'choices[0].message.content'. Try those before giving up.
        if isinstance(data, dict):
            for key in ("reply", "text", "answer"):
                if isinstance(data.get(key), str) and data[key].strip():
                    return data[key], artifact_meta
            choices = data.get("choices") or []
            if choices and isinstance(choices, list):
                msg0 = choices[0].get("message") if isinstance(choices[0], dict) else None
                if isinstance(msg0, dict) and isinstance(msg0.get("content"), str):
                    return msg0["content"], artifact_meta
        return "_(empty reply from Brigade)_", artifact_meta
    return content, artifact_meta


async def _patch_message(
    *,
    db: Any,
    livekit: LiveKitService,
    message_id: uuid.UUID,
    content: str,
    finalize: bool,
    extra_metadata: dict[str, Any] | None = None,
) -> None:
    msg = (
        await db.execute(select(Message).where(Message.id == message_id))
    ).scalar_one_or_none()
    # Bail if the placeholder was deleted out from under us — e.g. a Regenerate
    # soft-deleted this reply and started a fresh one. An orphaned responder
    # task must never overwrite or "resurrect" a message every client already
    # dropped. (Regenerate also request_stop()s this id, so this is rare.)
    if msg is None or msg.is_deleted:
        return
    msg.content = content
    if finalize:
        msg.is_edited = True
    # Merge any extra metadata (e.g. a canvas artifact reference) onto the
    # message without clobbering keys set when the placeholder was created
    # (agent_id, source). Defensive — a bad value must not break the reply.
    if extra_metadata:
        try:
            merged = dict(msg.metadata_ or {})
            merged.update(extra_metadata)
            msg.metadata_ = merged
        except Exception:
            logger.warning("agent_chat_metadata_merge_failed", exc_info=True)
    await db.commit()

    # Deliver the patched content to the web client over the ws plane as a
    # `message_edit` (the WsMessageEditEvent shape). The LiveKit `message_updated`
    # send below only reaches in-room voice agents.
    from datetime import datetime, timezone

    updated_at = (
        msg.edited_at.isoformat()
        if msg.edited_at
        else datetime.now(timezone.utc).isoformat()
    )
    await _ws_deliver_to_room(
        db=db,
        room_id=msg.room_id,
        envelope={
            "type": "message_edit",
            "payload": {
                "room_id": str(msg.room_id),
                "message_id": str(msg.id),
                "content": msg.content,
                "updated_at": updated_at,
                # On finalize, positively assert the terminal state rather than
                # leaving the client to infer it from the absence of the flag —
                # so a single lost streaming frame can't strand the Stop pill.
                **({"streaming": False} if finalize else {}),
            },
        },
    )

    room = (
        await db.execute(select(Room).where(Room.id == msg.room_id))
    ).scalar_one_or_none()
    if room is None or not room.livekit_room_name:
        return
    try:
        await livekit.send_data(
            room_name=room.livekit_room_name,
            data={
                "type": "message_updated",
                "message_id": str(msg.id),
                "room_id": str(msg.room_id),
                "content": msg.content,
                "metadata": msg.metadata_,
                "finalize": finalize,
            },
        )
    except Exception:
        logger.debug("livekit_update_fanout_failed", exc_info=True)


async def _send_typing(
    *,
    livekit: LiveKitService,
    livekit_room_name: str,
    room_id: uuid.UUID,
    brigade_agent_id: str,
    typing: bool,
    agent_label: str | None = None,
    participant_id: uuid.UUID | None = None,
) -> None:
    """Announce that this agent really is (or has stopped) generating a reply.

    Fans out on BOTH planes, because the two clients listen in different
    places: the LiveKit data channel serves in-call clients, while the web chat
    client listens for agent_typing on its WebSocket. Publishing only to
    LiveKit — the original behaviour — meant the browser never saw a real
    signal and fell back to an optimistic local flag that asserted "thinking"
    on every send whether or not anything was running.

    The ws publish is deliberately NOT gated on livekit_room_name: a
    text-only room has no LiveKit room, and its chat client still deserves the
    truth. Both sends are individually wrapped so neither can break the reply,
    and callers emit the matching typing=False from a finally so the
    indicator clears on error and on stop as well as on success.
    """
    await agent_status.publish_agent_typing(
        room_id=room_id,
        brigade_agent_id=brigade_agent_id,
        typing=typing,
        agent_label=agent_label,
        participant_id=participant_id,
    )
    if not livekit_room_name:
        return
    try:
        await livekit.send_data(
            room_name=livekit_room_name,
            data={
                "type": "agent_typing",
                "room_id": str(room_id),
                "brigade_agent_id": brigade_agent_id,
                "typing": typing,
            },
        )
    except Exception:
        logger.debug("typing_fanout_failed", exc_info=True)
