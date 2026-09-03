"""Call moderation — owner/admin controls over the participants of a LIVE call.

POST /rooms/{room_id}/moderation acts on the room's LiveKit session:

  * ``mute_mic``          — server-mute every audio track the target publishes.
                            The target can re-enable their own mic (client
                            unmute); this is "please stop talking", not a gag.
  * ``unmute_mic``        — AGENT PARTICIPANTS ONLY. LiveKit's server-side
                            unmute (``MuteRoomTrackRequest(muted=False)``) is
                            refused by this deployment (412 "remote unmute not
                            enabled" — see LiveKitService.mute_participant), so
                            a human ``mute_mic`` target undoes it the same way
                            ``unsilence`` does: by turning their own mic back
                            on. An agent worker has no hands, so instead this
                            sends a ``voice_relay_control`` data packet
                            (``{"type": "voice_relay_control", "action":
                            "unmute"}``) to the target's LiveKit identity; the
                            voice-relay agent (agents/voice_relay/agent.py)
                            unmutes its own published audio track on receipt.
                            No-op, logged, if the target never joined LiveKit.
  * ``silence``           — mute audio AND revoke ``can_publish``: the target
                            cannot re-open mic/camera/share until unsilenced.
  * ``unsilence``         — restore ``can_publish`` ONLY. Deliberately never
                            force-unmutes the track: the target re-enables
                            their own mic, so nobody's live audio is opened by
                            a third party (privacy).
  * ``deafen``/``undeafen`` — revoke/restore ``can_subscribe``: a room-wide
                            receive cut (they stop hearing/seeing everyone).
  * ``remove_from_call``  — kick the target's connection from the LiveKit room
                            (their room MEMBERSHIP is untouched — that is the
                            existing DELETE /rooms/{id}/members/{pid} kick).

HONEST LIMIT — MODERATION STATE IS CONNECTION-SCOPED. LiveKit permission
grants live on the current connection: a silenced/deafened participant who
leaves (or drops) and rejoins mints a fresh token with the default grants and
regains publish/subscribe. Nothing durable is written to Postgres here.
Durable moderation (a "silenced" flag on the membership row that the token
mint in api/tokens.py consults) is a known follow-up, not an accident.

TARGETING. ``participant_id`` accepts either
  * a Stable participant UUID (the members-panel shape) — resolved to the
    canonical LiveKit identity: ``{username}_{uuid}`` for humans/guests
    (api/tokens.livekit_identity), or the bare ``agent-<id>`` username for
    agent-typed participants (agents join LiveKit under their agent identity,
    never the ``username_<uuid>`` form — see agents/agent_runtime/registry.py);
  * a raw LiveKit identity string (the call-tile shape) — used as-is. This is
    what makes the AGENT KILL-SWITCH work: a misbehaving worker that joined as
    ``agent-majik`` (or the type-shaped ``stable-brigade``) has no UUID the
    client could know, but its tile knows its identity.

AUTHZ mirrors the room's existing moderation ladder (room_service.py):
owner/admin only (member/guest/non-member → 403); an admin may not target an
owner or another admin (owner-immune); nobody targets themselves.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.tokens import livekit_identity
# Reuse the webhook's parser so the identity wire format (username_<uuid>)
# keeps ONE reader — same reasoning as api/calls.py.
from app.api.webhooks import _extract_participant_id, _is_agent_identity
from app.deps import get_current_user, get_db, get_livekit
from app.models.participant import Participant, ParticipantType
from app.models.room import MemberRole, Room, RoomMember
from app.services.livekit_service import LiveKitService

logger = structlog.get_logger(__name__)

router = APIRouter()

ModerationAction = Literal[
    "mute_mic",
    "unmute_mic",
    "silence",
    "unsilence",
    "deafen",
    "undeafen",
    "remove_from_call",
]


class CallModerationBody(BaseModel):
    """Target + verb. ``participant_id`` is a UUID or a LiveKit identity."""

    participant_id: str = Field(min_length=1, max_length=512)
    action: ModerationAction


class CallModerationResponse(BaseModel):
    status: str
    action: ModerationAction
    room_id: str
    #: The LiveKit identity the action was applied to.
    target_identity: str
    #: Audio track sids touched (mute_mic / silence only; empty when the
    #: target had no audio published).
    muted_track_sids: list[str] = []


# ---------------------------------------------------------------------------
# Data access — module-level so tests can patch the seams instead of scripting
# a fragile ordered db.execute side_effect list.
# ---------------------------------------------------------------------------


async def _get_room(db: AsyncSession, room_id: uuid.UUID) -> Room | None:
    result = await db.execute(select(Room).where(Room.id == room_id))
    return result.scalar_one_or_none()


async def _get_membership(
    db: AsyncSession, room_id: uuid.UUID, participant_id: uuid.UUID | str
) -> RoomMember | None:
    result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.participant_id == participant_id,
        )
    )
    return result.scalar_one_or_none()


async def _get_participant(
    db: AsyncSession, participant_id: uuid.UUID | str
) -> Participant | None:
    result = await db.execute(
        select(Participant).where(Participant.id == participant_id)
    )
    return result.scalar_one_or_none()


def _require_moderator(membership: RoomMember | None) -> RoomMember:
    """403 unless the caller holds owner/admin in THIS room.

    Non-members and members with member/guest roles get the same 403 shape the
    room's existing moderation paths produce (room_service._require_role).
    """
    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this room",
        )
    if membership.role not in (MemberRole.OWNER, MemberRole.ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Requires one of roles: owner, admin",
        )
    return membership


def _assert_can_target(
    actor: RoomMember, target: RoomMember | None, action: str
) -> None:
    """The room's ladder: an admin may not act on an owner or another admin.

    ``target`` may be None — a call participant with no membership row (an
    agent worker, a broadcast-hidden feed) holds no rank, so rank cannot
    protect it.
    """
    if target is None:
        return
    if actor.role != MemberRole.OWNER and target.role in (
        MemberRole.OWNER,
        MemberRole.ADMIN,
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Only an owner can {action} an admin or owner",
        )


async def _resolve_target(
    db: AsyncSession, raw: str
) -> tuple[str, uuid.UUID | None]:
    """Resolve the request's ``participant_id`` to (livekit_identity, uuid|None).

    UUID input → the participant row decides the identity (agents join under
    their bare ``agent-<id>`` username, humans under ``username_<uuid>``).
    Identity input → passed through; a ``username_<uuid>`` shape still yields
    the uuid so the role ladder can see the target's rank.
    """
    target_uuid: uuid.UUID | None = None
    try:
        target_uuid = uuid.UUID(raw)
    except ValueError:
        pass

    if target_uuid is None:
        parsed = _extract_participant_id(raw)
        return raw, uuid.UUID(parsed) if parsed else None

    participant = await _get_participant(db, target_uuid)
    if participant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No such participant",
        )
    if participant.participant_type == ParticipantType.AGENT:
        # Agent workers join LiveKit as "agent-<id>" (the username), never as
        # the username_<uuid> human form — see agent_runtime/registry.py.
        return participant.username, target_uuid
    return livekit_identity(participant.username, participant.id), target_uuid


def _is_participant_missing(exc: Exception) -> bool:
    """True when LiveKit's error means 'no such participant in this room'.

    livekit.api raises ``ServerError`` carrying the twirp ``code`` ("not_found")
    and the HTTP ``status`` (404); either is authoritative. The text fallback
    normalises separators because the wire code is ``not_found`` while prose
    says "not found" — matching only one form silently mislabels a missing
    participant as a 502 LiveKit outage.
    """
    if str(getattr(exc, "code", "") or "").lower() == "not_found":
        return True
    if getattr(exc, "status", None) == 404:
        return True
    return "not found" in str(exc).lower().replace("_", " ")


@router.post(
    "/rooms/{room_id}/moderation",
    response_model=CallModerationResponse,
)
async def moderate_call_participant(
    room_id: uuid.UUID,
    body: CallModerationBody,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> CallModerationResponse:
    """Moderate one participant of this room's live call. Owner/admin only.

    See the module docstring for the action semantics and the honest limit:
    LiveKit permission state lasts only for the CURRENT connection — a
    silenced/deafened participant who leaves and rejoins regains publish/
    subscribe from their fresh token. Durable moderation state is a follow-up.
    """
    room = await _get_room(db, room_id)
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Room not found",
        )

    actor = _require_moderator(
        await _get_membership(db, room_id, user["participant_id"])
    )

    identity, target_uuid = await _resolve_target(db, body.participant_id)

    if target_uuid is not None and str(target_uuid) == str(
        user["participant_id"]
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You can't moderate yourself",
        )

    target_membership = (
        await _get_membership(db, room_id, target_uuid)
        if target_uuid is not None
        else None
    )
    _assert_can_target(actor, target_membership, body.action.replace("_", " "))

    if body.action == "unmute_mic" and not _is_agent_identity(identity):
        # A human target unmutes by turning their own mic back on (see
        # ``unsilence``) — there is no server-side path for it, and adding
        # one would be exactly the silent third-party mic-open the
        # ``unsilence`` docstring above refuses to build.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="unmute_mic only applies to agent participants",
        )

    muted_sids: list[str] = []
    try:
        if body.action == "mute_mic":
            muted_sids = await livekit.mute_participant(
                room.livekit_room_name, identity, muted=True
            )
        elif body.action == "unmute_mic":
            # NOT a server-side unmute (refused by the SFU — see
            # LiveKitService.mute_participant). The relay unmutes ITSELF on
            # receipt of this control packet, the same channel
            # rooms.update_voice_settings uses to push ``relay_config``.
            await livekit.send_data(
                room.livekit_room_name,
                {
                    "type": "voice_relay_control",
                    "action": "unmute",
                    "by": str(user["participant_id"]),
                },
                destination_identities=[identity],
            )
        elif body.action == "silence":
            # Mute first (instant quiet), then revoke publish so the mic can't
            # be re-opened. Revoking can_publish also makes the SFU drop the
            # published tracks, so the mute is belt-and-braces for the gap.
            muted_sids = await livekit.mute_participant(
                room.livekit_room_name, identity, muted=True
            )
            await livekit.update_participant_permissions(
                room.livekit_room_name, identity, can_publish=False
            )
        elif body.action == "unsilence":
            # Publish rights ONLY — never force-unmute a track. The target
            # re-enables their own mic (privacy: no third party opens someone
            # else's live microphone).
            await livekit.update_participant_permissions(
                room.livekit_room_name, identity, can_publish=True
            )
        elif body.action == "deafen":
            await livekit.update_participant_permissions(
                room.livekit_room_name, identity, can_subscribe=False
            )
        elif body.action == "undeafen":
            await livekit.update_participant_permissions(
                room.livekit_room_name, identity, can_subscribe=True
            )
        elif body.action == "remove_from_call":
            await livekit.remove_participant(room.livekit_room_name, identity)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — map LiveKit errors deliberately
        if _is_participant_missing(exc):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="That participant is not in the call",
            )
        logger.error(
            "call_moderation_failed",
            room_id=str(room_id),
            actor=str(user["participant_id"]),
            target=identity,
            action=body.action,
            error=repr(exc),
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LiveKit refused the moderation action",
        )

    logger.info(
        "call_moderation",
        room_id=str(room_id),
        actor=str(user["participant_id"]),
        target=identity,
        action=body.action,
    )
    return CallModerationResponse(
        status="ok",
        action=body.action,
        room_id=str(room_id),
        target_identity=identity,
        muted_track_sids=muted_sids,
    )
