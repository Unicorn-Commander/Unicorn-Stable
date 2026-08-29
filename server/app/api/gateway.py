"""ORCH-1 — PUBLIC agent-gateway router (mounted at /api/v1/gateway).

Lets a dev/agent authenticate with a role-gated uchub JWT OR a scoped gateway key
and post to / read from Stable rooms AS A SCOPED, NON-SPOOFABLE agent identity —
replacing the SSH+docker-exec bridge and the single shared ``internal_agent_secret``
(which let any holder post as any agent).

Rides the existing ``stable-api`` Traefik router (PathPrefix ``/api``); it is NOT
under ``/api/v1/internal`` so it is reachable off-host with NO compose change. The
legacy ``/internal/agent-messages`` path is untouched (the SSH bridge keeps working;
rollback = drop this router / GATEWAY_ENABLED=false).
"""

from __future__ import annotations

import os
import secrets
import uuid
from typing import Annotated, Any

import structlog
import httpx
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import Response
from pydantic import BaseModel, Field
from redis.asyncio import Redis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._internal_auth import verify_internal_bearer, verify_key_admin_bearer
from app.api.messages import _build_message_service, _msg_to_response, send_message
from app.auth.gateway_auth import (
    GatewayAuthError,
    GatewayPrincipal,
    hash_key,
    slugify,
    validate_gateway_jwt,
    verify_gateway_key,
)
from app.config import Settings, get_settings
from app.services.agent_status import (
    clear_relay_pending,
    touch_gateway_agent as touch_bridge_seen,
)
from app.deps import (
    _rate_limit_hit,
    get_db,
    get_livekit,
    get_redis,
    get_settings_dep,
    is_room_member,
)
from app.models.agent_gateway_key import AgentGatewayKey
from app.models.participant import (
    Participant,
    ParticipantStatus,
    ParticipantType,
)
from app.models.room import MemberRole, Room, RoomMember
from app.schemas.message import MessageCreate, MessageListResponse, MessageResponse
from app.services.agent_availability import (
    touch_gateway_agent as touch_bridge_fresh,
)
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/gateway", tags=["Gateway"])

# Gateway-key prefixes we recognize (anything else on the Authorization header is
# treated as a JWT). Keys are minted with the first prefix.
_KEY_PREFIXES = ("sbk-", "ubk-", "sk-")


def _gateway_enabled() -> bool:
    return os.getenv("GATEWAY_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------


async def authenticate_gateway_caller(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> GatewayPrincipal:
    """Resolve the caller to a scoped GatewayPrincipal (JWT or key).

    Also records the caller as a currently-reachable bridge agent. A bridge is
    an external process (a Claude Code holding a gateway credential) that is
    reachable only while it is polling — there is no long-poll endpoint and no
    socket to observe — so a recent authenticated call is the only liveness
    evidence that exists. Doing it here rather than in each endpoint means both
    the read and the post path are covered and neither can forget; the touch is
    best-effort and cannot fail the request. See
    services/agent_availability.py.
    """
    if not _gateway_enabled():
        # Feature-flagged off → behave as if the router does not exist.
        raise HTTPException(status_code=404, detail="Not found")

    auth = request.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing bearer credential (gateway key or uchub JWT)",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = auth.removeprefix("Bearer ").strip()
    try:
        if token.startswith(_KEY_PREFIXES):
            principal = await verify_gateway_key(token, db)
        else:
            principal = await validate_gateway_jwt(token, settings)
    except GatewayAuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    await touch_bridge_fresh(redis, principal.agent_id)
    return principal


async def _gateway_rate_limit(
    principal: GatewayPrincipal,
    redis: Redis,
    *,
    bucket: str,
    fail_open: bool,
) -> None:
    """Per-identity rate limit keyed on the principal (not a shared secret)."""
    await _rate_limit_hit(
        redis,
        bucket=bucket,
        identifier=principal.rate_key,
        limit=int(principal.rate_limit_rpm or 30),
        window_seconds=60,
        fail_open=fail_open,
    )


# ---------------------------------------------------------------------------
# Room + participant resolution + scope enforcement
# ---------------------------------------------------------------------------


async def _resolve_room(db: AsyncSession, ref: str) -> Room:
    """Resolve a room by livekit_room_name OR display slug ``name``."""
    room = (
        await db.execute(
            select(Room).where(
                (Room.livekit_room_name == ref) | (Room.name == ref)
            )
        )
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail=f"Room not found: {ref}")
    return room


async def _enforce_scope(
    db: AsyncSession, principal: GatewayPrincipal, room: Room
) -> None:
    """Authorize this principal for this room, on BOTH read and write.

    - Key path (allowed_rooms is a list): the room must be in the allowlist
      (``*`` = any).
    - JWT path (allowed_rooms is None): the underlying HUMAN must already be a
      member of the room — the agent identity can only act where its human
      principal already belongs. No new reach beyond the human's membership.
    """
    if principal.allowed_rooms is not None:
        allowed = principal.allowed_rooms
        if "*" in allowed or room.livekit_room_name in allowed or room.name in allowed:
            return
        raise HTTPException(
            status_code=403, detail="Gateway key is not scoped to this room"
        )

    human = (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == principal.human_sub)
        )
    ).scalar_one_or_none()
    if human is None or not await is_room_member(db, room.id, human.id):
        raise HTTPException(
            status_code=403,
            detail="Not authorized: you must be a member of this room",
        )


async def _resolve_agent_participant(
    db: AsyncSession, agent_id: str, room: Room
) -> Participant:
    """Find-or-create the AGENT participant for ``agent_id`` and ensure it is a
    member of ``room`` (mirrors the legacy post_agent_message block, but the
    agent_id is DERIVED from the credential — never caller-supplied)."""
    pseudo_sub = f"brigade:{agent_id}"
    agent_p = (
        await db.execute(select(Participant).where(Participant.keycloak_sub == pseudo_sub))
    ).scalar_one_or_none()
    if agent_p is None:
        agent_p = Participant(
            keycloak_sub=pseudo_sub,
            username=f"agent-{agent_id}",
            display_name=agent_id.replace("-", " ").title(),
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
        )
        db.add(agent_p)
        await db.commit()
        await db.refresh(agent_p)

    member = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == agent_p.id,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        db.add(RoomMember(room_id=room.id, participant_id=agent_p.id, role=MemberRole.MEMBER))
        await db.commit()
    return agent_p


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class GatewayMessageBody(BaseModel):
    room: str = Field(..., description="livekit_room_name or room slug")
    content: str = Field(..., min_length=1)
    parent_id: uuid.UUID | None = None
    via: str | None = None


class GatewayTtsBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice: str | None = None
    agent: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class MintKeyBody(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=100)
    label: str | None = None
    allowed_rooms: list[str] = Field(default_factory=lambda: ["*"])
    rate_limit_rpm: int = Field(30, ge=1, le=600)


# ---------------------------------------------------------------------------
# Message endpoints
# ---------------------------------------------------------------------------


@router.post("/messages", response_model=MessageResponse, status_code=201)
async def gateway_post_message(
    body: GatewayMessageBody,
    request: Request,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> MessageResponse:
    """Post a message to a room AS the caller's derived agent identity."""
    await _gateway_rate_limit(principal, redis, bucket="gw_msg_send", fail_open=False)
    room = await _resolve_room(db, body.room)
    await _enforce_scope(db, principal, room)
    agent_p = await _resolve_agent_participant(db, principal.agent_id, room)

    fake_user = {
        "participant_id": agent_p.id,
        "sub": f"brigade:{principal.agent_id}",
        "username": agent_p.username,
        "display_name": agent_p.display_name,
        "email": None,
    }
    metadata: dict[str, Any] = {"agent_id": principal.agent_id, "gateway": True}
    if principal.human_sub:
        metadata["on_behalf_of"] = principal.human_sub
    if body.via:
        metadata["via"] = body.via

    result = await send_message(
        room_id=room.id,
        body=MessageCreate(
            content=body.content,
            content_type="text",
            metadata=metadata,
            parent_id=body.parent_id,
        ),
        user=fake_user,
        db=db,
        livekit=livekit,
        request=request,
    )

    # The bridge answered: retract any outstanding-relay marker for it. This is
    # the honest terminal state for a gateway agent — we never claimed it was
    # "thinking", only that something was undelivered, and delivery just
    # happened. Best-effort: a signalling failure must not fail the post, and
    # the marker's TTL clears it regardless.
    try:
        await touch_bridge_seen(principal.agent_id)
        await clear_relay_pending(room_id=room.id, agent_id=principal.agent_id)
    except Exception:
        logger.debug("gateway_relay_clear_failed", exc_info=True)

    return result


@router.get("/rooms/{room}/messages", response_model=MessageListResponse)
async def gateway_get_messages(
    room: str,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
) -> MessageListResponse:
    """Cursor-paginated room history for the scoped caller (the missing token-authed
    READ endpoint — un-stubs the MCP's get_new_messages)."""
    await _gateway_rate_limit(principal, redis, bucket="gw_msg_read", fail_open=True)
    room_obj = await _resolve_room(db, room)
    await _enforce_scope(db, principal, room_obj)
    # Reading IS collection: once the bridge has pulled the room's messages it
    # is no longer "waiting to relay", so drop the marker here as well as on
    # post. Two independent clearing paths plus a TTL means the indicator
    # cannot strand itself on. The touch is what proves this bridge is running
    # NOW — see agent_status.mark_relay_pending_for_room. Both are plain Redis
    # writes, and the clear only fans out on a real transition, so this stays
    # cheap on a 1-2s poll loop.
    try:
        await touch_bridge_seen(principal.agent_id)
        await clear_relay_pending(room_id=room_obj.id, agent_id=principal.agent_id)
    except Exception:
        logger.debug("gateway_relay_clear_failed", exc_info=True)

    svc = _build_message_service(db, livekit)
    result = await svc.get_messages(room_id=room_obj.id, cursor=cursor, limit=limit)
    messages = [
        _msg_to_response(item["message"], item["reply_count"])
        for item in result["messages"]
    ]
    return MessageListResponse(
        messages=messages, cursor=result["cursor"], has_more=result["has_more"]
    )


# ---------------------------------------------------------------------------
# Voice (suite TTS / STT) + session lifecycle for MCP bridges
# ---------------------------------------------------------------------------


class TalkGateBody(BaseModel):
    """Hold or release the talk gate for a room."""

    room: str = Field(..., min_length=1, max_length=200)
    open: bool


@router.post("/talk-gate", status_code=202)
async def set_talk_gate(
    body: TalkGateBody,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> dict:
    """Say "I am addressing the agent now" (or stopped).

    THE ONE PRIMITIVE for external activation. A foot pedal, a stream deck, a
    phone button or a hotkey all become clients of this rather than each
    needing its own integration — which is why there is no pedal-shaped
    endpoint here.

    The state is not stored: it is broadcast into the room's LiveKit session as
    a ``talk_gate`` frame, exactly like every other in-room signal, so the
    voice relay (agents/voice_relay) simply hears it. Nothing to reconcile,
    nothing to leak if a holder disconnects mid-press — the next release, or
    the relay's own teardown, ends it.
    """
    # A pedal press is a high-frequency event; fail OPEN on a limiter blip so a
    # rate-limit hiccup cannot leave the gate stuck and the agent deaf.
    await _gateway_rate_limit(principal, redis, bucket="gw_talk_gate", fail_open=True)
    room = await _resolve_room(db, body.room)
    await _enforce_scope(db, principal, room)
    try:
        await livekit.send_data(
            room.livekit_room_name,
            {"type": "talk_gate", "open": bool(body.open), "by": principal.agent_id},
        )
    except Exception:
        # No live session is the ordinary case, not a fault: a pedal held
        # before anyone joins the call has nobody to tell. Reporting that as a
        # 502 would train the holder to ignore real failures, and a pedal that
        # errors when the call has not started yet feels broken when it is not.
        logger.info(
            "talk_gate_undelivered",
            room=room.livekit_room_name,
            open=bool(body.open),
            reason="no live media session for this room",
        )
        return {"room": body.room, "open": bool(body.open), "delivered": False}
    logger.info(
        "talk_gate_set",
        room=room.livekit_room_name,
        open=bool(body.open),
        by=principal.agent_id,
    )
    return {"room": body.room, "open": bool(body.open), "delivered": True}


@router.post("/tts")
async def gateway_tts(
    body: GatewayTtsBody,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    redis: Annotated[Redis, Depends(get_redis)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> Response:
    """Synthesize speech via suite Kokoro (Orator) for a gateway/MCP agent.

    Same contract as ``POST /api/v1/tts`` but authenticated with a gateway key
    or uchub JWT that has the agent-gateway role. Rate-limited per principal.
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_tts", fail_open=False)

    # Reuse the public TTS voice map + speakable scrub via a local import so we
    # don't drift from the browser path.
    from app.api.tts import (
        AGENT_DEFAULT_VOICE,
        AGENT_VOICES,
        _normalize_agent,
    )
    import re as _re

    speakable = _re.sub(r"\s+", " ", body.text).strip()
    speakable = _re.sub(
        r"[\U00010000-\U0010ffff\u2600-\u27BF\uFE0F\u200D]+",
        " ",
        speakable,
    )
    speakable = _re.sub(r"\s+", " ", speakable).strip()
    if not speakable or not _re.search(r"[A-Za-z0-9]", speakable):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Nothing to speak",
        )

    if body.voice:
        voice = body.voice
    elif body.agent:
        voice = AGENT_VOICES.get(_normalize_agent(body.agent), AGENT_DEFAULT_VOICE)
    else:
        # Prefer the caller's own agent identity voice when known.
        voice = AGENT_VOICES.get(
            _normalize_agent(principal.agent_id), settings.tts_default_voice
        )

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.post(
                f"{settings.kokoro_base_url}/v1/audio/speech",
                json={
                    "model": "kokoro",
                    "input": speakable,
                    "voice": voice,
                    "response_format": "mp3",
                    "speed": body.speed,
                },
            )
    except httpx.HTTPError:
        logger.warning("gateway_tts_upstream_unreachable", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TTS service unreachable",
        ) from None

    if upstream.status_code != 200:
        logger.warning(
            "gateway_tts_upstream_error",
            status=upstream.status_code,
            body=upstream.text[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TTS synthesis failed",
        )

    logger.info(
        "gateway_tts_synthesized",
        agent_id=principal.agent_id,
        chars=len(speakable),
        voice=voice,
    )
    return Response(
        content=upstream.content,
        media_type=upstream.headers.get("content-type", "audio/mpeg"),
    )


@router.post("/stt")
async def gateway_stt(
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    redis: Annotated[Redis, Depends(get_redis)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    file: UploadFile = File(..., description="Audio file to transcribe"),
    language: str | None = Form(default=None),
    model: str | None = Form(default=None),
) -> dict[str, Any]:
    """Transcribe audio via suite STT (Amanuensis/Parakeet) for a gateway agent.

    Same upstream as ``POST /api/v1/stt``; auth is gateway key / agent JWT.
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_stt", fail_open=False)

    base = (settings.whisper_base_url or "").rstrip("/")
    if not base:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STT service not configured",
        )

    audio = await file.read()
    if not audio:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Empty audio payload",
        )
    if len(audio) > 25 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Audio exceeds 25 MB limit",
        )

    use_model = (model or settings.whisper_model or "whisper-1").strip()
    filename = file.filename or "audio.webm"
    content_type = (file.content_type or "application/octet-stream").split(";")[0]
    form_data: dict[str, Any] = {"model": use_model}
    if language:
        form_data["language"] = language.strip()

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.post(
                f"{base}/audio/transcriptions",
                data=form_data,
                files={"file": (filename, audio, content_type)},
            )
    except httpx.HTTPError:
        logger.warning("gateway_stt_upstream_unreachable", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="STT service unreachable",
        ) from None

    if upstream.status_code != 200:
        logger.warning(
            "gateway_stt_upstream_error",
            status=upstream.status_code,
            body=upstream.text[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="STT transcription failed",
        )

    try:
        body = upstream.json()
    except ValueError:
        body = {"text": upstream.text}

    logger.info(
        "gateway_stt_transcribed",
        agent_id=principal.agent_id,
        bytes=len(audio),
        chars=len((body.get("text") if isinstance(body, dict) else "") or ""),
    )
    if isinstance(body, dict):
        return body
    return {"text": str(body)}


@router.post("/rooms/{room}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def gateway_leave_room(
    room: str,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> None:
    """Remove the caller's agent identity from a room (clean bridge exit).

    Deletes the RoomMember row for ``brigade:{agent_id}``, clears any relay
    marker, and best-effort-evicts the LiveKit participant so the strip no
    longer shows a ghost agent after Claude Code / MCP disconnects.
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_leave", fail_open=True)
    room_obj = await _resolve_room(db, room)
    await _enforce_scope(db, principal, room_obj)

    pseudo_sub = f"brigade:{principal.agent_id}"
    agent_p = (
        await db.execute(select(Participant).where(Participant.keycloak_sub == pseudo_sub))
    ).scalar_one_or_none()
    if agent_p is not None:
        await db.execute(
            delete(RoomMember).where(
                RoomMember.room_id == room_obj.id,
                RoomMember.participant_id == agent_p.id,
            )
        )
        await db.commit()

    try:
        await clear_relay_pending(room_id=room_obj.id, agent_id=principal.agent_id)
    except Exception:
        logger.debug("gateway_leave_relay_clear_failed", exc_info=True)

    # Best-effort LiveKit eviction (identity patterns match remove_brigade_agent).
    try:
        for identity in (
            f"agent-{principal.agent_id}",
            f"agent-brigade-{principal.agent_id}",
            principal.agent_id,
        ):
            try:
                await livekit.remove_participant(
                    room_name=room_obj.livekit_room_name,
                    identity=identity,
                )
            except Exception:
                pass
    except Exception:
        logger.debug("gateway_leave_livekit_evict_failed", exc_info=True)

    logger.info(
        "gateway_left_room",
        agent_id=principal.agent_id,
        room=room_obj.livekit_room_name,
    )
    return None


@router.delete(
    "/rooms/{room}/brigade-agents/{brigade_agent_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def gateway_remove_brigade_agent(
    room: str,
    brigade_agent_id: str,
    principal: Annotated[GatewayPrincipal, Depends(authenticate_gateway_caller)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> None:
    """Kick a stuck Brigade agent from a room the caller is scoped to.

    Mirrors ``DELETE /api/v1/rooms/{room}/brigade-agents/{id}`` for MCP bridges
    that hold a gateway credential rather than a browser user JWT. The caller
    must be scoped to the room; they may remove any agent in that room
    (including themselves — prefer ``POST .../leave`` for self-exit).
    """
    await _gateway_rate_limit(principal, redis, bucket="gw_kick", fail_open=False)
    room_obj = await _resolve_room(db, room)
    await _enforce_scope(db, principal, room_obj)

    agent_id = (brigade_agent_id or "").strip()
    if not agent_id:
        raise HTTPException(status_code=422, detail="brigade_agent_id required")

    pseudo_sub = f"brigade:{agent_id}"
    agent_p = (
        await db.execute(
            select(Participant).where(
                Participant.keycloak_sub == pseudo_sub,
                Participant.participant_type == ParticipantType.AGENT,
            )
        )
    ).scalar_one_or_none()
    if agent_p is not None:
        await db.execute(
            delete(RoomMember).where(
                RoomMember.room_id == room_obj.id,
                RoomMember.participant_id == agent_p.id,
            )
        )
        await db.commit()

    try:
        await clear_relay_pending(room_id=room_obj.id, agent_id=agent_id)
    except Exception:
        logger.debug("gateway_kick_relay_clear_failed", exc_info=True)

    try:
        for identity in (
            f"agent-{agent_id}",
            f"agent-brigade-{agent_id}",
            agent_id,
        ):
            try:
                await livekit.remove_participant(
                    room_name=room_obj.livekit_room_name,
                    identity=identity,
                )
            except Exception:
                pass
    except Exception:
        logger.debug("gateway_kick_livekit_evict_failed", exc_info=True)

    logger.info(
        "gateway_removed_agent",
        by=principal.agent_id,
        removed=agent_id,
        room=room_obj.livekit_room_name,
    )
    return None


# ---------------------------------------------------------------------------
# Key administration (operator-only, gated by the internal bearer secret)
# ---------------------------------------------------------------------------


@router.post("/keys", status_code=201)
async def mint_gateway_key(
    body: MintKeyBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Mint a scoped gateway key. Operator-only (internal bearer secret).

    The raw key is returned ONCE; only its SHA-256 hash is stored.
    """
    verify_key_admin_bearer(request)
    agent_id = slugify(body.agent_id)
    raw = f"{_KEY_PREFIXES[0]}{secrets.token_urlsafe(32)}"
    row = AgentGatewayKey(
        key_hash=hash_key(raw),
        key_prefix=raw[:12],
        agent_id=agent_id,
        label=body.label,
        allowed_rooms=body.allowed_rooms or ["*"],
        rate_limit_rpm=body.rate_limit_rpm,
        created_by=(request.headers.get("X-Operator") or "operator"),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("gateway_key_minted", agent_id=agent_id, key_id=str(row.id))
    return {
        "id": str(row.id),
        "agent_id": agent_id,
        "key": raw,  # shown ONCE
        "key_prefix": row.key_prefix,
        "allowed_rooms": row.allowed_rooms,
        "rate_limit_rpm": row.rate_limit_rpm,
    }


@router.get("/keys")
async def list_gateway_keys(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """List key metadata (no secrets). Operator-only."""
    verify_key_admin_bearer(request)
    rows = (await db.execute(select(AgentGatewayKey))).scalars().all()
    return {
        "keys": [
            {
                "id": str(r.id),
                "agent_id": r.agent_id,
                "key_prefix": r.key_prefix,
                "label": r.label,
                "allowed_rooms": r.allowed_rooms,
                "rate_limit_rpm": r.rate_limit_rpm,
                "revoked": r.revoked_at is not None,
            }
            for r in rows
        ]
    }


@router.delete("/keys/{key_id}")
async def revoke_gateway_key(
    key_id: uuid.UUID,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Revoke a key (instant). Operator-only."""
    verify_key_admin_bearer(request)
    from datetime import datetime, timezone

    row = (
        await db.execute(select(AgentGatewayKey).where(AgentGatewayKey.id == key_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Key not found")
    row.revoked_at = datetime.now(timezone.utc)
    await db.commit()
    return {"id": str(key_id), "revoked": True}


@router.get("/health")
async def gateway_health() -> dict:
    """Public liveness for the gateway feature (no auth, no data)."""
    return {"gateway": "enabled" if _gateway_enabled() else "disabled"}
