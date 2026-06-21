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
from app.services.livekit_service import LiveKitService
from app.services.message_service import MessageService

logger = structlog.get_logger(__name__)


_HISTORY_LIMIT = 10
_BRIGADE_TIMEOUT = httpx.Timeout(120.0, connect=10.0)


def schedule_response(
    *,
    room_id: uuid.UUID,
    message_id: uuid.UUID,
    sender_id: uuid.UUID | None,
    settings: Settings,
    session_factory: async_sessionmaker,
    livekit: LiveKitService,
    model: str | None = None,
) -> None:
    """Fire-and-forget background task to generate an agent reply.

    Returns immediately. Errors are logged, not raised. ``model`` optionally
    overrides the resident agent's underlying LLM for this reply (the
    OpenWebUI-style mid-conversation model switcher).
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
        brigade_agent_id, agent_participant = await _resolve_agent(
            db=db, room=room
        )
        if not brigade_agent_id or agent_participant is None:
            return

        if not _should_respond(
            room_type=room_type,
            content=msg.content or "",
            brigade_agent_id=brigade_agent_id,
        ):
            return

        oai_history = await _build_history(
            db=db,
            room_id=room.id,
            agent_participant_id=agent_participant.id,
        )

        await _send_typing(
            livekit=livekit,
            livekit_room_name=room.livekit_room_name,
            room_id=room.id,
            brigade_agent_id=brigade_agent_id,
            typing=True,
        )

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

        # Effective LLM override: explicit per-message model wins; otherwise a
        # per-room override persisted on room metadata (set via the model
        # switcher / invite). None → Brigade uses the persona's default model.
        effective_model = model
        if not effective_model and isinstance(room.metadata_, dict):
            raw_override = room.metadata_.get("model_override")
            if isinstance(raw_override, str) and raw_override:
                effective_model = raw_override

        accumulated = ""
        try:
            accumulated = await _call_brigade(
                settings=settings,
                brigade_agent_id=brigade_agent_id,
                user_id=str(sender_id) if sender_id else "anonymous",
                messages=oai_history,
                model=effective_model,
            )
        except Exception as exc:
            logger.exception("brigade_chat_call_failed")
            if not accumulated:
                accumulated = (
                    f"_(I had trouble reaching Brigade: {exc.__class__.__name__})_"
                )
        finally:
            if not accumulated.strip():
                accumulated = "_(empty reply)_"
            await _patch_message(
                db=db,
                livekit=livekit,
                message_id=placeholder.id,
                content=accumulated,
                finalize=True,
            )
            await _send_typing(
                livekit=livekit,
                livekit_room_name=room.livekit_room_name,
                room_id=room.id,
                brigade_agent_id=brigade_agent_id,
                typing=False,
            )
            logger.info(
                "agent_chat_responder_replied",
                room_id=str(room.id),
                brigade_agent_id=brigade_agent_id,
                chars=len(accumulated),
            )


async def _resolve_agent(
    *, db: Any, room: Room
) -> tuple[str | None, Participant | None]:
    """Find the Brigade agent attached to this room.

    Priority:
        1. ``room.metadata_["brigade_agent_id"]`` (canonical, set when an
           agent is invited).
        2. First agent-typed RoomMember with a ``keycloak_sub`` of the form
           ``brigade:<id>`` (legacy rooms or rooms invited without metadata).
    Returns (brigade_agent_id, agent_participant) or (None, None).
    """
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
        role = "assistant" if h.sender_id == agent_participant_id else "user"
        messages.append({"role": role, "content": text})
    return messages


async def _call_brigade(
    *,
    settings: Settings,
    brigade_agent_id: str,
    user_id: str,
    messages: list[dict[str, str]],
    model: str | None = None,
) -> str:
    """POST to Brigade's dedicated chat endpoint and return the reply text.

    Uses ``POST {brigade_api_base_url}/agents/{agent_id}/chat`` with an
    ``X-API-Key`` header — the path the brief specifies as the full-tool-use
    contract. Non-streaming: Brigade returns ``{"content": "..."}`` once the
    upstream agent finishes its reasoning + tool round-trips (5–15s typical).
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
    payload: dict[str, Any] = {
        "message": last_user_msg,
        "messages": messages,
        "user": user_id,
    }
    # Per-conversation LLM override (model switcher). Brigade's /agents/{id}/chat
    # honors a `model` field that overrides the persona's configured model.
    if model:
        payload["model"] = model

    async with httpx.AsyncClient(timeout=_BRIGADE_TIMEOUT) as http:
        resp = await http.post(url, headers=headers, json=payload)
        if resp.status_code >= 300:
            logger.warning(
                "brigade_chat_http_error",
                status=resp.status_code,
                body=resp.text[:300],
                url=url,
            )
            return f"_(Brigade returned {resp.status_code}; check backend logs.)_"
        try:
            data = resp.json()
        except Exception:
            return resp.text or "_(empty reply)_"

    content = data.get("content") if isinstance(data, dict) else None
    if not isinstance(content, str) or not content.strip():
        # Some agent responses might use 'reply', 'text', or OpenAI-shaped
        # 'choices[0].message.content'. Try those before giving up.
        if isinstance(data, dict):
            for key in ("reply", "text", "answer"):
                if isinstance(data.get(key), str) and data[key].strip():
                    return data[key]
            choices = data.get("choices") or []
            if choices and isinstance(choices, list):
                msg0 = choices[0].get("message") if isinstance(choices[0], dict) else None
                if isinstance(msg0, dict) and isinstance(msg0.get("content"), str):
                    return msg0["content"]
        return "_(empty reply from Brigade)_"
    return content


async def _patch_message(
    *,
    db: Any,
    livekit: LiveKitService,
    message_id: uuid.UUID,
    content: str,
    finalize: bool,
) -> None:
    msg = (
        await db.execute(select(Message).where(Message.id == message_id))
    ).scalar_one_or_none()
    if msg is None:
        return
    msg.content = content
    if finalize:
        msg.is_edited = True
    await db.commit()

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
) -> None:
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
