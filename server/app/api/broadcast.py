"""Broadcast feeds — OBS-ready, URL-addressable, single-participant video.

WHY THIS EXISTS
---------------
Stable's pop-out is a ``window.open`` CHILD DOCUMENT, not a URL. During the
2026-08-08 live show that forced OBS to screen-scrape browser windows, which
cost, repeatedly: guests vanishing from the stream when a pop-out was
reopened (macOS mints a new window id and OBS's binding orphans silently),
browser chrome baked into the broadcast, and ~6 OBS restarts because
ScreenCaptureKit only latches a window target at OBS startup.

A URL fixes the whole class: OBS browser sources re-fetch a URL on restart and
never orphan.

SECURITY POSTURE
----------------
A broadcast token renders a human being's live camera with NO login, so it is
treated as a credential, not a link:

* stored as SHA-256 only; raw value returned once at mint
* ``secrets.token_urlsafe(32)`` entropy
* scoped to ONE room + ONE participant identity
* short TTL (default 8h, capped 24h) + instant ``revoked_at`` revocation
* only the prefix is ever logged
* LiveKit grant is subscribe-only and hidden: ``can_publish=False``,
  ``can_publish_data=False``, ``can_subscribe=True``, ``hidden=True``

⚠️ RESIDUAL RISK, stated plainly: a LiveKit grant authorizes subscribe at ROOM
granularity. The page renders only the named participant, but that is a
client-side choice, NOT an enforcement boundary — a holder running their own
client could subscribe to other publishers in that room. Never describe a
broadcast link as "only shows that one person"; it is a room-scoped view
credential. Per-participant enforcement would require LiveKit's server-side
subscription-permission API.

CONSENT
-------
``hidden=True`` keeps the OBS feed from polluting the call UI — but combined
with a no-login URL it would mean a participant can be streamed with no
indication to them. For a product whose pitch is sovereignty, silent capture
is the wrong default even when the host is the one doing it. So
``GET /rooms/{room}/broadcasts/active`` exposes who currently has a live feed,
and the room UI renders a "● Broadcasting" indicator from it. The feed stays
invisible; the FACT of it does not.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from livekit.api import VideoGrants
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.gateway_auth import hash_key
from app.config import Settings
from app.deps import (
    _rate_limit_hit,
    get_current_user,
    get_db,
    get_livekit,
    get_redis,
    get_settings_dep,
    is_room_member,
)
from app.models.broadcast_token import BroadcastToken
from app.models.room import MemberRole, Room, RoomMember
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/broadcast", tags=["Broadcast"])

DEFAULT_TTL_HOURS = 8
MAX_TTL_HOURS = 24
# The LiveKit token must not outlive the broadcast token that authorized it,
# or revocation would leave a live feed running until the LiveKit TTL expired.
LIVEKIT_TOKEN_MAX_TTL_S = 3600


def _now() -> datetime:
    return datetime.now(timezone.utc)


class MintBroadcastBody(BaseModel):
    room: str = Field(..., description="room id, livekit_room_name, or slug")
    participant_identity: str = Field(..., min_length=1, max_length=255)
    participant_label: str | None = None
    ttl_hours: int = Field(DEFAULT_TTL_HOURS, ge=1, le=MAX_TTL_HOURS)
    allow_audio: bool = False
    label: str | None = None


class BroadcastTokenInfo(BaseModel):
    id: uuid.UUID
    room_id: uuid.UUID
    participant_identity: str
    participant_label: str | None
    token_prefix: str
    allow_audio: bool
    label: str | None
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    last_used_at: datetime | None
    active: bool


class MintBroadcastResponse(BroadcastTokenInfo):
    # Returned ONCE at mint; never stored, never logged.
    token: str
    url_path: str


class BroadcastJoinResponse(BaseModel):
    livekit_url: str
    token: str
    room_name: str
    participant_identity: str
    participant_label: str | None
    allow_audio: bool
    expires_at: datetime


async def _resolve_room(db: AsyncSession, ref: str) -> Room:
    """Resolve a room by id, livekit_room_name, or slug (mirrors tokens.py)."""
    conditions = (Room.livekit_room_name == ref) | (Room.name == ref)
    try:
        conditions = conditions | (Room.id == uuid.UUID(str(ref)))
    except (ValueError, AttributeError, TypeError):
        pass  # not a UUID — slug/livekit-name lookup only
    room = (await db.execute(select(Room).where(conditions))).scalars().first()
    if room is None:
        raise HTTPException(status_code=404, detail=f"Room not found: {ref}")
    return room


async def _require_room_owner(
    db: AsyncSession, room: Room, user: dict[str, Any]
) -> None:
    """Minting a feed of someone else's camera is an OWNER-level act.

    Membership alone is deliberately not enough: any member could otherwise
    mint a no-login URL to any other member's video.
    """
    participant_id = user["participant_id"]
    member = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == participant_id,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=403, detail="Not authorized: you must be a member of this room"
        )
    if member.role != MemberRole.OWNER:
        raise HTTPException(
            status_code=403,
            detail="Only the room owner may mint or revoke broadcast feeds",
        )


def _to_info(row: BroadcastToken) -> dict[str, Any]:
    now = _now()
    expires = row.expires_at
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return {
        "id": row.id,
        "room_id": row.room_id,
        "participant_identity": row.participant_identity,
        "participant_label": row.participant_label,
        "token_prefix": row.token_prefix,
        "allow_audio": row.allow_audio,
        "label": row.label,
        "created_at": row.created_at,
        "expires_at": row.expires_at,
        "revoked_at": row.revoked_at,
        "last_used_at": row.last_used_at,
        "active": row.revoked_at is None and expires is not None and expires > now,
    }


# ---------------------------------------------------------------------------
# Owner-authenticated management (normal Keycloak session)
# ---------------------------------------------------------------------------


@router.post("/tokens", response_model=MintBroadcastResponse, status_code=201)
async def mint_broadcast_token(
    body: MintBroadcastBody,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Any:
    """Mint a broadcast feed URL for one participant. Room OWNER only."""
    room = await _resolve_room(db, body.room)
    await _require_room_owner(db, room, user)

    raw = f"sbt-{secrets.token_urlsafe(32)}"
    row = BroadcastToken(
        token_hash=hash_key(raw),
        token_prefix=raw[:12],
        room_id=room.id,
        participant_identity=body.participant_identity,
        participant_label=body.participant_label,
        allow_audio=bool(body.allow_audio),
        label=body.label,
        created_by=str(user.get("sub") or user.get("username") or "owner"),
        expires_at=_now() + timedelta(hours=body.ttl_hours),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    logger.info(
        "broadcast_token_minted",
        room=room.livekit_room_name,
        participant=body.participant_identity,
        token_prefix=row.token_prefix,  # prefix only — never the raw token
        ttl_hours=body.ttl_hours,
        allow_audio=row.allow_audio,
    )
    info = _to_info(row)
    info["token"] = raw
    info["url_path"] = f"/broadcast/{room.id}/{body.participant_identity}?token={raw}"
    return info


@router.get("/tokens", response_model=list[BroadcastTokenInfo])
async def list_broadcast_tokens(
    room: str,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Any:
    """List a room's broadcast tokens (metadata only — never the raw token)."""
    room_obj = await _resolve_room(db, room)
    await _require_room_owner(db, room_obj, user)
    rows = (
        await db.execute(
            select(BroadcastToken)
            .where(BroadcastToken.room_id == room_obj.id)
            .order_by(BroadcastToken.created_at.desc())
        )
    ).scalars().all()
    return [_to_info(r) for r in rows]


@router.delete("/tokens/{token_id}")
async def revoke_broadcast_token(
    token_id: uuid.UUID,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> dict:
    """Revoke instantly AND evict the live viewer, so a revoked link stops
    showing video now rather than when its LiveKit token expires."""
    row = (
        await db.execute(select(BroadcastToken).where(BroadcastToken.id == token_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Broadcast token not found")

    room = (
        await db.execute(select(Room).where(Room.id == row.room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    await _require_room_owner(db, room, user)

    if row.revoked_at is None:
        row.revoked_at = _now()
        await db.commit()

    try:
        await livekit.remove_participant(
            room_name=room.livekit_room_name,
            identity=_viewer_identity(row.id),
        )
    except Exception:
        # The viewer may not be connected; revocation already stands.
        logger.debug("broadcast_viewer_evict_failed", exc_info=True)

    logger.info(
        "broadcast_token_revoked", token_prefix=row.token_prefix, room=room.livekit_room_name
    )
    return {"id": str(token_id), "revoked": True}


@router.get("/active")
async def list_active_broadcasts(
    room: str,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Who currently has a live broadcast feed in this room.

    THE CONSENT SURFACE: any MEMBER (not just the owner) may read this, because
    its purpose is to tell people they are being streamed. The room UI renders
    a "● Broadcasting" indicator from it.
    """
    room_obj = await _resolve_room(db, room)
    if not await is_room_member(db, room_obj.id, user["participant_id"]):
        raise HTTPException(
            status_code=403, detail="Not authorized: you must be a member of this room"
        )
    now = _now()
    rows = (
        await db.execute(
            select(BroadcastToken).where(
                BroadcastToken.room_id == room_obj.id,
                BroadcastToken.revoked_at.is_(None),
                BroadcastToken.expires_at > now,
            )
        )
    ).scalars().all()
    return {
        "room_id": str(room_obj.id),
        "broadcasting": [
            {
                "participant_identity": r.participant_identity,
                "participant_label": r.participant_label,
                "allow_audio": r.allow_audio,
                "expires_at": r.expires_at.isoformat() if r.expires_at else None,
            }
            for r in rows
        ],
    }


# ---------------------------------------------------------------------------
# Token-authenticated join (NO Keycloak session — this is the OBS path)
# ---------------------------------------------------------------------------


def _viewer_identity(token_id: uuid.UUID) -> str:
    """Per-token LiveKit identity.

    Unique per token because a duplicate identity causes LiveKit to evict the
    older session (DUPLICATE_IDENTITY) — two OBS sources on the same feed would
    otherwise silently kill each other.
    """
    return f"broadcast-{token_id}"


@router.post("/join", response_model=BroadcastJoinResponse)
async def broadcast_join(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    redis: Annotated[Any, Depends(get_redis)] = None,
) -> Any:
    """Exchange a broadcast token for a short-lived subscribe-only LiveKit token.

    Deliberately NOT behind ``get_current_user``: the OBS browser source has no
    Keycloak session. Equally deliberately, this is the ONLY endpoint that
    accepts a broadcast token — every other route still requires a real user,
    so a stolen broadcast token cannot reach anything else in the API.
    """
    auth = request.headers.get("Authorization") or ""
    raw = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
    if not raw:
        body = {}
        try:
            body = await request.json()
        except Exception:
            body = {}
        raw = (body or {}).get("token") or ""
    raw = (raw or "").strip()
    if not raw:
        raise HTTPException(status_code=401, detail="Missing broadcast token")

    # This endpoint is unauthenticated by design, so it is a brute-force target.
    # Rate-limit on the CLIENT, not the presented secret (keying on the secret
    # would let an attacker rotate guesses to get a fresh bucket each time).
    # deps.rate_limit() is unusable here: it hard-depends on get_current_user.
    if redis is not None:
        client_ip = (request.client.host if request.client else "unknown") or "unknown"
        await _rate_limit_hit(
            redis,
            bucket="broadcast_join",
            identifier=client_ip,
            limit=30,
            window_seconds=60,
            fail_open=True,
        )

    row = (
        await db.execute(
            select(BroadcastToken).where(BroadcastToken.token_hash == hash_key(raw))
        )
    ).scalar_one_or_none()

    # Uniform refusal: never distinguish unknown / revoked / expired to the
    # caller (that would turn the endpoint into a token oracle). Log the
    # distinction server-side instead.
    if row is None:
        logger.info("broadcast_join_denied", reason="unknown_token")
        raise HTTPException(status_code=403, detail="Broadcast link is not valid")
    expires = row.expires_at
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if row.revoked_at is not None:
        logger.info("broadcast_join_denied", reason="revoked", token_prefix=row.token_prefix)
        raise HTTPException(status_code=403, detail="Broadcast link is not valid")
    if expires is None or expires <= _now():
        logger.info("broadcast_join_denied", reason="expired", token_prefix=row.token_prefix)
        raise HTTPException(status_code=403, detail="Broadcast link is not valid")

    room = (
        await db.execute(select(Room).where(Room.id == row.room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # Subscribe-only + hidden: publishes nothing and never appears as a
    # participant to the humans in the call.
    grants = VideoGrants(
        room_join=True,
        room=room.livekit_room_name,
        can_publish=False,
        can_publish_data=False,
        can_subscribe=True,
        hidden=True,
    )
    # Never outlive the authorizing token.
    remaining = int((expires - _now()).total_seconds())
    ttl = max(60, min(LIVEKIT_TOKEN_MAX_TTL_S, remaining))

    lk_token = livekit.generate_token(
        room_name=room.livekit_room_name,
        identity=_viewer_identity(row.id),
        name=f"broadcast:{row.participant_identity}",
        grants=grants,
        ttl=ttl,
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret,
    )

    row.last_used_at = _now()
    await db.commit()

    logger.info(
        "broadcast_join",
        room=room.livekit_room_name,
        participant=row.participant_identity,
        token_prefix=row.token_prefix,
        ttl=ttl,
    )
    return {
        # Match tokens.py: the browser needs the PUBLIC ws url, not the
        # container-internal one.
        "livekit_url": settings.livekit_public_url or settings.livekit_url,
        "token": lk_token,
        "room_name": room.livekit_room_name,
        "participant_identity": row.participant_identity,
        "participant_label": row.participant_label,
        "allow_audio": row.allow_audio,
        "expires_at": expires,
    }


__all__ = ["router"]
