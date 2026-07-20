from __future__ import annotations

import json
import time
import uuid
from typing import Annotated, Any

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._internal_auth import verify_internal_bearer
from app.config import get_settings
from app.deps import (
    ensure_room_member,
    get_current_user,
    get_db,
    get_livekit,
    rate_limit,
    require_room_member,
)
from app.schemas.message import (
    MessageCreate,
    MessageListResponse,
    MessageResponse,
    MessageUpdate,
    SenderInfo,
)
from app.services.agent_chat_responder import schedule_response as schedule_agent_chat_response
from app.services.livekit_service import LiveKitService
from app.services.message_service import MessageService

logger = structlog.get_logger(__name__)

router = APIRouter()


def _build_message_service(
    db: AsyncSession,
    livekit: LiveKitService,
) -> MessageService:
    return MessageService(db=db, livekit=livekit)


def _msg_to_response(msg: Any, reply_count: int = 0) -> MessageResponse:
    sender_info: SenderInfo | None = None
    sender_name = ""
    sender_avatar: str | None = None
    sender_type = "human"
    if msg.sender:
        sender_info = SenderInfo(
            id=msg.sender.id,
            username=msg.sender.username,
            display_name=msg.sender.display_name,
            avatar_url=msg.sender.avatar_url,
            participant_type=msg.sender.participant_type.value,
        )
        sender_name = msg.sender.display_name or msg.sender.username
        sender_avatar = msg.sender.avatar_url
        sender_type = msg.sender.participant_type.value

    # Wire-format aliases so the frontend's friendlier names match what the
    # backend stores in its ContentType enum.
    ct_value = msg.content_type.value
    ct_out = {"agent_action": "action"}.get(ct_value, ct_value)
    return MessageResponse(
        id=msg.id,
        room_id=msg.room_id,
        sender_id=msg.sender_id,
        sender_type=sender_type,
        sender_name=sender_name,
        sender_avatar=sender_avatar,
        content=msg.content,
        content_type=ct_out,
        metadata=msg.metadata_ or {},
        thread_id=msg.parent_id,
        parent_id=msg.parent_id,
        edited=msg.is_edited,
        is_edited=msg.is_edited,
        edited_at=msg.edited_at,
        is_deleted=msg.is_deleted,
        created_at=msg.created_at,
        updated_at=msg.edited_at or msg.created_at,
        sender=sender_info,
        reply_count=reply_count,
    )


_pub_redis = None


def _get_pub_redis():
    """Lazily-created Redis client for cross-worker ws fan-out via pub/sub.

    The ws ConnectionManager is an in-process singleton, so with
    ``uvicorn --workers 4`` a connection lives on exactly ONE worker while a
    request/agent-reply runs on any of the 4. Delivering over Redis ``room:{id}``
    — which the ws handler subscribes to on every worker — is the only path that
    reaches the client regardless of which worker holds its socket."""
    global _pub_redis
    if _pub_redis is None:
        from redis.asyncio import Redis

        from app.config import get_settings

        _pub_redis = Redis.from_url(
            get_settings().redis_url, decode_responses=False
        )
    return _pub_redis


async def _ws_broadcast_room(
    db: AsyncSession,
    room_id: Any,
    envelope: dict[str, Any],
) -> None:
    """Best-effort deliver a ``{type, payload}`` envelope to a room's members
    over the web-client WebSocket plane.

    Publishes to Redis ``room:{id}`` (cross-worker) rather than the in-process
    ConnectionManager — see :func:`_get_pub_redis`. ``db`` is retained for
    signature stability but no longer used. A delivery failure must never break
    the request, so everything here is wrapped and only logged."""
    try:
        await _get_pub_redis().publish(f"room:{room_id}", json.dumps(envelope))
    except Exception:
        logger.warning("ws_room_broadcast_failed", exc_info=True)


async def _ws_send_participant(
    participant_id: Any,
    envelope: dict[str, Any],
) -> None:
    """Best-effort deliver a ``{type, payload}`` envelope to a single user over
    the web-client WebSocket plane.

    Publishes to Redis ``user:{id}`` (cross-worker), which the ws handler
    subscribes to per connection — the same reason :func:`_ws_broadcast_room`
    avoids the in-process ConnectionManager under ``uvicorn --workers 4``."""
    try:
        await _get_pub_redis().publish(
            f"user:{participant_id}", json.dumps(envelope)
        )
    except Exception:
        logger.warning("ws_user_send_failed", exc_info=True)


@router.post(
    "/rooms/{room_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    room_id: uuid.UUID,
    body: MessageCreate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    request: Request = None,  # type: ignore[assignment]
    _rl: Annotated[
        None, Depends(rate_limit("msg_send", "rate_limit_message_send_per_min"))
    ] = None,
) -> MessageResponse:
    """Send a message to a room.

    Membership is enforced inside MessageService.send_message. Rate-limited
    per user. The internal agent path calls this function directly (not via
    HTTP) so it bypasses the DI-injected rate limit, which is intended.
    """
    svc = _build_message_service(db, livekit)
    # Normalize friendly aliases to the underlying ContentType enum values.
    ct_aliases = {"action": "agent_action", "image": "text", "file": "text"}
    ct = ct_aliases.get(body.content_type, body.content_type)
    msg = await svc.send_message(
        room_id=room_id,
        sender_id=user["participant_id"],
        content=body.content,
        content_type=ct,
        metadata=body.metadata,
        parent_id=body.parent_id,
    )

    # Mention emails — resolve recipients with the request's db, then dispatch
    # actual sends as fire-and-forget tasks so the response isn't blocked.
    try:
        await _maybe_dispatch_mention_emails(
            db=db,
            content=body.content or "",
            room_id=room_id,
            sender_name=user.get("display_name") or user.get("username") or "Someone",
            sender_email=user.get("email"),
        )
    except Exception:
        logger.warning("mention_email_dispatch_error", exc_info=True)

    # Web-push the same offline @-mentioned users (closed/backgrounded app).
    # Fail-safe; no-op unless VAPID is configured.
    try:
        from app.services.push_service import dispatch_mention_pushes

        await dispatch_mention_pushes(
            db=db,
            content=body.content or "",
            room_id=room_id,
            sender_name=user.get("display_name") or user.get("username") or "Someone",
            settings=get_settings(),
        )
    except Exception:
        logger.warning("mention_push_dispatch_error", exc_info=True)

    # Text-only agent reply path. If the room is agent-attached, route the
    # user's message through Brigade's chat API in a background task so the
    # agent can respond without the LiveKit voice pipeline. See
    # services/agent_chat_responder.py. Filtered out for agent-authored
    # messages and disabled-by-config cases inside schedule_response itself.
    #
    # Before scheduling, enforce the agent's own rate budget
    # (agent_configs.rate_limit_rpm). If the resident agent has already
    # answered rate_limit_rpm times this minute, we skip auto-replying — the
    # user's message still posts; the agent just stays quiet until the window
    # rolls over. This protects the (paid) Brigade backend from a chatty room.
    #
    # The relay-pending mark below runs BEFORE this scheduling call, and that
    # ordering is deliberate. Both signals upsert the same per-agent row on the
    # client, so whichever lands second wins. If the responder's task were
    # created first, its typing=True could be published while the mark was
    # still awaiting its DB query, and the relay mark would then clobber a TRUE
    # "thinking" with a false "waiting for relay" for the whole generation.
    # Awaiting the mark first makes the ordering deterministic; the responder
    # additionally retracts the marker for whichever agent it actually resolved
    # (see agent_chat_responder), which is the part room metadata cannot know
    # because _resolve_agent also routes by @-mention and by a legacy fallback.
    try:
        # request=None marks the internal voice-transcript path, which
        # deliberately does not trigger agent activity — honour that here too.
        if request is not None and user.get("participant_type") != "agent" and not str(
            user.get("sub") or ""
        ).startswith("brigade:"):
            from app.services.agent_status import mark_relay_pending_for_room

            await mark_relay_pending_for_room(db=db, room_id=room_id)
    except Exception:
        logger.warning("relay_pending_mark_failed", exc_info=True)

    try:
        if request is not None:
            settings_now = get_settings()
            redis_now = getattr(request.app.state, "redis", None)
            if await _agent_chat_within_budget(
                db=db,
                redis=redis_now,
                settings=settings_now,
                room_id=room_id,
            ):
                schedule_agent_chat_response(
                    room_id=room_id,
                    message_id=msg.id,
                    sender_id=user.get("participant_id"),
                    settings=settings_now,
                    session_factory=request.app.state.db_session_factory,
                    livekit=livekit,
                    model=body.model,
                )
    except Exception:
        logger.warning("agent_chat_responder_schedule_failed", exc_info=True)

    # Document RAG indexing. If the message carries document attachments,
    # index them (extract → chunk → embed → qdrant, scoped to the room) in a
    # fire-and-forget task so the room's agent can later answer FROM the docs.
    # Fully fail-safe: any error is swallowed and never blocks message send.
    # Imported lazily to avoid an import cycle at module load.
    try:
        settings_for_rag = get_settings()
        attachments = None
        if isinstance(body.metadata, dict):
            attachments = body.metadata.get("attachments")
        if (
            getattr(settings_for_rag, "rag_enabled", False)
            and isinstance(attachments, list)
            and attachments
        ):
            import asyncio as _asyncio

            from app.services.rag_service import rag_service as _rag_service

            _asyncio.create_task(
                _rag_service.index_message_attachments(
                    settings=settings_for_rag,
                    room_id=room_id,
                    message_id=msg.id,
                    attachments=attachments,
                )
            )
    except Exception:
        logger.warning("rag_index_schedule_failed", exc_info=True)

    # MessageService.send_message already broadcasts onto the LiveKit data
    # channel as `{type: "new_message", ...}` for in-room (voice-path) agents.
    # That does NOT reach the web client, which listens on the WebSocket — so
    # ALSO deliver the message to the room's members over the ws plane in the
    # exact WsMessageEvent shape the frontend expects ({type, payload}).
    response = _msg_to_response(msg)
    await _ws_broadcast_room(
        db,
        room_id,
        {
            "type": "message",
            "payload": {
                "room_id": str(room_id),
                "message": response.model_dump(mode="json"),
            },
        },
    )

    return response


_MENTION_RE = None


async def _maybe_dispatch_mention_emails(
    db: AsyncSession,
    content: str,
    room_id: uuid.UUID,
    sender_name: str,
    sender_email: str | None,
) -> None:
    """Find @mentioned offline humans, queue async emails to each."""
    import asyncio as _asyncio
    import re

    from sqlalchemy import select as _select

    from app.api.users import _load_keycloak_email_for_sub
    from app.config import get_settings
    from app.models.participant import (
        Participant as _P,
        ParticipantStatus as _PS,
        ParticipantType as _PT,
    )
    from app.models.room import Room as _Room
    from app.services.email_sender import GraphEmailSender

    global _MENTION_RE
    if _MENTION_RE is None:
        _MENTION_RE = re.compile(r"@([A-Za-z0-9_.\-]{2,64})")
    handles = {m.lower() for m in _MENTION_RE.findall(content)}
    if not handles:
        return

    cfg = get_settings()
    sender = GraphEmailSender(
        tenant_id=cfg.ms_graph_tenant_id,
        client_id=cfg.ms_graph_client_id,
        client_secret=cfg.ms_graph_client_secret,
        from_address=cfg.ms_graph_from_address,
    )
    if not sender.is_configured:
        return

    room = (
        await db.execute(_select(_Room).where(_Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        return

    rows = (
        await db.execute(
            _select(_P).where(
                _P.participant_type == _PT.HUMAN,
                _P.status != _PS.ONLINE,
            )
        )
    ).scalars().all()
    targets = [p for p in rows if (p.username or "").lower() in handles]
    if not targets:
        return

    quote = content if len(content) <= 280 else content[:280] + "…"
    link = f"{cfg.public_base_url}/?room={room.id}"
    subject = f"{sender_name} mentioned you in {room.display_name}"

    async def _send_one(p: _P) -> None:
        try:
            email = await _load_keycloak_email_for_sub(p.keycloak_sub)
            if not email:
                return
            html = f"""
<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#1e293b;line-height:1.5;">
<p>Hi {p.display_name or p.username},</p>
<p><strong>{sender_name}</strong> mentioned you in
   <strong>{room.display_name}</strong> on Stable:</p>
<blockquote style="border-left:3px solid #7c3aed;padding-left:12px;margin:12px 0;color:#475569;">
{quote}
</blockquote>
<p><a href="{link}" style="display:inline-block;padding:10px 18px;background:#7c3aed;
   color:#fff;text-decoration:none;border-radius:6px;">Open Stable</a></p>
</body></html>
"""
            await sender.send(
                to=email,
                subject=subject,
                html_body=html,
                reply_to=sender_email,
            )
        except Exception:
            logger.warning("mention_email_send_error", exc_info=True)

    for p in targets:
        _asyncio.create_task(_send_one(p))


async def _agent_chat_within_budget(
    *,
    db: AsyncSession,
    redis: Any,
    settings: Any,
    room_id: uuid.UUID,
) -> bool:
    """Return True if the room's resident agent may auto-reply right now.

    Resolves the room's Brigade agent → its AgentConfig.rate_limit_rpm and
    enforces it as a per-minute Redis counter. Rooms with no resident agent
    always return True (nothing to throttle). Fails OPEN on any error so a
    Redis/DB blip never silences agents.
    """
    if not getattr(settings, "rate_limit_enabled", True):
        return True
    if redis is None:
        return True
    try:
        from sqlalchemy import select as _select

        from app.models.agent import AgentConfig as _AC
        from app.models.participant import Participant as _P
        from app.models.room import Room as _Room

        room = (
            await db.execute(_select(_Room).where(_Room.id == room_id))
        ).scalar_one_or_none()
        if room is None or not room.metadata_:
            return True
        brigade_agent_id = room.metadata_.get("brigade_agent_id") if isinstance(room.metadata_, dict) else None
        if not brigade_agent_id:
            # No canonical agent declared on the room → nothing to throttle here.
            return True

        agent_p = (
            await db.execute(
                _select(_P).where(_P.keycloak_sub == f"brigade:{brigade_agent_id}")
            )
        ).scalar_one_or_none()

        # Per-minute budget: the agent's own rate_limit_rpm if it has a config,
        # else the suite-wide default.
        rpm = int(getattr(settings, "rate_limit_agent_chat_per_min", 30) or 30)
        if agent_p is not None:
            cfg = (
                await db.execute(
                    _select(_AC).where(_AC.participant_id == agent_p.id)
                )
            ).scalar_one_or_none()
            if cfg is not None and cfg.rate_limit_rpm:
                rpm = int(cfg.rate_limit_rpm)

        window = int(time.time()) // 60
        key = f"ratelimit:agent_chat:{brigade_agent_id}:{window}"
        current = await redis.incr(key)
        if current == 1:
            await redis.expire(key, 61)
        if current > rpm:
            logger.info(
                "agent_chat_rate_limited",
                brigade_agent_id=brigade_agent_id,
                count=current,
                limit=rpm,
            )
            return False
        return True
    except Exception:
        logger.warning("agent_chat_budget_check_failed", exc_info=True)
        return True


class AgentMessageBody(BaseModel):
    livekit_room_name: str
    brigade_agent_id: str
    content: str
    parent_id: uuid.UUID | None = None
    # Optional channel tag (e.g. "voice") merged into the message metadata so
    # the client can badge a spoken turn distinctly from a typed one.
    via: str | None = None


class VoiceUserMessageBody(BaseModel):
    """A human's spoken (STT) turn, persisted to room history by the voice
    agent runtime. ``speaker_identity`` is the LiveKit identity, which the
    agent token mints as ``"{username}_{participant_id}"`` (see api/tokens.py),
    so the trailing UUID resolves the backend participant."""

    livekit_room_name: str
    speaker_identity: str
    content: str


class AgentMessageUpdateBody(BaseModel):
    content: str
    finalize: bool = False  # set true on the LAST chunk so we stop "typing"


class AgentTypingBody(BaseModel):
    livekit_room_name: str
    brigade_agent_id: str
    typing: bool


class PromoteToProjectOpsBody(BaseModel):
    project_number: str = Field(..., min_length=1, max_length=32)
    title: str | None = Field(None, max_length=255)
    description: str | None = Field(None, max_length=4000)
    priority: str = Field("MEDIUM", pattern=r"^(LOW|MEDIUM|HIGH|URGENT)$")


class ProjectOpsTaskResponse(BaseModel):
    task_id: str
    project_number: str
    task_url: str
    task_number: str | None = None


class ProjectOpsProject(BaseModel):
    id: str
    projectNumber: str
    title: str
    status: str | None = None


_PO_PROJECTS_CACHE: dict[str, Any] = {"expires_at": 0.0, "projects": None}


def _extract_sse_json(text: str) -> dict[str, Any]:
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data and data != "[DONE]":
            return json.loads(data)
    return json.loads(text)


def _maybe_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    value = value.strip()
    if not value:
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _extract_mcp_value(payload: dict[str, Any]) -> Any:
    if "error" in payload:
        err = payload["error"]
        message = err.get("message") if isinstance(err, dict) else str(err)
        raise HTTPException(status_code=502, detail=message or "Project Ops MCP error")

    result = payload.get("result")
    if isinstance(result, dict):
        for key in ("structuredContent", "structured_content"):
            if key in result:
                return result[key]

        content = result.get("content")
        if isinstance(content, list) and content:
            text_parts = [
                item.get("text")
                for item in content
                if isinstance(item, dict) and isinstance(item.get("text"), str)
            ]
            if text_parts:
                parsed = _maybe_json("\n".join(text_parts))
                if isinstance(parsed, dict) and "result" in parsed:
                    return parsed["result"]
                return parsed
        return result

    return payload


async def _call_projectops_tool(name: str, arguments: dict[str, Any]) -> Any:
    cfg = get_settings()
    if not cfg.projectops_service_jwt:
        raise HTTPException(
            status_code=502,
            detail="Project Ops service JWT is not configured",
        )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                cfg.projectops_mcp_url,
                headers={
                    "Authorization": f"Bearer {cfg.projectops_service_jwt}",
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                },
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                },
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=resp.text[:1000])

    try:
        return _extract_mcp_value(_extract_sse_json(resp.text))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not parse Project Ops MCP response: {exc}",
        ) from exc


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("projects", "data", "items", "result"):
            nested = value.get(key)
            if isinstance(nested, list):
                return nested
    return []


def _normalize_projects(value: Any) -> list[ProjectOpsProject]:
    projects: list[ProjectOpsProject] = []
    for item in _as_list(value):
        if not isinstance(item, dict):
            continue
        project_id = item.get("id")
        project_number = item.get("projectNumber") or item.get("project_number")
        title = item.get("title") or item.get("name")
        if not project_id or not project_number or not title:
            continue
        projects.append(
            ProjectOpsProject(
                id=str(project_id),
                projectNumber=str(project_number),
                title=str(title),
                status=str(item["status"]) if item.get("status") else None,
            )
        )
    return projects


async def _list_projectops_projects_cached() -> list[ProjectOpsProject]:
    now = time.monotonic()
    cached = _PO_PROJECTS_CACHE.get("projects")
    if cached is not None and float(_PO_PROJECTS_CACHE.get("expires_at") or 0) > now:
        return cached

    projects = _normalize_projects(await _call_projectops_tool("list_my_projects", {}))
    _PO_PROJECTS_CACHE["projects"] = projects
    _PO_PROJECTS_CACHE["expires_at"] = now + 60
    return projects


def _extract_task(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        for key in ("task", "data", "result"):
            nested = value.get(key)
            if isinstance(nested, dict):
                return nested
        return value
    return {}


def _default_task_title(content: str) -> str:
    compact = " ".join((content or "").split())
    return (compact[:77] + "...") if len(compact) > 80 else (compact or "Stable message follow-up")


async def _load_visible_message(
    message_id: uuid.UUID,
    user: dict[str, Any],
    db: AsyncSession,
) -> Any:
    from app.models.message import Message as _Msg
    from app.models.room import Room as _Room, RoomMember as _RM

    row = (
        await db.execute(
            select(_Msg, _Room)
            .join(_Room, _Room.id == _Msg.room_id)
            .join(
                _RM,
                (_RM.room_id == _Msg.room_id)
                & (_RM.participant_id == user["participant_id"]),
            )
            .where(_Msg.id == message_id)
        )
    ).one_or_none()
    if row is None:
        exists = (
            await db.execute(select(_Msg.id).where(_Msg.id == message_id))
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail="Message not found")
        raise HTTPException(status_code=403, detail="Not a member of this room")
    return row


def _build_projectops_description(msg: Any, room: Any, body: PromoteToProjectOpsBody) -> str:
    cfg = get_settings()
    sender_name = ""
    if msg.sender:
        sender_name = msg.sender.display_name or msg.sender.username or str(msg.sender_id)
    else:
        sender_name = str(msg.sender_id or "Unknown")

    content = msg.content or ""
    if len(content) > 2048:
        content = content[:2048].rstrip() + "\n\n[Stable message truncated at 2048 characters]"

    permalink = f"{cfg.public_base_url}/?room={room.id}&message={msg.id}"
    parts = []
    if body.description:
        parts.append(body.description.strip())
        parts.append("")
    parts.extend(
        [
            "Stable source message",
            f"Room: {room.display_name or room.name}",
            f"Permalink: {permalink}",
            f"Sender: {sender_name}",
            f"Timestamp: {msg.created_at.isoformat()}",
            "",
            "Message:",
            content,
        ]
    )

    if msg.metadata_:
        parts.extend(["", "Metadata:", json.dumps(msg.metadata_, indent=2, sort_keys=True, default=str)])

    return "\n".join(parts).strip()


@router.get("/po/projects", response_model=list[ProjectOpsProject])
async def list_projectops_projects(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
) -> list[ProjectOpsProject]:
    """List Project Ops projects visible to the service account for the picker."""
    _ = user
    return await _list_projectops_projects_cached()


@router.post(
    "/messages/{message_id}/promote-to-po-task",
    response_model=ProjectOpsTaskResponse,
)
async def promote_message_to_projectops_task(
    message_id: uuid.UUID,
    body: PromoteToProjectOpsBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ProjectOpsTaskResponse:
    """Promote a visible Stable message into a Project Ops task."""
    msg, room = await _load_visible_message(message_id, user, db)
    description = _build_projectops_description(msg, room, body)
    task_args = {
        "projectNumber": body.project_number,
        "title": (body.title or _default_task_title(msg.content or "")).strip(),
        "description": description,
        "priority": body.priority,
    }

    task = _extract_task(await _call_projectops_tool("create_task", task_args))
    task_id = task.get("id") or task.get("taskId") or task.get("task_id")
    if not task_id:
        raise HTTPException(
            status_code=502,
            detail="Project Ops did not return a task id",
        )

    project_number = (
        task.get("projectNumber")
        or task.get("project_number")
        or body.project_number
    )
    task_number = task.get("taskNumber") or task.get("task_number") or task.get("number")
    project_id = task.get("projectId") or task.get("project_id")
    if not project_id and isinstance(task.get("project"), dict):
        project_id = task["project"].get("id")
    if not project_id:
        for project in await _list_projectops_projects_cached():
            if project.projectNumber == project_number:
                project_id = project.id
                break

    cfg = get_settings()
    task_url = f"{cfg.projectops_dashboard_url}/dashboard/projects/{project_id or project_number}"

    meta = dict(msg.metadata_ or {})
    meta["projectops_task"] = {
        "id": str(task_id),
        "project_number": str(project_number),
        "task_number": str(task_number) if task_number else None,
        "task_url": task_url,
        "promoted_by": str(user["participant_id"]),
        "promoted_by_name": user.get("display_name") or user.get("username") or "",
        "promoted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    msg.metadata_ = meta
    await db.commit()

    return ProjectOpsTaskResponse(
        task_id=str(task_id),
        project_number=str(project_number),
        task_url=task_url,
        task_number=str(task_number) if task_number else None,
    )


@router.post(
    "/internal/agent-messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def post_agent_message(
    body: AgentMessageBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Post a message as a Brigade agent. Agent workers call this.

    Authenticated via the shared LiveKit secret (the same secret the agent
    worker uses to mint LiveKit tokens). On first call for a given
    brigade_agent_id, an agent-typed Participant row is auto-created so
    everything downstream (history, threads, mentions) treats the agent
    as a first-class participant.
    """
    from sqlalchemy import select as _select

    from app.config import get_settings
    from app.models.participant import (
        Participant as _P,
        ParticipantStatus as _PS,
        ParticipantType as _PT,
    )
    from app.models.room import Room as _Room

    cfg = get_settings()
    verify_internal_bearer(request)

    room = (
        await db.execute(
            _select(_Room).where(_Room.livekit_room_name == body.livekit_room_name)
        )
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # Find or create an agent-typed participant for this brigade agent.
    pseudo_sub = f"brigade:{body.brigade_agent_id}"
    pseudo_username = f"agent-{body.brigade_agent_id}"
    agent_p = (
        await db.execute(_select(_P).where(_P.keycloak_sub == pseudo_sub))
    ).scalar_one_or_none()
    if agent_p is None:
        # Friendly display name: convert "col-finance" → "Col Finance"
        display = body.brigade_agent_id.replace("-", " ").title()
        agent_p = _P(
            keycloak_sub=pseudo_sub,
            username=pseudo_username,
            display_name=display,
            participant_type=_PT.AGENT,
            status=_PS.ONLINE,
        )
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)

    # Ensure the agent is a member of the room (send_message gates on this).
    from app.models.room import MemberRole as _MR, RoomMember as _RM

    existing_member = (
        await db.execute(
            _select(_RM).where(
                _RM.room_id == room.id,
                _RM.participant_id == agent_p.id,
            )
        )
    ).scalar_one_or_none()
    if existing_member is None:
        db.add(
            _RM(
                room_id=room.id,
                participant_id=agent_p.id,
                role=_MR.MEMBER,
            )
        )
        await db.commit()

    # Build a synthetic user dict and re-use send_message's plumbing
    fake_user = {
        "participant_id": agent_p.id,
        "sub": pseudo_sub,
        "username": agent_p.username,
        "display_name": agent_p.display_name,
        "email": None,
    }
    return await send_message(
        room_id=room.id,
        body=MessageCreate(
            content=body.content,
            content_type="text",
            metadata={
                "agent_id": body.brigade_agent_id,
                **({"via": body.via} if body.via else {}),
            },
            parent_id=body.parent_id,
        ),
        user=fake_user,
        db=db,
        livekit=livekit,
        request=request,
    )


@router.post(
    "/internal/voice-user-message",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def post_voice_user_message(
    body: VoiceUserMessageBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Persist a human's spoken (STT) turn into room history.

    The voice agent runtime calls this for each FINAL user transcript so a
    spoken conversation is reviewable later (the live caption data-channel is
    ephemeral). Authenticated via the LiveKit shared secret, like the other
    internal agent routes.

    Attributed to the resolved human participant and tagged ``via=voice``.
    Crucially we pass ``request=None`` into ``send_message`` so this does NOT
    schedule a *text* agent reply — the voice agent already answers over TTS;
    a text reply here would double-respond.
    """
    from sqlalchemy import select as _select

    from app.config import get_settings
    from app.models.participant import Participant as _P, ParticipantType as _PT
    from app.models.room import Room as _Room, RoomMember as _RM

    cfg = get_settings()
    verify_internal_bearer(request)

    room = (
        await db.execute(
            _select(_Room).where(_Room.livekit_room_name == body.livekit_room_name)
        )
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # LiveKit identity is "{username}_{participant_id}". The participant_id is a
    # UUID (no underscores), so the trailing segment after the last "_" is it.
    raw_id = body.speaker_identity.rsplit("_", 1)[-1]
    try:
        speaker_pid = uuid.UUID(raw_id)
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Unrecognized speaker identity"
        )

    participant = (
        await db.execute(
            _select(_P).where(
                _P.id == speaker_pid, _P.participant_type == _PT.HUMAN
            )
        )
    ).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=404, detail="Speaker not found")

    is_member = (
        await db.execute(
            _select(_RM.id).where(
                _RM.room_id == room.id, _RM.participant_id == participant.id
            )
        )
    ).scalar_one_or_none()
    if is_member is None:
        raise HTTPException(status_code=403, detail="Speaker not in this room")

    fake_user = {
        "participant_id": participant.id,
        "sub": participant.keycloak_sub,
        "username": participant.username,
        "display_name": participant.display_name,
        "email": None,
    }
    # request=None → persist + broadcast, but DON'T trigger a text agent reply.
    return await send_message(
        room_id=room.id,
        body=MessageCreate(
            content=body.content,
            content_type="text",
            metadata={"via": "voice"},
        ),
        user=fake_user,
        db=db,
        livekit=livekit,
        request=None,
    )


@router.patch(
    "/internal/agent-messages/{message_id}",
    response_model=MessageResponse,
)
async def update_agent_message(
    message_id: uuid.UUID,
    body: AgentMessageUpdateBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Update an agent message in-place. Used to stream chunks: agent posts
    an empty/initial message, then PATCHes content as it arrives from the LLM.

    Authenticated via the LiveKit shared secret.
    """
    from sqlalchemy import select as _select

    from app.config import get_settings
    from app.models.message import Message as _Msg
    from app.models.room import Room as _Room

    cfg = get_settings()
    verify_internal_bearer(request)

    msg = (
        await db.execute(_select(_Msg).where(_Msg.id == message_id))
    ).scalar_one_or_none()
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found")

    msg.content = body.content
    if body.finalize:
        msg.is_edited = True
    await db.commit()
    await db.refresh(msg)

    # Broadcast the update via LiveKit data channel so other agents/clients
    # can re-render. Browsers also receive a separate WS event from the
    # message router on edit; this covers the agent-data-channel path too.
    try:
        room = (
            await db.execute(_select(_Room).where(_Room.id == msg.room_id))
        ).scalar_one_or_none()
        if room and room.livekit_room_name:
            await livekit.send_data(
                room_name=room.livekit_room_name,
                data={
                    "type": "message_updated",
                    "message_id": str(msg.id),
                    "room_id": str(msg.room_id),
                    "content": msg.content,
                    "finalize": body.finalize,
                },
            )
    except Exception:
        logger.debug("livekit_update_fanout_failed", exc_info=True)

    return _msg_to_response(msg)


@router.post("/internal/agent-typing", status_code=status.HTTP_204_NO_CONTENT)
async def post_agent_typing(
    body: AgentTypingBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> None:
    """Broadcast a typing/working indicator for an agent over LiveKit data."""
    from sqlalchemy import select as _select

    from app.config import get_settings
    from app.models.room import Room as _Room

    cfg = get_settings()
    verify_internal_bearer(request)

    room = (
        await db.execute(
            _select(_Room).where(_Room.livekit_room_name == body.livekit_room_name)
        )
    ).scalar_one_or_none()
    if room is None:
        return None

    # Republish on the ws plane too — the web chat client listens for
    # agent_typing there, not on the LiveKit data channel. Without this the
    # in-call clients saw the signal and the browser saw nothing.
    #
    # Carry the agent's real display_name: this is the in-call voice path, and
    # without a label the chat panel would title-case the raw brigade id
    # ("perry-spector" → "Perry Spector", or worse for an id that isn't a name)
    # and show that to everyone in the room for the duration of the call.
    from app.services import agent_status as _agent_status

    from app.models.participant import Participant as _Participant

    agent_label: str | None = None
    agent_p = None
    try:
        agent_p = (
            await db.execute(
                _select(_Participant).where(
                    _Participant.keycloak_sub == f"brigade:{body.brigade_agent_id}"
                )
            )
        ).scalar_one_or_none()
        if agent_p is not None:
            agent_label = agent_p.display_name
    except Exception:
        logger.debug("agent_typing_label_lookup_failed", exc_info=True)

    await _agent_status.publish_agent_typing(
        room_id=room.id,
        brigade_agent_id=body.brigade_agent_id,
        typing=body.typing,
        agent_label=agent_label,
        participant_id=agent_p.id if agent_p is not None else None,
    )

    try:
        await livekit.send_data(
            room_name=room.livekit_room_name,
            data={
                "type": "agent_typing",
                "room_id": str(room.id),
                "brigade_agent_id": body.brigade_agent_id,
                "typing": body.typing,
            },
        )
    except Exception:
        logger.debug("typing_fanout_failed", exc_info=True)
    return None


@router.get("/rooms/{room_id}/messages", response_model=MessageListResponse)
async def get_messages(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
) -> MessageListResponse:
    """Get cursor-paginated messages for a room (newest first).

    Caller must be a member of the room.
    """
    svc = _build_message_service(db, livekit)
    result = await svc.get_messages(
        room_id=room_id,
        cursor=cursor,
        limit=limit,
    )
    messages = [
        _msg_to_response(item["message"], item["reply_count"])
        for item in result["messages"]
    ]
    return MessageListResponse(
        messages=messages,
        cursor=result["cursor"],
        has_more=result["has_more"],
    )


@router.patch("/messages/{message_id}", response_model=MessageResponse)
async def edit_message(
    message_id: uuid.UUID,
    body: MessageUpdate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Edit a message. Only the sender can edit."""
    svc = _build_message_service(db, livekit)
    msg = await svc.edit_message(
        message_id=message_id,
        sender_id=user["participant_id"],
        new_content=body.content,
    )
    response = _msg_to_response(msg)
    await _ws_broadcast_room(
        db,
        msg.room_id,
        {
            "type": "message_edit",
            "payload": {
                "room_id": str(msg.room_id),
                "message_id": str(msg.id),
                "content": response.content,
                "updated_at": response.updated_at.isoformat()
                if response.updated_at
                else None,
            },
        },
    )
    return response


@router.delete("/messages/{message_id}", response_model=MessageResponse)
async def delete_message(
    message_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Soft-delete a message."""
    svc = _build_message_service(db, livekit)
    msg = await svc.delete_message(
        message_id=message_id,
        sender_id=user["participant_id"],
    )
    await _ws_broadcast_room(
        db,
        msg.room_id,
        {
            "type": "message_delete",
            "payload": {
                "room_id": str(msg.room_id),
                "message_id": str(msg.id),
            },
        },
    )
    return _msg_to_response(msg)


@router.post("/messages/{message_id}/stop", status_code=status.HTTP_204_NO_CONTENT)
async def stop_generation(
    message_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    """Stop an in-flight agent reply that is currently streaming.

    ``message_id`` is the agent reply (placeholder) message. Any member of the
    room may stop it. The signal is cross-worker (Redis flag the responder
    polls); whatever the agent produced so far is finalized with a `stopped`
    marker. Idempotent — stopping a finished reply is a harmless no-op.
    """
    from app.models.message import Message as _Msg
    from app.services.agent_chat_responder import request_stop

    room_id = (
        await db.execute(select(_Msg.room_id).where(_Msg.id == message_id))
    ).scalar_one_or_none()
    if room_id is None:
        raise HTTPException(status_code=404, detail="Message not found")
    await ensure_room_member(db, room_id, user)
    await request_stop(message_id)
    return None


class RegenerateBody(BaseModel):
    # Optional per-attempt model override (the mid-conversation switcher). When
    # omitted, the room's model_override / the persona default is used.
    model: str | None = None


@router.post("/messages/{message_id}/regenerate", response_model=MessageResponse)
async def regenerate_reply(
    message_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    request: Request = None,  # type: ignore[assignment]
    body: RegenerateBody | None = None,
    _rl: Annotated[
        None, Depends(rate_limit("msg_regen", "rate_limit_message_send_per_min"))
    ] = None,
) -> MessageResponse:
    """Regenerate an agent reply.

    Soft-deletes the given agent reply and re-runs the text responder on the
    user turn that prompted it — a fresh reply streams in over the ws plane
    (exactly like the first time). ``message_id`` must be an agent reply; any
    room member may regenerate it. Returns the now-deleted old message so the
    optimistic caller can drop it immediately.
    """
    from app.models.message import Message as _Msg
    from app.models.participant import (
        Participant as _P,
        ParticipantType as _PT,
    )

    agent_msg = (
        await db.execute(select(_Msg).where(_Msg.id == message_id))
    ).scalar_one_or_none()
    if agent_msg is None or agent_msg.is_deleted:
        raise HTTPException(status_code=404, detail="Message not found")
    await ensure_room_member(db, agent_msg.room_id, user)

    meta = agent_msg.metadata_ if isinstance(agent_msg.metadata_, dict) else {}
    is_agent_reply = (
        meta.get("source") == "agent_chat_responder" or bool(meta.get("agent_id"))
    )
    if not is_agent_reply:
        raise HTTPException(
            status_code=400, detail="Only an agent reply can be regenerated"
        )

    # The user turn that prompted this reply = the most recent non-deleted,
    # non-agent message created before it.
    trigger = (
        await db.execute(
            select(_Msg)
            .join(_P, _P.id == _Msg.sender_id)
            .where(
                _Msg.room_id == agent_msg.room_id,
                _Msg.is_deleted == False,  # noqa: E712
                _Msg.created_at < agent_msg.created_at,
                _P.participant_type != _PT.AGENT,
            )
            .order_by(_Msg.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if trigger is None:
        raise HTTPException(
            status_code=409, detail="No user message to regenerate from"
        )

    # Drop the stale reply (and tell every client to remove it) before the
    # fresh one streams in, so history fed to the agent excludes it. The delete
    # is an atomic guarded UPDATE: only the request that actually flips
    # is_deleted proceeds to re-fire, so two clients regenerating the same reply
    # at once can't produce two replies (the loser gets 409).
    from sqlalchemy import update as _sa_update

    res = await db.execute(
        _sa_update(_Msg)
        .where(_Msg.id == agent_msg.id, _Msg.is_deleted == False)  # noqa: E712
        .values(is_deleted=True)
    )
    await db.commit()
    if res.rowcount == 0:
        raise HTTPException(
            status_code=409, detail="This reply is already being regenerated"
        )
    agent_msg.is_deleted = True  # reflect the committed state in the response

    # Halt any responder still streaming THIS reply (regenerating a mid-stream
    # reply) so its orphaned task winds down instead of emitting edits for a
    # message every client just dropped.
    from app.services.agent_chat_responder import request_stop as _request_stop

    await _request_stop(agent_msg.id)

    await _ws_broadcast_room(
        db,
        agent_msg.room_id,
        {
            "type": "message_delete",
            "payload": {
                "room_id": str(agent_msg.room_id),
                "message_id": str(agent_msg.id),
            },
        },
    )

    model = body.model if body else None
    # Re-fire the SAME agent that authored the original reply (pinned), and on
    # the per-agent paid-Brigade budget — regenerate must not be a hole that
    # bypasses the throttle the send path enforces.
    pinned_agent_id = meta.get("agent_id") if isinstance(meta, dict) else None
    try:
        if request is not None:
            settings_now = get_settings()
            redis_now = getattr(request.app.state, "redis", None)
            if await _agent_chat_within_budget(
                db=db,
                redis=redis_now,
                settings=settings_now,
                room_id=agent_msg.room_id,
            ):
                schedule_agent_chat_response(
                    room_id=agent_msg.room_id,
                    message_id=trigger.id,
                    sender_id=trigger.sender_id,
                    settings=settings_now,
                    session_factory=request.app.state.db_session_factory,
                    livekit=livekit,
                    model=model,
                    is_regenerate=True,
                    pinned_agent_id=pinned_agent_id
                    if isinstance(pinned_agent_id, str) and pinned_agent_id
                    else None,
                )
            else:
                logger.info(
                    "agent_chat_regenerate_rate_limited",
                    room_id=str(agent_msg.room_id),
                )
    except Exception:
        logger.warning("agent_chat_regenerate_schedule_failed", exc_info=True)

    return _msg_to_response(agent_msg)


@router.get("/messages/{message_id}/thread", response_model=MessageListResponse)
async def get_thread(
    message_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
) -> MessageListResponse:
    """Get thread replies under a parent message.

    Caller must be a member of the parent message's room.
    """
    from app.models.message import Message as _Msg

    parent_room_id = (
        await db.execute(
            select(_Msg.room_id).where(_Msg.id == message_id)
        )
    ).scalar_one_or_none()
    if parent_room_id is None:
        raise HTTPException(status_code=404, detail="Message not found")
    await ensure_room_member(db, parent_room_id, user)

    svc = _build_message_service(db, livekit)
    result = await svc.get_thread(
        parent_id=message_id,
        cursor=cursor,
        limit=limit,
    )
    messages = [
        _msg_to_response(item["message"], item["reply_count"])
        for item in result["messages"]
    ]
    return MessageListResponse(
        messages=messages,
        cursor=result["cursor"],
        has_more=result["has_more"],
    )


class ReactBody(BaseModel):
    emoji: str = Field(..., min_length=1, max_length=32)


class DecideBody(BaseModel):
    decision: str = Field(..., pattern=r"^(approved|rejected)$")


@router.post("/messages/{message_id}/decide", response_model=MessageResponse)
async def decide_action(
    message_id: uuid.UUID,
    body: DecideBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Approve or reject an action_request message. Records the decision in
    metadata and broadcasts so other clients (including the requesting agent)
    can react.
    """
    from datetime import datetime, timezone

    from sqlalchemy import select as _select

    from app.models.message import Message as _Msg
    from app.models.room import Room as _Room

    msg = (
        await db.execute(_select(_Msg).where(_Msg.id == message_id))
    ).scalar_one_or_none()
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found")
    # Caller must be a member of the room this action lives in.
    await ensure_room_member(db, msg.room_id, user)
    meta = dict(msg.metadata_ or {})
    if "decision" in meta:
        return _msg_to_response(msg)
    meta["decision"] = body.decision
    meta["decided_by"] = str(user["participant_id"])
    meta["decided_by_name"] = user.get("display_name") or user.get("username") or ""
    # Real decision time — NOT the message's created_at (prior bug).
    meta["decided_at"] = datetime.now(timezone.utc).isoformat()
    msg.metadata_ = meta
    await db.commit()
    await db.refresh(msg)

    # Broadcast over LiveKit data so the requesting agent can react.
    try:
        room = (
            await db.execute(_select(_Room).where(_Room.id == msg.room_id))
        ).scalar_one_or_none()
        if room and room.livekit_room_name:
            await livekit.send_data(
                room_name=room.livekit_room_name,
                data={
                    "type": "action_decision",
                    "message_id": str(msg.id),
                    "room_id": str(msg.room_id),
                    "decision": body.decision,
                    "decided_by": meta["decided_by"],
                    "decided_by_name": meta["decided_by_name"],
                },
            )
    except Exception:
        logger.debug("decision_fanout_failed", exc_info=True)
    return _msg_to_response(msg)


@router.post("/messages/{message_id}/save", response_model=MessageResponse)
async def toggle_save(
    message_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> MessageResponse:
    """Toggle saving a message into the caller's personal Saved list.

    Stored as ``messages.metadata.saved_by`` (list of participant_ids).
    Idempotent — calling twice removes the save.
    """
    from sqlalchemy import select as _select

    from app.models.message import Message as _Msg

    # Lock the row for the duration of the read-modify-write so concurrent
    # save toggles on the same message don't clobber each other (the JSONB
    # column is a whole-value replace, so without the lock it's last-writer-
    # wins on the entire saved_by list).
    msg = (
        await db.execute(
            _select(_Msg).where(_Msg.id == message_id).with_for_update()
        )
    ).scalar_one_or_none()
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found")

    # Caller must be a member of the room to save its messages.
    await ensure_room_member(db, msg.room_id, user)

    pid = str(user["participant_id"])
    meta = dict(msg.metadata_ or {})
    saved_by = list(meta.get("saved_by") or [])
    if pid in saved_by:
        saved_by.remove(pid)
    else:
        saved_by.append(pid)
    meta["saved_by"] = saved_by
    msg.metadata_ = meta
    await db.commit()
    await db.refresh(msg)
    return _msg_to_response(msg)


@router.get("/saved", response_model=list[MessageResponse])
async def list_saved(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(100, ge=1, le=500),
) -> list[MessageResponse]:
    """Return the caller's saved messages, newest first."""
    import json as _json

    from sqlalchemy import desc, select as _select

    from app.models.message import Message as _Msg

    pid = str(user["participant_id"])
    # Correct JSONB containment: match rows whose metadata.saved_by array
    # contains this participant id. ``@>`` is index-backed by the GIN index
    # on the metadata column (migration 002). The previous ``LIKE '%pid%'``
    # on the cast text was unindexed and prone to substring false positives
    # (one id being a prefix/substring of another).
    from sqlalchemy import cast as _cast
    from sqlalchemy.dialects.postgresql import JSONB as _JSONB

    # asyncpg binds a Python str as text/varchar, so a bare containment param
    # yields `jsonb @> varchar` — an operator that does not exist (500). Cast
    # the value to JSONB explicitly so Postgres sees `jsonb @> jsonb`.
    containment_param = _json.dumps({"saved_by": [pid]})
    rows = (
        await db.execute(
            _select(_Msg)
            .where(_Msg.metadata_.op("@>")(_cast(containment_param, _JSONB)))
            .where(_Msg.is_deleted == False)  # noqa: E712
            .order_by(desc(_Msg.created_at))
            .limit(limit)
        )
    ).scalars().all()
    return [_msg_to_response(m) for m in rows]


@router.post("/messages/{message_id}/reactions", response_model=MessageResponse)
async def toggle_reaction(
    message_id: uuid.UUID,
    body: ReactBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> MessageResponse:
    """Toggle a single emoji reaction by the current user on a message.

    Reactions live in messages.metadata.reactions as ``{emoji: [user_id, ...]}``.
    Idempotent — calling twice with the same (message, user, emoji) removes it.
    """
    from sqlalchemy import select as _select
    from app.models.message import Message as _Msg

    # Lock the row across the read-modify-write so concurrent reactions on
    # the same message don't clobber each other's emoji lists (the JSONB
    # reactions map is replaced wholesale, so it's otherwise last-writer-wins).
    msg = (
        await db.execute(
            _select(_Msg).where(_Msg.id == message_id).with_for_update()
        )
    ).scalar_one_or_none()
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found")

    # Caller must be a member of the room to react to its messages.
    await ensure_room_member(db, msg.room_id, user)

    pid = str(user["participant_id"])
    meta = dict(msg.metadata_ or {})
    reactions = dict(meta.get("reactions") or {})
    users_for_emoji = list(reactions.get(body.emoji) or [])
    if pid in users_for_emoji:
        users_for_emoji.remove(pid)
    else:
        users_for_emoji.append(pid)
    if users_for_emoji:
        reactions[body.emoji] = users_for_emoji
    else:
        reactions.pop(body.emoji, None)
    meta["reactions"] = reactions
    msg.metadata_ = meta
    await db.commit()
    await db.refresh(msg)

    # Fanout to room members over the cross-worker Redis ws plane.
    try:
        await _get_pub_redis().publish(
            f"room:{msg.room_id}",
            json.dumps({
                "type": "message_reaction",
                "message_id": str(msg.id),
                "room_id": str(msg.room_id),
                "reactions": reactions,
            }),
        )
    except Exception:
        logger.warning("reaction_fanout_failed", exc_info=True)

    # reply_count not needed here; pass 0
    return _msg_to_response(msg, 0)


@router.get("/rooms/{room_id}/messages/search", response_model=list[MessageResponse])
async def search_messages(
    room_id: uuid.UUID,
    q: str = Query(..., min_length=1, max_length=500),
    user: Annotated[dict[str, Any], Depends(require_room_member)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
    livekit: Annotated[LiveKitService, Depends(get_livekit)] = None,
    limit: int = Query(20, ge=1, le=100),
) -> list[MessageResponse]:
    """Search messages in a room. Caller must be a member of the room."""
    svc = _build_message_service(db, livekit)
    messages = await svc.search_messages(
        room_id=room_id,
        query_text=q,
        limit=limit,
    )
    return [_msg_to_response(msg) for msg in messages]


@router.get("/search/messages", response_model=list[MessageResponse])
async def search_all_messages(
    q: str = Query(..., min_length=1, max_length=500),
    user: Annotated[dict[str, Any], Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
    livekit: Annotated[LiveKitService, Depends(get_livekit)] = None,
    limit: int = Query(30, ge=1, le=100),
) -> list[MessageResponse]:
    """Global search across every room the caller belongs to."""
    svc = _build_message_service(db, livekit)
    messages = await svc.search_all_messages(
        participant_id=user["participant_id"],
        query_text=q,
        limit=limit,
    )
    return [_msg_to_response(msg) for msg in messages]
