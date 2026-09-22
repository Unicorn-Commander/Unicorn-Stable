"""Recording routes — design §8, wired to the egress service (L8s).

Policy lives on the room (``recording_policy`` / ``recording_kind``, set via
``PATCH /rooms/{id}`` by owner/admin); entitlement is the Keycloak realm role
``stable-recorder`` (granted in Ops-Center); ``call_egresses`` rows are what
``GET /rooms/{id}/recordings`` lists. Every decision is a pure function in
services/recording_policy.py; this module only gathers the facts and maps
refusals to HTTP.

Who sees what: every MEMBER may see THAT a call was recorded (the list, the
live state). The FILE — a download link — and deletion are for the room
owner/admin and whoever started the recording.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import (
    get_current_user,
    get_db,
    get_livekit,
    get_redis,
    get_settings_dep,
    require_room_member,
)
from app.models.call_egress import CallEgress
from app.models.participant import Participant
from app.models.room import MemberRole, Room, RoomMember, TranscriptExport
from app.schemas.room import RecordingResponse
from app.services import call_recording, recording_policy_admin, recording_storage
from app.services.agent_access import is_instance_admin
from app.services.recording_policy import (
    RECORDER_ROLE,
    decide_delete,
    decide_manual_start,
    decide_manual_stop,
    may_view_file,
    user_is_entitled,
)

logger = structlog.get_logger(__name__)

router = APIRouter()

# Re-exported for the L0 contract tests and anything that imported it here.
__all__ = ["router", "RECORDER_ROLE", "user_may_record"]


class RecordingStartBody(BaseModel):
    kind: Literal["audio", "composite"] | None = None


class BulkPolicyBody(BaseModel):
    """``POST /admin/recording/policy`` — the operator's bulk tool."""

    policy: Literal["off", "on_request", "always"]
    kind: Literal["audio", "composite", "track"] | None = None
    # "all_active" = every non-archived room, or an explicit list of ids.
    rooms: Literal["all_active"] | list[uuid.UUID] = "all_active"
    dry_run: bool = False


def user_may_record(user: dict[str, Any]) -> bool:
    return user_is_entitled(user)


async def _load_room(db: AsyncSession, room_id: uuid.UUID) -> Room:
    room = (await db.execute(select(Room).where(Room.id == room_id))).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return room


async def _is_owner_or_admin(db: AsyncSession, room_id: uuid.UUID, user: dict[str, Any]) -> bool:
    member = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.participant_id == user.get("participant_id"),
            )
        )
    ).scalar_one_or_none()
    return member is not None and getattr(member, "role", None) in (MemberRole.OWNER, MemberRole.ADMIN)


def _policy_gate(room: Room, user: dict[str, Any]) -> None:
    """The two checks every recording action shares, in contract order:
    policy first (an ``off`` room answers 403 to everyone), then entitlement."""
    policy = getattr(room, "recording_policy", "off")
    if policy == "off":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Recording is off for this room",
        )
    if not user_may_record(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not entitled to record; ask an admin for the recorder role",
        )


def _raise(decision: Any) -> None:
    raise HTTPException(status_code=decision.status, detail=decision.reason)


# ---------------------------------------------------------------------------
# Start / stop / state
# ---------------------------------------------------------------------------


@router.post("/rooms/{room_id}/recording/start", status_code=status.HTTP_202_ACCEPTED)
async def start_recording(
    room_id: uuid.UUID,
    body: RecordingStartBody | None,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)] = None,  # type: ignore[assignment]
    livekit: Annotated[Any, Depends(get_livekit)] = None,
    redis: Annotated[Any, Depends(get_redis)] = None,
) -> dict[str, Any]:
    """Start recording this room's live call (entitled members, policy allowing).

    ``kind`` defaults to the room's ``recording_kind``. Answers 409 when a
    recording is already in flight, 429 when composite capacity is full, 503
    when the egress service does not answer or recording is disabled.
    """
    room = await _load_room(db, room_id)
    _policy_gate(room, user)
    if settings is None:
        from app.config import get_settings

        settings = get_settings()
    kind = (body.kind if body and body.kind else None) or getattr(room, "recording_kind", None) or "audio"
    current = await call_recording.active_recording(db, room.id)
    decision = decide_manual_start(
        policy=getattr(room, "recording_policy", "off"),
        entitled=user_may_record(user),
        master_enabled=call_recording.recording_enabled(settings),
        already_active=current is not None,
        kind=kind,
    )
    if not decision.allowed:
        _raise(decision)
    try:
        row = await call_recording.start_recording(
            db,
            settings,
            livekit,
            room,
            kind=kind,
            started_by=user.get("participant_id"),
            redis=redis,
            trigger="user",
            allow_fallback=False,
            started_by_name=user.get("display_name") or user.get("username"),
        )
    except call_recording.RecordingError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)
    logger.info(
        "recording_started_by_user",
        room_id=str(room.id),
        recording_id=str(row.id),
        kind=row.kind,
        participant_id=str(user.get("participant_id")),
    )
    return await call_recording.room_recording_state(db, room)


@router.post("/rooms/{room_id}/recording/stop", status_code=status.HTTP_202_ACCEPTED)
async def stop_recording(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)] = None,  # type: ignore[assignment]
    livekit: Annotated[Any, Depends(get_livekit)] = None,
    redis: Annotated[Any, Depends(get_redis)] = None,
) -> dict[str, Any]:
    """Stop this room's recording. In an ``always`` room only the owner/admin
    may (or change the policy); answers 409 when nothing is recording."""
    room = await _load_room(db, room_id)
    _policy_gate(room, user)
    if settings is None:
        from app.config import get_settings

        settings = get_settings()
    current = await call_recording.active_recording(db, room.id)
    decision = decide_manual_stop(
        policy=getattr(room, "recording_policy", "off"),
        entitled=user_may_record(user),
        active=current is not None,
        is_owner_or_admin=await _is_owner_or_admin(db, room.id, user),
    )
    if not decision.allowed:
        _raise(decision)
    stopped = await call_recording.stop_room_recording(
        db,
        settings,
        livekit,
        room,
        reason="stop_requested",
        redis=redis,
        stopped_by_name=user.get("display_name") or user.get("username"),
    )
    logger.info(
        "recording_stopped_by_user",
        room_id=str(room.id),
        stopped=stopped,
        participant_id=str(user.get("participant_id")),
    )
    state = await call_recording.room_recording_state(db, room)
    state["stopped"] = stopped
    return state


@router.get("/rooms/{room_id}/recording")
async def get_recording_state(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """The live ``recording_state`` for this room (what the REC pill shows
    on reload, before the next WebSocket frame)."""
    room = await _load_room(db, room_id)
    state = await call_recording.room_recording_state(db, room)
    state["can_record"] = user_may_record(user) and state["policy"] != "off"
    return state


# ---------------------------------------------------------------------------
# Listing / download / delete
# ---------------------------------------------------------------------------


async def _row_for(db: AsyncSession, room_id: uuid.UUID, recording_id: str) -> CallEgress:
    """A recording of THIS room by row id (UUID) or LiveKit egress id (EG_…)."""
    try:
        conditions = CallEgress.id == uuid.UUID(str(recording_id))
    except (ValueError, TypeError):
        conditions = CallEgress.egress_id == str(recording_id)
    row = (
        await db.execute(
            select(CallEgress).where(CallEgress.room_id == room_id, conditions)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found")
    return row


@router.get("/rooms/{room_id}/recordings", response_model=list[RecordingResponse])
async def list_recordings(
    room_id: uuid.UUID,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(50, ge=1, le=200),
) -> list[RecordingResponse]:
    """The room's recordings (every member may see THAT a call was recorded;
    the file itself is served by the storage layer with its own ACL)."""
    rows = (
        await db.execute(
            select(CallEgress)
            .where(CallEgress.room_id == room_id)
            .order_by(CallEgress.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    if not rows:
        return []

    starter_ids = {r.started_by for r in rows if r.started_by is not None}
    names: dict[Any, str] = {}
    if starter_ids:
        for pid, display, username in (
            await db.execute(
                select(Participant.id, Participant.display_name, Participant.username).where(
                    Participant.id.in_(starter_ids)
                )
            )
        ).all():
            names[pid] = display or username

    session_ids = {r.mo_session_id for r in rows if r.mo_session_id}
    session_urls: dict[str, str] = {}
    if session_ids:
        for sid, url in (
            await db.execute(
                select(TranscriptExport.remote_session_id, TranscriptExport.remote_session_url).where(
                    TranscriptExport.room_id == room_id,
                    TranscriptExport.remote_session_id.in_(session_ids),
                    TranscriptExport.remote_session_url.is_not(None),
                )
            )
        ).all():
            session_urls.setdefault(sid, url)

    owner_or_admin = await _is_owner_or_admin(db, room_id, user)
    me = user.get("participant_id")
    out: list[RecordingResponse] = []
    for r in rows:
        starter = r.started_by is not None and str(r.started_by) == str(me)
        item = RecordingResponse.model_validate(r)
        item.egress_id = r.egress_id
        item.started_by_name = names.get(r.started_by) if r.started_by is not None else None
        item.mo_session_url = session_urls.get(r.mo_session_id) if r.mo_session_id else None
        item.handoff_status = r.handoff_status
        item.file_size_bytes = r.file_size_bytes
        item.can_delete = decide_delete(
            is_owner_or_admin=owner_or_admin, is_starter=starter, legal_hold=bool(r.legal_hold)
        ).allowed
        item.can_download = bool(r.storage_url) and may_view_file(
            is_owner_or_admin=owner_or_admin, is_starter=starter
        )
        out.append(item)
    return out


@router.get("/rooms/{room_id}/recordings/{recording_id}/download")
async def download_recording(
    room_id: uuid.UUID,
    recording_id: str,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)] = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    """A short-lived presigned link to the stored file (owner/admin/starter)."""
    if settings is None:
        from app.config import get_settings

        settings = get_settings()
    row = await _row_for(db, room_id, recording_id)
    starter = row.started_by is not None and str(row.started_by) == str(user.get("participant_id"))
    if not may_view_file(
        is_owner_or_admin=await _is_owner_or_admin(db, room_id, user), is_starter=starter
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the room owner, an admin, or whoever started the recording may download it",
        )
    if not row.storage_url:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This recording has no stored copy (not uploaded yet, or already purged)",
        )
    cfg = recording_storage.storage_config(settings)
    key = recording_storage.key_from_url(cfg, row.storage_url) if cfg else None
    url = recording_storage.presigned_get_url(settings, key=key) if key else None
    if url is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Recording storage is not configured on this instance",
        )
    return {
        "url": url,
        "expires_in_seconds": int(settings.recording_download_link_seconds or 900),
        "kind": row.kind,
        "content_type": recording_storage.CONTENT_TYPES.get(row.kind or "audio"),
    }


@router.delete("/rooms/{room_id}/recordings/{recording_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recording(
    room_id: uuid.UUID,
    recording_id: str,
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)] = None,  # type: ignore[assignment]
) -> Response:
    """Delete a finished recording's files (owner/admin or whoever started
    it). ``legal_hold`` answers 423; an in-flight recording answers 409."""
    if settings is None:
        from app.config import get_settings

        settings = get_settings()
    row = await _row_for(db, room_id, recording_id)
    starter = row.started_by is not None and str(row.started_by) == str(user.get("participant_id"))
    decision = decide_delete(
        is_owner_or_admin=await _is_owner_or_admin(db, room_id, user),
        is_starter=starter,
        legal_hold=bool(row.legal_hold),
    )
    if not decision.allowed:
        _raise(decision)
    if row.status in ("starting", "active", "stopping"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Stop the recording before deleting it",
        )
    outcome = await call_recording.purge_recording_files(settings, row)
    if row.storage_url is not None:
        # The object is still there — say so rather than pretend.
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Stored copy could not be deleted: {outcome.get('storage')}",
        )
    row.status = "deleted"
    await db.commit()
    logger.info(
        "recording_deleted",
        room_id=str(room_id),
        recording_id=str(row.id),
        by=str(user.get("participant_id")),
        outcome=outcome,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Operator tool: bulk policy (instance admins)
# ---------------------------------------------------------------------------


@router.post("/admin/recording/policy")
async def set_recording_policy_bulk(
    body: BulkPolicyBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, Any]:
    """Set ``recording_policy`` / ``recording_kind`` on many rooms at once.

    Instance admins only (Keycloak realm roles ∩ ``STABLE_ADMIN_ROLES``, the
    same gate as agent-access grants). Every changed room gets an
    ``agent_events`` audit row. ``dry_run`` reports without writing. The
    container CLI ``scripts/set_recording_policy.py`` is the same function
    for the deploy step (deploy/RECORDING.md).
    """
    if not is_instance_admin(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an instance admin can change recording policy in bulk.",
        )
    actor = f"user:{user.get('username') or user.get('sub') or user.get('participant_id')}"
    try:
        summary = await recording_policy_admin.apply_recording_policy(
            db,
            policy=body.policy,
            kind=body.kind,
            room_ids=None if body.rooms == "all_active" else body.rooms,
            all_active=body.rooms == "all_active",
            actor=actor,
            via="api",
            dry_run=body.dry_run,
        )
    except recording_policy_admin.PolicyChangeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return summary
