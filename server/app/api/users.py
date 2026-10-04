"""User directory + invite endpoints.

People who have signed into Stable exist as Participant rows. ``GET
/users/search`` is scoped by ``USER_SEARCH_SCOPE``: ``members`` (the default)
lists those local humans and at most one exact username or email match, and
``realm`` substring-searches the whole sign-in realm for a deployment that
owns it. Email is never returned from search.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import (
    get_current_user,
    get_db,
    get_presence,
    get_settings_dep,
    rate_limit,
)
from app.models.participant import Participant, ParticipantType
from app.services.keycloak_admin import KeycloakAdmin
from app.services.participant_identity import link_participant_by_email
from app.services.presence_service import PresenceService

logger = structlog.get_logger(__name__)

router = APIRouter()


class CallPrefs(BaseModel):
    """How the user enters calls. Voice calls always connect immediately; the
    only choice is whether VIDEO calls get the pre-join device check (default
    off). Server-side so a phone never asks what the desk didn't."""

    check_devices_before_video: bool = False


class UserPreferences(BaseModel):
    """Per-user preferences that follow the account across devices (stored on
    the Participant's metadata)."""

    default_agent_id: str | None = None
    favorite_people_ids: list[UUID] = Field(default_factory=list)
    onboarding_checklist: dict[str, bool] = Field(default_factory=dict)
    call_prefs: CallPrefs = Field(default_factory=CallPrefs)


class UserPreferencesUpdate(BaseModel):
    """Partial preference update. Missing fields stay untouched."""

    default_agent_id: str | None = None
    favorite_people_ids: list[UUID] | None = None
    onboarding_checklist: dict[str, bool] | None = None
    call_prefs: CallPrefs | None = None


def _call_prefs(meta: dict[str, Any]) -> CallPrefs:
    raw = meta.get("call_prefs")
    if not isinstance(raw, dict):
        return CallPrefs()
    return CallPrefs(check_devices_before_video=raw.get("check_devices_before_video") is True)


def _favorite_people(meta: dict[str, Any]) -> list[UUID]:
    """Read a bounded, deduplicated UUID list from untrusted JSON metadata."""
    raw = meta.get("favorite_people_ids")
    if not isinstance(raw, list):
        return []
    result: list[UUID] = []
    seen: set[UUID] = set()
    for value in raw[:100]:
        try:
            participant_id = UUID(str(value))
        except (TypeError, ValueError):
            continue
        if participant_id not in seen:
            seen.add(participant_id)
            result.append(participant_id)
    return result


def _onboarding(meta: dict[str, Any]) -> dict[str, bool]:
    raw = meta.get("onboarding_checklist")
    return {key: value is True for key, value in raw.items() if key in {"agent", "channels", "invite"}} if isinstance(raw, dict) else {}


@router.get("/users/me/preferences", response_model=UserPreferences)
async def get_my_preferences(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> UserPreferences:
    """Return the caller's preferences (server-side, so they follow the user
    across devices). Missing/unset → nulls; the client falls back to its
    built-in default agent."""
    p = await db.get(Participant, user["participant_id"])
    meta = p.metadata_ if (p is not None and isinstance(p.metadata_, dict)) else {}
    val = meta.get("default_agent_id")
    return UserPreferences(
        default_agent_id=val if isinstance(val, str) and val else None,
        favorite_people_ids=_favorite_people(meta),
        onboarding_checklist=_onboarding(meta),
        call_prefs=_call_prefs(meta),
    )


@router.put("/users/me/preferences", response_model=UserPreferences)
async def set_my_preferences(
    body: UserPreferencesUpdate,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> UserPreferences:
    """Partially update preferences without clobbering settings from another
    surface or device."""
    p = await db.get(Participant, user["participant_id"])
    if p is None:
        raise HTTPException(status_code=404, detail="Participant not found")
    meta = dict(p.metadata_ or {})
    if "default_agent_id" in body.model_fields_set:
        aid = (body.default_agent_id or "").strip()
        if aid:
            meta["default_agent_id"] = aid
        else:
            meta.pop("default_agent_id", None)
    if body.favorite_people_ids is not None:
        requested = list(dict.fromkeys(body.favorite_people_ids))[:100]
        if requested:
            valid_rows = (
                await db.execute(
                    select(Participant.id).where(
                        Participant.id.in_(requested),
                        Participant.participant_type == ParticipantType.HUMAN,
                    )
                )
            ).scalars().all()
            valid = {UUID(str(value)) for value in valid_rows}
            requested = [value for value in requested if value in valid]
        meta["favorite_people_ids"] = [str(value) for value in requested]
    if body.onboarding_checklist is not None:
        meta["onboarding_checklist"] = {
            key: value is True for key, value in body.onboarding_checklist.items()
            if key in {"agent", "channels", "invite"}
        }
    if body.call_prefs is not None:
        meta["call_prefs"] = {
            "check_devices_before_video": body.call_prefs.check_devices_before_video is True
        }
    p.metadata_ = meta  # reassign (not mutate) so SQLAlchemy tracks the JSONB change
    await db.commit()
    val = meta.get("default_agent_id")
    return UserPreferences(
        default_agent_id=val if isinstance(val, str) and val else None,
        favorite_people_ids=_favorite_people(meta),
        onboarding_checklist=_onboarding(meta),
        call_prefs=_call_prefs(meta),
    )


class PeopleDirectoryEntry(BaseModel):
    id: UUID
    username: str
    display_name: str
    avatar_url: str | None
    is_online: bool
    last_seen_at: str | None = None


@router.get("/users/directory", response_model=list[PeopleDirectoryEntry])
async def people_directory(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    presence: Annotated[PresenceService, Depends(get_presence)],
    q: str = Query("", min_length=0, max_length=100),
    limit: int = Query(100, ge=1, le=100),
) -> list[PeopleDirectoryEntry]:
    """Internal people directory with live presence.

    Only people who have a Stable participant identity are returned. Email and
    Keycloak subject are deliberately absent: coworkers get the identity facts
    needed for chat and presence, not a realm-wide identity export.
    """
    stmt = (
        select(Participant)
        .where(
            Participant.participant_type == ParticipantType.HUMAN,
            Participant.id != user["participant_id"],
        )
        .order_by(Participant.display_name.asc())
        .limit(limit)
    )
    needle = q.strip()
    if needle:
        pattern = f"%{needle}%"
        stmt = stmt.where(
            Participant.display_name.ilike(pattern)
            | Participant.username.ilike(pattern)
        )
    people = (await db.execute(stmt)).scalars().all()
    statuses = await presence.get_statuses([str(person.id) for person in people])
    return [
        PeopleDirectoryEntry(
            id=person.id,
            username=person.username,
            display_name=person.display_name,
            avatar_url=person.avatar_url,
            is_online=statuses.get(str(person.id)) == "online",
            last_seen_at=person.last_seen_at.isoformat()
            if person.last_seen_at is not None
            else None,
        )
        for person in people
    ]


class UserResult(BaseModel):
    # When the user has signed in, we have a local Participant row with id.
    # When they haven't, we only know their Keycloak sub. The frontend uses
    # whichever is present and the backend resolves/creates Participant on invite.
    id: UUID | None = None
    keycloak_sub: str
    username: str
    display_name: str
    email: str | None
    avatar_url: str | None
    signed_in: bool


def _kc_display_name(kc_user: dict[str, Any]) -> str:
    first = (kc_user.get("firstName") or "").strip()
    last = (kc_user.get("lastName") or "").strip()
    return " ".join(x for x in (first, last) if x) or kc_user.get("username") or ""


def _result_from_local(person: Participant) -> UserResult:
    return UserResult(
        id=person.id,
        keycloak_sub=person.keycloak_sub,
        username=person.username or "",
        display_name=person.display_name or "",
        email=None,
        avatar_url=person.avatar_url,
        signed_in=True,
    )


@router.get("/users/search", response_model=list[UserResult])
async def search_users(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    _rl: Annotated[
        None,
        Depends(rate_limit("user_search", "rate_limit_user_search_per_min")),
    ],
    q: str = Query("", min_length=0, max_length=100),
    limit: int = Query(20, ge=1, le=50),
) -> list[UserResult]:
    """Search people the caller may invite.

    ``members`` (default): local human participants, never the caller, whose
    display name or username contains ``q`` (case-insensitive), ordered by
    display name and capped by ``limit``. An empty ``q`` returns the first
    ``limit`` local people. When ``q`` is non-empty, at most one realm user
    is added, and only from an exact username or email match that is not
    already in the local rows. ``realm`` keeps the whole-realm substring
    search for a deployment that owns its sign-in realm. Email is never
    returned. A guest session or an agent gateway key cannot call this
    route: it depends on ``get_current_user``, which refuses both.
    """
    if settings.user_search_scope == "realm":
        return await _search_users_realm(user, db, settings, q, limit)
    return await _search_users_members(user, db, settings, q, limit)


async def _search_users_members(
    user: dict[str, Any],
    db: AsyncSession,
    settings: Settings,
    q: str,
    limit: int,
) -> list[UserResult]:
    """Local humans, plus at most one exact realm match.

    The substring admin search is never called here. A Keycloak error on
    the exact lookup is logged and the local rows are still returned.
    """
    caller_id = user.get("participant_id")
    caller_sub = user.get("sub")
    needle = q.strip()

    stmt = (
        select(Participant)
        .where(
            Participant.participant_type == ParticipantType.HUMAN,
            Participant.id != caller_id,
        )
        .order_by(Participant.display_name.asc())
        .limit(limit)
    )
    if needle:
        pattern = f"%{needle}%"
        stmt = stmt.where(
            Participant.display_name.ilike(pattern)
            | Participant.username.ilike(pattern)
        )
    people = (await db.execute(stmt)).scalars().all()
    # The SQL above already drops the caller. This keeps a row out if a
    # caller id still comes back, so the caller can never occupy a slot.
    people = [person for person in people if person.id != caller_id][:limit]
    results = [_result_from_local(person) for person in people]
    if not needle:
        return results

    admin = KeycloakAdmin(settings)
    try:
        exact = await admin.find_user_exact(needle)
    except Exception as exc:
        # The exception text can carry the request URL, and that URL is the
        # address that was looked up. Log the type only.
        logger.warning("keycloak_exact_lookup_failed", error_type=type(exc).__name__)
        return results

    if not exact:
        return results
    sub = exact.get("id")
    if not sub or sub == caller_sub or any(row.keycloak_sub == sub for row in results):
        return results

    local = (
        await db.execute(
            select(Participant).where(
                Participant.keycloak_sub == sub,
                Participant.participant_type == ParticipantType.HUMAN,
            )
        )
    ).scalar_one_or_none()
    if local is not None and local.id == caller_id:
        return results

    if local is not None:
        results.append(_result_from_local(local))
        return results

    results.append(
        UserResult(
            id=None,
            keycloak_sub=sub,
            username=exact.get("username") or "",
            display_name=_kc_display_name(exact),
            email=None,
            avatar_url=None,
            signed_in=False,
        )
    )
    return results


async def _search_users_realm(
    user: dict[str, Any],
    db: AsyncSession,
    settings: Settings,
    q: str,
    limit: int,
) -> list[UserResult]:
    """Whole-realm substring search. Unchanged from the pre-scope endpoint.

    For a deployment that owns its sign-in realm. Email stays unset.
    """
    admin = KeycloakAdmin(settings)
    try:
        kc_users = await admin.search_users(q, limit=limit)
    except Exception as e:
        logger.warning("keycloak_search_failed", error=str(e))
        kc_users = []

    # Exclude the caller's own account
    caller_sub = user.get("sub")
    kc_users = [u for u in kc_users if u.get("id") and u.get("id") != caller_sub]

    # Batch-lookup local participants by sub
    subs = [u["id"] for u in kc_users]
    existing: dict[str, Participant] = {}
    if subs:
        rows = (
            await db.execute(
                select(Participant).where(
                    Participant.keycloak_sub.in_(subs),
                    Participant.participant_type == ParticipantType.HUMAN,
                )
            )
        ).scalars().all()
        existing = {p.keycloak_sub: p for p in rows}

    results: list[UserResult] = []
    for u in kc_users:
        sub = u["id"]
        p = existing.get(sub)
        results.append(
            UserResult(
                id=p.id if p else None,
                keycloak_sub=sub,
                username=u.get("username") or "",
                display_name=_kc_display_name(u),
                email=None,  # not exposed via search — avoid realm-wide email enumeration (invite uses keycloak_sub)
                avatar_url=p.avatar_url if p else None,
                signed_in=p is not None,
            )
        )
    return results


async def _load_keycloak_email_for_sub(sub: str) -> str | None:
    """Fetch a user's email from Keycloak by their sub."""
    from app.config import get_settings

    try:
        admin = KeycloakAdmin(get_settings())
        kc_user = await admin.get_user(sub)
        return (kc_user or {}).get("email") or None
    except Exception:
        logger.debug("keycloak_email_lookup_failed", exc_info=True)
        return None


async def resolve_or_create_participant(
    db: AsyncSession,
    settings: Settings,
    keycloak_sub: str,
) -> Participant:
    """Return the Participant for a Keycloak user, creating it on first invite.

    This mirrors the upsert that happens on first login in get_current_user
    so we can invite users who haven't signed in yet. They'll link up to this
    row the first time they log into Stable (same keycloak_sub).
    """
    existing = (
        await db.execute(
            select(Participant).where(Participant.keycloak_sub == keycloak_sub)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    admin = KeycloakAdmin(settings)
    kc_user = await admin.get_user(keycloak_sub)
    if kc_user is None:
        raise ValueError(f"Keycloak user not found: {keycloak_sub}")

    # Before minting a fresh row, link an existing email-matched persona
    # (the invitee may already exist under the OTHER Keycloak realm's sub --
    # see services/participant_identity.py). The sub here came from the
    # configured realm's admin API, so it is trusted by construction.
    email = (kc_user.get("email") or "").strip().lower()
    if email:
        linked = await link_participant_by_email(
            db, settings, new_sub=keycloak_sub, email=email
        )
        if linked is not None:
            return linked

    first = (kc_user.get("firstName") or "").strip()
    last = (kc_user.get("lastName") or "").strip()
    display = " ".join(x for x in (first, last) if x) or kc_user.get("username") or ""
    username = kc_user.get("username") or keycloak_sub

    p = Participant(
        keycloak_sub=keycloak_sub,
        username=username,
        display_name=display,
        participant_type=ParticipantType.HUMAN,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p
