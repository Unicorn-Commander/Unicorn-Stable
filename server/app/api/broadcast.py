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
credential. LiveKit has no server-side control for this (1.10 through 1.13):
only a track's own publisher can restrict who subscribes to it, and the server
cannot subscribe a participant that lacks ``can_subscribe``. See
docs/design/broadcast-links-v2-2026-10-04.md.

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
from urllib.parse import quote, urlencode
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

# ---------------------------------------------------------------------------
# RECORDER TOKENS — the composite-recording variant (design §8)
# ---------------------------------------------------------------------------
# A composite recording is a LiveKit room-composite egress whose headless
# Chrome renders OUR broadcast page, so the MP4 looks like the show feed. The
# page authenticates the only way it knows how — a broadcast token exchanged
# at /broadcast/join — so the egress gets a token of its own: same table, same
# hashing, same one-endpoint exposure, same subscribe-only + hidden grant, but
#   * ``participant_identity`` is ``*`` (the composite layout renders everyone),
#   * ``allow_audio`` is True (a recording without audio is not a recording),
#   * the TTL is bounded to the egress' maximum duration and the token is
#     revoked the moment the egress ends, and
#   * it is NOT a broadcast: it is left out of ``GET /broadcast/active`` —
#     the recording has its own, louder consent surface (``recording_state``
#     + the system message + the REC pill).
# The table has no ``kind`` column and this lane adds no migration; the kind is
# the (``created_by``, ``participant_identity``) pair below, which no
# user-facing mint can produce (``participant_identity="*"`` is refused).
RECORDER_IDENTITY = "*"
RECORDER_CREATED_BY = "system:recorder"
RECORDER_LABEL_PREFIX = "recorder:"
#: Query parameter carrying the recorder token on the composite template URL.
#: Deliberately NOT ``token``: the egress worker appends its own ``token``
#: (LiveKit JWT) to the URL and would clobber ours.
RECORDER_QUERY_PARAM = "rt"
#: Path segment the composite template lives at: /broadcast/{room}/composite.
RECORDER_PATH_SEGMENT = "composite"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def is_recorder_token(row: Any) -> bool:
    return (
        getattr(row, "created_by", None) == RECORDER_CREATED_BY
        and getattr(row, "participant_identity", None) == RECORDER_IDENTITY
    )


def recorder_label(egress_row_id: Any) -> str:
    return f"{RECORDER_LABEL_PREFIX}{egress_row_id}"


def recorder_grants(room_name: str) -> VideoGrants:
    """The composite egress grant, marked as a recorder by LiveKit."""
    return VideoGrants(
        room_join=True,
        room=room_name,
        can_publish=False,
        can_publish_data=False,
        can_subscribe=True,
        hidden=True,
        recorder=True,
    )


def broadcast_grants(room_name: str) -> VideoGrants:
    """The ordinary OBS/browser viewer grant; it is not a recorder."""
    return VideoGrants(
        room_join=True,
        room=room_name,
        can_publish=False,
        can_publish_data=False,
        can_subscribe=True,
        hidden=True,
        recorder=False,
    )


def composite_template_url(settings: Settings, room_id: Any, raw_token: str) -> str:
    """The ``custom_base_url`` handed to LiveKit for a composite egress.

    Carries a credential: never log it, never store it on a row. LiveKit
    appends ``url``, ``token`` and ``layout`` query params of its own.
    """
    base = (
        (settings.call_recording_composite_base_url or settings.public_base_url or "")
        .strip()
        .rstrip("/")
    )
    return (
        f"{base}/broadcast/{room_id}/{RECORDER_PATH_SEGMENT}"
        f"?{urlencode({RECORDER_QUERY_PARAM: raw_token})}"
    )


async def mint_recorder_token(
    db: AsyncSession,
    room: Room,
    *,
    egress_row_id: Any,
    ttl_seconds: int,
) -> tuple[str, BroadcastToken]:
    """Mint the egress' own broadcast token. Returns (raw, row); raw is
    returned ONCE, to be placed in the template URL, and never logged."""
    raw = f"sbt-{secrets.token_urlsafe(32)}"
    row = BroadcastToken(
        token_hash=hash_key(raw),
        token_prefix=raw[:12],
        room_id=room.id,
        participant_identity=RECORDER_IDENTITY,
        participant_label="recorder",
        allow_audio=True,
        label=recorder_label(egress_row_id),
        created_by=RECORDER_CREATED_BY,
        expires_at=_now() + timedelta(seconds=max(60, int(ttl_seconds))),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "recorder_token_minted",
        room=room.livekit_room_name,
        egress_row_id=str(egress_row_id),
        token_prefix=row.token_prefix,
        ttl_seconds=int(ttl_seconds),
    )
    return raw, row


async def revoke_recorder_tokens(
    db: AsyncSession,
    livekit: Any,
    *,
    egress_row_id: Any,
    room_name: str | None = None,
) -> int:
    """Revoke every recorder token minted for one egress row and evict its
    viewer. Idempotent; never raises (called from fail-open paths)."""
    revoked = 0
    try:
        rows = (
            await db.execute(
                select(BroadcastToken).where(
                    BroadcastToken.label == recorder_label(egress_row_id),
                    BroadcastToken.created_by == RECORDER_CREATED_BY,
                    BroadcastToken.revoked_at.is_(None),
                )
            )
        ).scalars().all()
        for row in rows:
            row.revoked_at = _now()
            revoked += 1
            if livekit is not None and room_name:
                await _evict_viewers(livekit, room_name, row.id)
        if rows:
            await db.commit()
            logger.info(
                "recorder_tokens_revoked",
                egress_row_id=str(egress_row_id),
                count=revoked,
            )
    except Exception:
        logger.warning(
            "recorder_token_revoke_failed", egress_row_id=str(egress_row_id), exc_info=True
        )
    return revoked


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
    # broadcast (OBS feed of one participant) | recorder (a composite egress'
    # own token — see RECORDER_* above).
    kind: str = "broadcast"


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
    # participant — render the one named participant (OBS feed).
    # composite   — render every publisher in the room (recorder token).
    mode: str = "participant"


def _viewer_identity_prefix(token_id: uuid.UUID) -> str:
    """Stable LiveKit identity prefix for every viewer of one token."""
    return f"broadcast-{token_id}"


def _viewer_identity_matches(identity: Any, token_id: uuid.UUID) -> bool:
    """Match only this token's identity or its per-join descendants."""
    if not isinstance(identity, str):
        return False
    prefix = _viewer_identity_prefix(token_id)
    return identity == prefix or identity.startswith(f"{prefix}-")


def _participant_identity(participant: Any) -> Any:
    identity = getattr(participant, "identity", None)
    if identity is None and isinstance(participant, dict):
        identity = participant.get("identity")
    return identity


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
        "kind": "recorder" if is_recorder_token(row) else "broadcast",
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
    if body.participant_identity.strip() == RECORDER_IDENTITY:
        # Reserved for the composite egress' own token (see RECORDER_*). A
        # user-minted "*" would masquerade as a recorder and drop out of the
        # ● Broadcasting consent surface.
        raise HTTPException(
            status_code=400, detail="participant_identity '*' is reserved"
        )
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
    # Percent-encode the identity: it is user-influenced (username_<uuid>), and a
    # username containing / ? or # would otherwise break or confuse the path.
    info["url_path"] = (
        f"/broadcast/{room.id}/{quote(body.participant_identity, safe='')}"
        f"?{urlencode({'token': raw})}"
    )
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
        await _evict_viewers(livekit, room.livekit_room_name, row.id)
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
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
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
    active_rows = [r for r in rows if not is_recorder_token(r)]
    viewer_counts: dict[Any, int | None] = {}
    if active_rows:
        try:
            info = await livekit.get_room(room_obj.livekit_room_name)
            participants = info.get("participants", []) if isinstance(info, dict) else []
            viewer_counts = {
                row.id: sum(
                    _viewer_identity_matches(_participant_identity(p), row.id)
                    for p in participants
                )
                for row in active_rows
            }
        except Exception:
            # The consent row remains useful during a LiveKit outage, but a
            # stale count would be more misleading than an explicit unknown.
            viewer_counts = {row.id: None for row in active_rows}

    return {
        "room_id": str(room_obj.id),
        "broadcasting": [
            {
                "participant_identity": r.participant_identity,
                "participant_label": r.participant_label,
                "allow_audio": r.allow_audio,
                "expires_at": r.expires_at.isoformat() if r.expires_at else None,
                "viewer_count": viewer_counts.get(r.id),
            }
            for r in active_rows
            # A recorder token is a RECORDING, not a broadcast; it announces
            # itself through recording_state (contract: this shape unchanged).
            # Serialize token rows, never LiveKit viewer identities: one token
            # is one consent/badge row even when several pages joined it.
        ],
    }


# ---------------------------------------------------------------------------
# Token-authenticated join (NO Keycloak session — this is the OBS path)
# ---------------------------------------------------------------------------


def _viewer_identity(token_id: uuid.UUID) -> str:
    """Per-join LiveKit identity under the token's stable prefix.

    A duplicate identity causes LiveKit to evict the older session
    (DUPLICATE_IDENTITY), so every POST /join gets its own 8-character random
    suffix while revocation matches the stable prefix.
    """
    return f"{_viewer_identity_prefix(token_id)}-{secrets.token_urlsafe(6)}"


async def _evict_viewers(livekit: Any, room_name: str, token_id: uuid.UUID) -> None:
    """Evict every current LiveKit viewer created from one broadcast token."""
    try:
        info = await livekit.get_room(room_name)
        participants = info.get("participants", []) if isinstance(info, dict) else []
    except Exception:
        # Revocation remains durable even if LiveKit is unavailable. A later
        # join is refused by the revoked row, and no raw credential is logged.
        logger.debug("broadcast_viewer_list_failed", exc_info=True)
        return

    for participant in participants:
        identity = _participant_identity(participant)
        if not _viewer_identity_matches(identity, token_id):
            continue
        try:
            await livekit.remove_participant(
                room_name=room_name,
                identity=identity,
            )
        except Exception:
            # One stale viewer must not prevent the other viewers from being
            # removed, and the database revocation already stands.
            logger.debug("broadcast_viewer_evict_failed", exc_info=True)


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
    # participant to the humans in the call. The recorder variant gets the
    # SAME grant — the egress' Chrome is a viewer like any OBS source.
    recorder = is_recorder_token(row)
    grants = (
        recorder_grants(room.livekit_room_name)
        if recorder
        else broadcast_grants(room.livekit_room_name)
    )
    # Never outlive the authorizing token.
    remaining = int((expires - _now()).total_seconds())
    ttl = max(60, min(LIVEKIT_TOKEN_MAX_TTL_S, remaining))

    lk_token = livekit.generate_token(
        room_name=room.livekit_room_name,
        identity=_viewer_identity(row.id),
        name="recorder" if recorder else f"broadcast:{row.participant_identity}",
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
        mode="composite" if recorder else "participant",
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
        "mode": "composite" if recorder else "participant",
    }


__all__ = [
    "router",
    "RECORDER_IDENTITY",
    "RECORDER_CREATED_BY",
    "RECORDER_QUERY_PARAM",
    "RECORDER_PATH_SEGMENT",
    "is_recorder_token",
    "recorder_grants",
    "broadcast_grants",
    "composite_template_url",
    "mint_recorder_token",
    "revoke_recorder_tokens",
]
