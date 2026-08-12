"""Guest access — invite mint/list/revoke (owner) + redemption (unauthenticated).

WHAT THIS IS
------------
A room owner mints an expiring, revocable, optionally passphrase-protected
link. An outsider with NO Unicorn Commander account redeems it and becomes an
ephemeral participant in EXACTLY ONE room, so a "Build In Public" show can have
outside guests on camera. It is an ACCESS MODE on a room. It does not change
what Unicorn Stable is.

WHAT A GUEST CAN REACH (the whole list)
---------------------------------------
* ``GET/POST /rooms/{room}/messages`` — their room only
* ``GET /rooms/{room}/members``       — their room only
* ``POST /tokens/livekit``            — their room only, ``can_publish`` from
                                        the invite
* ``GET /ws``                         — subscribed to their room only
* ``GET /guest/me``, ``POST /guest/leave``

Everything else — the room list, the channel browser, BOTH message-search
endpoints, agents, knowledge, uploads, admin, entitlements, gateway keys, and
every Keycloak/suite/federation surface — is unreachable because those routes
depend on ``deps.get_current_user``, which refuses a guest credential by name.
Nothing was added to them. See the long comment in ``app/deps.py``.

WHAT AN INVITE DECIDES, PER LINK
--------------------------------
Three widenings live on the invite row, and all three default to the closed
answer, so the least-typing invite is the safest one:

* ``allow_agent_trigger`` — may this guest's message make the room's agent
  answer? Off: an auto-reply hands an outsider the prompt of an agent holding
  the room's knowledge, tools, and budget.
* ``allow_mention_email`` — may this guest's @mention send mail from our
  domain? Off: that is the one guest action whose blast radius leaves the room.
* ``history_from`` — how far back may they READ? Defaults to the moment the
  link was minted, so an invite to today's call is not retroactive access to
  the channel's whole past. Enforced in the messages read path.

THE ORACLE RULES
----------------
``POST /guest/redeem`` is the only unauthenticated endpoint here, so it is the
only brute-force target, and it is written to leak nothing:

* unknown token, revoked invite, expired invite, exhausted invite, and WRONG
  PASSPHRASE all return the identical 403 body;
* the unknown-token path burns the same PBKDF2 time a real passphrase check
  costs, so the responses are indistinguishable by latency too;
* it is rate-limited on the CLIENT IP, never on the presented secret (keying on
  the secret would hand an attacker a fresh bucket per guess);
* only the token PREFIX is ever logged, never the raw value.

The server-side log DOES record which check failed — operators need that; the
caller does not get it.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from redis.asyncio import Redis
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.tokens import livekit_identity
from app.auth.gateway_auth import hash_key
from app.auth.guest_auth import (
    burn_passphrase_time,
    clean_display_name,
    hash_passphrase,
    mint_invite_token,
    mint_session_token,
    new_guest_identity,
    verify_passphrase,
)
from app.config import Settings
from app.deps import (
    _rate_limit_hit,
    get_current_user,
    get_db,
    get_livekit,
    get_redis,
    get_settings_dep,
    require_guest,
)
from app.models.guest_access import GuestInvite, GuestSession
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import MemberRole, Room, RoomMember
from app.services.livekit_service import LiveKitService
from app.ws.handler import publish_force_disconnect

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["Guests"])

# One uniform refusal for every redemption failure. Do not add detail to this
# string, and do not add a second variant — the whole point is that "no such
# link", "revoked", "expired", "full", and "wrong passphrase" are one answer.
INVALID_LINK_DETAIL = "This guest link is not valid."

# The floor stored when an owner explicitly asks for the room's WHOLE
# back-history. A concrete timestamp rather than NULL on purpose: a nullable
# "no limit" column fails OPEN for any row written by a path that forgets it,
# whereas this column is NOT NULL with a restrictive server default and the
# permissive value has to be written deliberately.
_FULL_HISTORY_FLOOR = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class MintInviteBody(BaseModel):
    ttl_hours: int | None = Field(
        None, ge=1, description="Invite lifetime; defaults to the server setting."
    )
    passphrase: str | None = Field(
        None,
        min_length=4,
        max_length=128,
        description="Optional second factor the guest must type. Hashed at rest.",
    )
    # A guest is a guest ON the show, so A/V is the default. False mints a
    # watch-only guest, which is the right choice for a widely-shared link.
    can_publish: bool = True
    max_uses: int | None = Field(
        None, ge=1, le=500, description="NULL = unlimited redemptions."
    )
    label: str | None = Field(None, max_length=255)

    # -- Per-invite opt-ins. Both OFF unless the owner says otherwise. --
    allow_agent_trigger: bool = Field(
        False,
        description=(
            "Let a guest's message trigger the room's agent. OFF by default: "
            "an auto-reply makes an outsider's text the prompt for an agent "
            "holding this room's knowledge, tools, and paid budget."
        ),
    )
    allow_mention_email: bool = Field(
        False,
        description=(
            "Let a guest's @mention send mention emails. OFF by default: that "
            "puts a guest-chosen name and body into HTML sent from our domain."
        ),
    )

    # -- Readable history window. Restrictive unless widened. --
    history_hours: int | None = Field(
        None,
        ge=0,
        le=8760,
        description=(
            "How far back before this link was minted a guest may read. "
            "Omitted/0 = nothing said before the invite existed."
        ),
    )
    history_all: bool = Field(
        False,
        description=(
            "Hand over the room's ENTIRE back-history. Must be asked for "
            "explicitly; overrides history_hours."
        ),
    )


class GuestInviteInfo(BaseModel):
    id: uuid.UUID
    room_id: uuid.UUID
    token_prefix: str
    has_passphrase: bool
    can_publish: bool
    max_uses: int | None
    use_count: int
    label: str | None
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    last_used_at: datetime | None
    active: bool
    # What this link actually grants, echoed back so an owner reviewing a list
    # of links can SEE which ones are wider than the default rather than having
    # to remember what they ticked.
    allow_agent_trigger: bool
    allow_mention_email: bool
    history_from: datetime


class MintInviteResponse(GuestInviteInfo):
    # Returned ONCE at mint. Never stored, never logged, never retrievable.
    token: str
    url_path: str


class RedeemBody(BaseModel):
    token: str = Field(..., min_length=8, max_length=200)
    display_name: str | None = Field(None, max_length=200)
    passphrase: str | None = Field(None, max_length=128)


class RedeemResponse(BaseModel):
    # The guest's API credential. Returned once; the browser holds it.
    session_token: str
    session_id: uuid.UUID
    participant_id: uuid.UUID
    display_name: str
    room_id: uuid.UUID
    room_display_name: str
    can_publish: bool
    expires_at: datetime
    # ADDITIVE, and advisory only. The server enforces all three; these are
    # here so the client can render honestly — stop paging at the boundary and
    # show "history starts here" instead of an infinite spinner, and not offer
    # an "ask the agent" affordance that the server will silently ignore.
    history_from: datetime
    allow_agent_trigger: bool
    allow_mention_email: bool


class GuestMe(BaseModel):
    """A guest's view of itself. Deliberately the ONLY 'who am I' a guest gets:
    it carries the one room they belong to, so the client never needs the room
    list or a room-detail route to render the session."""

    session_id: uuid.UUID
    participant_id: uuid.UUID
    username: str
    display_name: str
    room_id: uuid.UUID
    room_display_name: str
    can_publish: bool
    expires_at: datetime
    # Same additive advisory fields as RedeemResponse, so a client that
    # reconnects (or reloads) re-learns its boundary without keeping the
    # redeem response around.
    history_from: datetime
    allow_agent_trigger: bool
    allow_mention_email: bool


class GuestSessionInfo(BaseModel):
    id: uuid.UUID
    invite_id: uuid.UUID
    participant_id: uuid.UUID
    display_name: str
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    last_seen_at: datetime | None
    active: bool


# ---------------------------------------------------------------------------
# Owner authorization
# ---------------------------------------------------------------------------


async def _require_room_owner(
    db: AsyncSession, room_id: uuid.UUID, user: dict[str, Any]
) -> Room:
    """Only a room OWNER may mint, list, or revoke guest access.

    Membership is deliberately not enough. A guest link lets a stranger into
    the room with camera and microphone and read access to its whole history;
    any member being able to mint one would make every member a de-facto
    admin of the room's confidentiality. Mirrors ``broadcast._require_room_owner``.
    """
    room = (
        await db.execute(select(Room).where(Room.id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    member = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.participant_id == user["participant_id"],
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
            detail="Only the room owner may manage guest access",
        )
    return room


def _require_enabled(settings: Settings) -> None:
    if not settings.guest_access_enabled:
        # Behave as if the feature does not exist rather than advertising a
        # disabled surface.
        raise HTTPException(status_code=404, detail="Not found")


def _invite_info(row: GuestInvite) -> dict[str, Any]:
    expires = _aware(row.expires_at)
    return {
        "id": row.id,
        "room_id": row.room_id,
        "token_prefix": row.token_prefix,
        "has_passphrase": row.passphrase_hash is not None,
        "can_publish": bool(row.can_publish),
        "max_uses": row.max_uses,
        "use_count": int(row.use_count or 0),
        "label": row.label,
        "created_at": row.created_at,
        "expires_at": row.expires_at,
        "revoked_at": row.revoked_at,
        "last_used_at": row.last_used_at,
        "allow_agent_trigger": bool(getattr(row, "allow_agent_trigger", False)),
        "allow_mention_email": bool(getattr(row, "allow_mention_email", False)),
        "history_from": getattr(row, "history_from", None) or row.created_at,
        "active": row.revoked_at is None
        and expires is not None
        and expires > _now()
        and (row.max_uses is None or int(row.use_count or 0) < row.max_uses),
    }


def _session_info(row: GuestSession) -> dict[str, Any]:
    expires = _aware(row.expires_at)
    return {
        "id": row.id,
        "invite_id": row.invite_id,
        "participant_id": row.participant_id,
        "display_name": row.display_name,
        "created_at": row.created_at,
        "expires_at": row.expires_at,
        "revoked_at": row.revoked_at,
        "last_seen_at": row.last_seen_at,
        "active": row.revoked_at is None and expires is not None and expires > _now(),
    }


# ---------------------------------------------------------------------------
# Owner surface (ordinary Keycloak session)
# ---------------------------------------------------------------------------


@router.post(
    "/rooms/{room_id}/guest-invites",
    response_model=MintInviteResponse,
    status_code=201,
)
async def mint_guest_invite(
    room_id: uuid.UUID,
    body: MintInviteBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> Any:
    """Mint a guest invite link for this room. Room OWNER only."""
    _require_enabled(settings)
    await _require_room_owner(db, room_id, user)

    ttl_hours = int(body.ttl_hours or settings.guest_invite_default_ttl_hours)
    if ttl_hours > settings.guest_invite_max_ttl_hours:
        raise HTTPException(
            status_code=400,
            detail=(
                "Guest links may live at most "
                f"{settings.guest_invite_max_ttl_hours} hours"
            ),
        )

    # THE HISTORY FLOOR. Default: the moment the link is minted, so an invite
    # to today's call carries today's call and not the eight months of channel
    # history that happened to precede it. Widening is an explicit act by the
    # owner, recorded on the row, and visible in the invite list afterwards.
    minted_at = _now()
    if body.history_all:
        history_from = _FULL_HISTORY_FLOOR
    else:
        history_from = minted_at - timedelta(hours=int(body.history_hours or 0))

    raw = mint_invite_token()
    passphrase = (body.passphrase or "").strip() or None
    row = GuestInvite(
        token_hash=hash_key(raw),
        token_prefix=raw[:12],
        room_id=room_id,
        passphrase_hash=hash_passphrase(passphrase) if passphrase else None,
        can_publish=bool(body.can_publish),
        allow_agent_trigger=bool(body.allow_agent_trigger),
        allow_mention_email=bool(body.allow_mention_email),
        history_from=history_from,
        max_uses=body.max_uses,
        label=body.label,
        created_by=user["participant_id"],
        expires_at=minted_at + timedelta(hours=ttl_hours),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    logger.info(
        "guest_invite_minted",
        room_id=str(room_id),
        token_prefix=row.token_prefix,  # prefix only — never the raw token
        ttl_hours=ttl_hours,
        has_passphrase=passphrase is not None,
        can_publish=row.can_publish,
        max_uses=row.max_uses,
        # Log the WIDENINGS explicitly. These are the three ways one invite is
        # more permissive than another, and an operator reading the log after
        # the fact should not have to go and read the row to find out.
        allow_agent_trigger=bool(row.allow_agent_trigger),
        allow_mention_email=bool(row.allow_mention_email),
        history_all=bool(body.history_all),
        history_hours=int(body.history_hours or 0),
    )
    info = _invite_info(row)
    info["token"] = raw
    # `p=1` is a pure UX hint so the landing page can render the passphrase
    # field up front. It is NOT authorization and carries no secret: a forged
    # or missing flag changes nothing about what redemption accepts.
    info["url_path"] = f"/guest/{raw}" + ("?p=1" if passphrase else "")
    return info


@router.get("/rooms/{room_id}/guest-invites", response_model=list[GuestInviteInfo])
async def list_guest_invites(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> Any:
    """List this room's guest invites (metadata only — never the raw token)."""
    _require_enabled(settings)
    await _require_room_owner(db, room_id, user)
    rows = (
        (
            await db.execute(
                select(GuestInvite)
                .where(GuestInvite.room_id == room_id)
                .order_by(GuestInvite.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [_invite_info(r) for r in rows]


@router.get(
    "/rooms/{room_id}/guest-invites/{invite_id}/sessions",
    response_model=list[GuestSessionInfo],
)
async def list_guest_sessions(
    room_id: uuid.UUID,
    invite_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> Any:
    """Who has actually redeemed this link. Room OWNER only."""
    _require_enabled(settings)
    await _require_room_owner(db, room_id, user)
    rows = (
        (
            await db.execute(
                select(GuestSession)
                .where(
                    GuestSession.invite_id == invite_id,
                    # Scope to the room the caller proved ownership of, so an
                    # invite id from another room cannot be read through here.
                    GuestSession.room_id == room_id,
                )
                .order_by(GuestSession.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [_session_info(r) for r in rows]


async def _terminate_sessions(
    db: AsyncSession,
    redis: Redis,
    livekit: LiveKitService,
    room: Room,
    sessions: list[GuestSession],
    *,
    reason: str,
) -> int:
    """Revoke guest sessions and make it TRUE RIGHT NOW, in four layers.

    1. ``revoked_at`` on the row — the authoritative check. Every subsequent
       HTTP request and every new socket fails on it, so this alone is correct
       even if all three fast paths below fail.
    2. Delete the ``room_members`` row — cuts the guest out of the roster and,
       independently, makes the websocket's 4-second membership re-derivation
       drop the room.
    3. ``publish_force_disconnect`` — the primitive added in ws/handler.py for
       exactly this. Without it there was NO way to hang up on a live socket:
       ``room_revoked`` only unsubscribes a channel, and the actual close lives
       in the endpoint's ``finally``. This makes the browser see the session end
       immediately instead of sitting on a silent connection.
    4. LiveKit eviction — a revoked guest must stop publishing video now, not
       when their LiveKit token expires.

    Layers 2-4 are best-effort; layer 1 is committed first so a failure in any
    of them cannot leave a live credential behind.
    """
    if not sessions:
        return 0

    now = _now()
    for s in sessions:
        s.revoked_at = now
    participant_ids = [s.participant_id for s in sessions]
    await db.execute(
        delete(RoomMember).where(
            RoomMember.room_id == room.id,
            RoomMember.participant_id.in_(participant_ids),
        )
    )
    await db.commit()

    participants = (
        (
            await db.execute(
                select(Participant).where(Participant.id.in_(participant_ids))
            )
        )
        .scalars()
        .all()
    )
    by_id = {str(p.id): p for p in participants}

    for s in sessions:
        pid = str(s.participant_id)
        # Legacy room-revocation signal too: an older client build reacts to
        # this by hiding the room even if it ignores `session_ended`.
        try:
            await redis.publish(
                f"user:{pid}",
                json.dumps({"type": "room_revoked", "room_id": str(room.id)}),
            )
        except Exception:
            logger.warning("guest_room_revoked_fanout_failed", exc_info=True)
        await publish_force_disconnect(redis, pid, reason=reason)

        participant = by_id.get(pid)
        if participant is not None:
            try:
                await livekit.remove_participant(
                    room_name=room.livekit_room_name,
                    identity=livekit_identity(participant.username, participant.id),
                )
            except Exception:
                # Usually "not connected". Revocation already stands.
                logger.debug("guest_livekit_evict_failed", exc_info=True)

    # Tell the room its roster changed so the member list stops showing them.
    try:
        from app.api.rooms import _broadcast_members_changed

        for pid in participant_ids:
            await _broadcast_members_changed(
                db, room.id, removed_participant_id=str(pid)
            )
    except Exception:
        logger.warning("guest_members_changed_fanout_failed", exc_info=True)

    logger.info(
        "guest_sessions_terminated",
        room_id=str(room.id),
        count=len(sessions),
        reason=reason,
    )
    return len(sessions)


@router.delete("/rooms/{room_id}/guest-invites/{invite_id}")
async def revoke_guest_invite(
    room_id: uuid.UUID,
    invite_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> dict:
    """Kill the link AND everyone who used it. Room OWNER only.

    "Revoked" here means revoked: the invite stops redeeming, every live guest
    from it is disconnected and evicted from the call, and their credentials
    stop authenticating on the next request. See ``_terminate_sessions``.
    """
    _require_enabled(settings)
    room = await _require_room_owner(db, room_id, user)

    invite = (
        await db.execute(
            select(GuestInvite).where(
                GuestInvite.id == invite_id,
                # Scoped to the room the caller owns — an invite id belonging
                # to another room is a 404 here, not someone else's to revoke.
                GuestInvite.room_id == room_id,
            )
        )
    ).scalar_one_or_none()
    if invite is None:
        raise HTTPException(status_code=404, detail="Guest invite not found")

    if invite.revoked_at is None:
        invite.revoked_at = _now()
    sessions = (
        (
            await db.execute(
                select(GuestSession).where(
                    GuestSession.invite_id == invite.id,
                    GuestSession.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    await db.commit()

    disconnected = await _terminate_sessions(
        db, redis, livekit, room, list(sessions), reason="guest_invite_revoked"
    )
    logger.info(
        "guest_invite_revoked",
        room_id=str(room_id),
        token_prefix=invite.token_prefix,
        sessions_terminated=disconnected,
    )
    return {
        "id": str(invite_id),
        "revoked": True,
        "sessions_terminated": disconnected,
    }


@router.delete("/rooms/{room_id}/guest-sessions/{session_id}")
async def revoke_guest_session(
    room_id: uuid.UUID,
    session_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> dict:
    """Boot ONE guest without killing the link for everyone else.

    The live-show case: one person misbehaves, the other three guests stay on
    air. (The softer option already exists — mute the guest's room_member row
    and they can read but not post.)
    """
    _require_enabled(settings)
    room = await _require_room_owner(db, room_id, user)

    session = (
        await db.execute(
            select(GuestSession).where(
                GuestSession.id == session_id,
                GuestSession.room_id == room_id,
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Guest session not found")
    if session.revoked_at is not None:
        return {"id": str(session_id), "revoked": True, "sessions_terminated": 0}

    disconnected = await _terminate_sessions(
        db, redis, livekit, room, [session], reason="guest_session_revoked"
    )
    return {
        "id": str(session_id),
        "revoked": True,
        "sessions_terminated": disconnected,
    }


# ---------------------------------------------------------------------------
# Redemption — the ONE unauthenticated endpoint
# ---------------------------------------------------------------------------


@router.post("/guest/redeem", response_model=RedeemResponse)
async def redeem_guest_invite(
    body: RedeemBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    redis: Annotated[Redis, Depends(get_redis)] = None,
) -> Any:
    """Exchange an invite link for a room-scoped guest session.

    Deliberately NOT behind ``get_current_user``: the whole point is that the
    caller has no account. Equally deliberately, this is the ONLY endpoint that
    accepts an invite token — every other route still requires a real user or a
    guest SESSION, so a leaked invite link buys exactly one thing: becoming a
    guest of one room.

    NOTHING here comes from Keycloak. No realm user is created, no IdP is
    brokered, no entitlement is read. (The internal realm brokers the customer
    realm with ``idp-create-user-if-unique`` set to ALTERNATIVE and
    ``trust_email=true``, so any OIDC path would SILENTLY mint a real suite
    account for a stranger. This path cannot, because it never touches it.)
    """
    _require_enabled(settings)
    raw = (body.token or "").strip()

    # Unauthenticated brute-force target → rate limit on the CLIENT, never on
    # the presented secret (an attacker rotating guesses would otherwise get a
    # fresh bucket every time). deps.rate_limit() is unusable here: it
    # hard-depends on get_current_user.
    #
    # NEVER FAILS OPEN — but no longer fails all the way closed either.
    #
    # This was `fail_open=False` alone, i.e. a Redis blip returned 503 to every
    # would-be guest. That is the wrong shape of failure for this endpoint: the
    # people it locks out are the invited guests of a live show, and the thing
    # it protects against (offline brute force of an invite token) is not made
    # meaningfully likelier by a few minutes of a coarser limiter. So it now
    # degrades to the in-process limiter in deps.py — still limited, just
    # per-worker and fixed-window instead of shared and weighted — and only
    # returns 503 if even that cannot account for the caller.
    #
    # `fail_open=False` stays exactly as it was: the fallback is an ADDITIONAL
    # answer, not permission to skip the check.
    if redis is not None and settings.rate_limit_enabled:
        client_ip = (request.client.host if request.client else "unknown") or "unknown"
        await _rate_limit_hit(
            redis,
            bucket="guest_redeem",
            identifier=client_ip,
            limit=int(settings.rate_limit_guest_redeem_per_min or 10),
            window_seconds=60,
            fail_open=False,
            local_fallback=True,
        )

    supplied_passphrase = body.passphrase or ""
    invite = (
        await db.execute(
            select(GuestInvite).where(GuestInvite.token_hash == hash_key(raw))
        )
    ).scalar_one_or_none()

    if invite is None:
        # Burn the same PBKDF2 time a real passphrase check would, so an
        # observer cannot tell "no such token" from "wrong passphrase" by
        # latency any more than by response body.
        burn_passphrase_time(supplied_passphrase)
        logger.info("guest_redeem_denied", reason="unknown_token")
        raise HTTPException(status_code=403, detail=INVALID_LINK_DETAIL)

    expires = _aware(invite.expires_at)
    if invite.revoked_at is not None:
        burn_passphrase_time(supplied_passphrase)
        logger.info(
            "guest_redeem_denied", reason="revoked", token_prefix=invite.token_prefix
        )
        raise HTTPException(status_code=403, detail=INVALID_LINK_DETAIL)
    if expires is None or expires <= _now():
        # A clean refusal, not a stack trace: an expired link is the single
        # most common thing that will happen to this endpoint in real life.
        burn_passphrase_time(supplied_passphrase)
        logger.info(
            "guest_redeem_denied", reason="expired", token_prefix=invite.token_prefix
        )
        raise HTTPException(status_code=403, detail=INVALID_LINK_DETAIL)

    if invite.passphrase_hash is not None:
        if not verify_passphrase(supplied_passphrase, invite.passphrase_hash):
            logger.info(
                "guest_redeem_denied",
                reason="bad_passphrase",
                token_prefix=invite.token_prefix,
            )
            raise HTTPException(status_code=403, detail=INVALID_LINK_DETAIL)
    elif supplied_passphrase:
        # A passphrase offered to an invite that has none is IGNORED, not
        # refused. Refusing would reveal "this link needs no passphrase", which
        # is exactly the kind of thing the uniform-refusal rule exists to hide.
        burn_passphrase_time(supplied_passphrase)

    room = (
        await db.execute(select(Room).where(Room.id == invite.room_id))
    ).scalar_one_or_none()
    if room is None:
        logger.info(
            "guest_redeem_denied", reason="room_missing", token_prefix=invite.token_prefix
        )
        raise HTTPException(status_code=403, detail=INVALID_LINK_DETAIL)

    # Claim a seat ATOMICALLY. A read-then-write on use_count would let two
    # guests race through the last seat of a max_uses=1 link; the conditional
    # UPDATE makes the database the arbiter. It re-checks revocation and expiry
    # in the same statement, so a revoke landing mid-redemption also loses.
    claimed = (
        await db.execute(
            text(
                """
                UPDATE guest_invites
                   SET use_count = use_count + 1,
                       last_used_at = now()
                 WHERE id = :invite_id
                   AND revoked_at IS NULL
                   AND expires_at > now()
                   AND (max_uses IS NULL OR use_count < max_uses)
             RETURNING use_count
                """
            ),
            {"invite_id": invite.id},
        )
    ).scalar_one_or_none()
    if claimed is None:
        logger.info(
            "guest_redeem_denied",
            reason="exhausted_or_raced",
            token_prefix=invite.token_prefix,
        )
        raise HTTPException(status_code=403, detail=INVALID_LINK_DETAIL)

    # --- Mint the ephemeral identity ---------------------------------------
    #
    # Participant.keycloak_sub is unique + NOT NULL and a guest has no realm
    # identity, so it gets a synthetic "guest:<uuid>" sub — the same trick
    # already used by "brigade:<agent>" and "webhook:<name>". No migration and
    # no nullable change. participant_type is GUEST, which keeps this row out
    # of the instance-wide people directory, user search, mention emails, push
    # targeting, DM/group targets, and email-identity linking, all of which
    # filter on `== HUMAN`.
    display_name = clean_display_name(body.display_name)
    pseudo_sub, username = new_guest_identity()
    guest = Participant(
        keycloak_sub=pseudo_sub,
        username=username,
        display_name=display_name,
        participant_type=ParticipantType.GUEST,
        status=ParticipantStatus.ONLINE,
    )
    db.add(guest)
    await db.flush()

    db.add(
        RoomMember(
            room_id=room.id,
            participant_id=guest.id,
            # MemberRole.GUEST already existed in the enum and the PG type but
            # nothing ever assigned it. This is the slot it was carved for.
            role=MemberRole.GUEST,
        )
    )

    # A session never outlives its invite, and never runs longer than
    # guest_session_max_hours regardless — an abandoned tab must not hold room
    # access for the whole week a long-lived link is good for.
    session_expiry = min(
        expires, _now() + timedelta(hours=settings.guest_session_max_hours)
    )
    session_raw = mint_session_token()
    session = GuestSession(
        token_hash=hash_key(session_raw),
        token_prefix=session_raw[:12],
        invite_id=invite.id,
        room_id=room.id,
        participant_id=guest.id,
        display_name=display_name,
        can_publish=bool(invite.can_publish),
        expires_at=session_expiry,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    logger.info(
        "guest_redeemed",
        room_id=str(room.id),
        token_prefix=invite.token_prefix,
        session_prefix=session.token_prefix,
        participant_id=str(guest.id),
        use_count=claimed,
    )

    try:
        from app.api.rooms import _broadcast_members_changed

        await _broadcast_members_changed(db, room.id)
    except Exception:
        logger.warning("guest_join_members_changed_failed", exc_info=True)

    return {
        "session_token": session_raw,
        "session_id": session.id,
        "participant_id": guest.id,
        "display_name": display_name,
        "room_id": room.id,
        "room_display_name": room.display_name or room.name,
        "can_publish": bool(invite.can_publish),
        "expires_at": session_expiry,
        # Advisory echo of what this invite grants. Enforcement is server-side
        # in api/messages.py; this only lets the client render the truth.
        "history_from": getattr(invite, "history_from", None) or invite.created_at,
        "allow_agent_trigger": bool(getattr(invite, "allow_agent_trigger", False)),
        "allow_mention_email": bool(getattr(invite, "allow_mention_email", False)),
    }


# ---------------------------------------------------------------------------
# Guest self-service
# ---------------------------------------------------------------------------


@router.get("/guest/me", response_model=GuestMe)
async def get_guest_me(
    user: Annotated[dict[str, Any], Depends(require_guest)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Any:
    """The guest's own record, plus the one room it is scoped to.

    This exists so a guest client never needs ``GET /rooms`` or
    ``GET /rooms/{id}`` to render its session — both of those stay member-only.
    """
    room = (
        await db.execute(select(Room).where(Room.id == user["guest_room_id"]))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return {
        "session_id": user["guest_session_id"],
        "participant_id": user["participant_id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "room_id": room.id,
        "room_display_name": room.display_name or room.name,
        "can_publish": bool(user.get("guest_can_publish")),
        "expires_at": user["guest_expires_at"],
        # These come off the principal, which re-read the invite on THIS
        # request — so a grant the owner just turned off is already gone here.
        "history_from": user.get("guest_history_from") or _now(),
        "allow_agent_trigger": bool(user.get("guest_allow_agent_trigger")),
        "allow_mention_email": bool(user.get("guest_allow_mention_email")),
    }


@router.post("/guest/leave", status_code=204)
async def leave_as_guest(
    user: Annotated[dict[str, Any], Depends(require_guest)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> None:
    """End your own guest session.

    Same teardown as an owner revoking you, so "I'm done" leaves nothing live
    behind — no credential, no membership row, no LiveKit participant.
    """
    session = (
        await db.execute(
            select(GuestSession).where(GuestSession.id == user["guest_session_id"])
        )
    ).scalar_one_or_none()
    if session is None or session.revoked_at is not None:
        return None
    room = (
        await db.execute(select(Room).where(Room.id == session.room_id))
    ).scalar_one_or_none()
    if room is None:
        session.revoked_at = _now()
        await db.commit()
        return None
    await _terminate_sessions(
        db, redis, livekit, room, [session], reason="guest_left"
    )
    return None


__all__ = ["router", "INVALID_LINK_DETAIL"]
