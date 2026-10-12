from __future__ import annotations

import uuid
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import (
    get_current_user,
    get_db,
    get_livekit,
    get_redis,
    rate_limit,
    require_room_member,
)
from app.models.participant import Participant, ParticipantType
from app.models.push_subscription import PushSubscription
from app.models.room import Room, RoomMember, RoomType
# Reuse the webhook's parser so the identity wire format (username_<uuid>)
# has one reader, not a second regex that can drift from it.
from app.api.webhooks import _extract_participant_id
# Imported as a MODULE, not `from … import RING_TIMEOUT_S`, on purpose: a
# value-binding here would be a second copy of the ring deadline that could
# drift from the one the service actually arms its timer with. One clock.
from app.services import call_service as _cs
from app.services.call_service import CallService
from app.services.agent_routing import (
    find_canonical_room,
    participant_backend,
    runner_voice_canonical_only,
)
from app.services.livekit_service import LiveKitService
from app.config import get_settings

logger = structlog.get_logger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Direct calls — "ring this person, so they know *I* am calling *them*"
# ---------------------------------------------------------------------------
#
# RINGING IS FOR DMs ONLY. A channel may have fifty members; an interruptive,
# audible, full-width banner on fifty screens because one person clicked a
# phone icon is not a feature. Channel calls keep the behaviour they already
# have — join the room's LiveKit call, and the existing `call_started` handler
# in useGlobalNotifications downgrades the announcement to a toast. That policy
# is enforced HERE (a 400 on a channel room), not only in the client, because a
# client-side-only rule is a suggestion.


def _svc(redis: Redis) -> CallService:
    return CallService(redis)


class CalleeStateOut(BaseModel):
    id: str
    display_name: str
    #: ringing | offline | busy | unknown | in_call
    state: str


class RingResponse(BaseModel):
    call_id: str | None
    room_id: str
    #: ringing | unreachable | in_call ("in_call": everyone you would ring is
    #: already ON this room's call — don't wait for an answer, just join)
    state: str
    started_at: str | None
    expires_at: str | None
    ring_timeout_seconds: int
    targets: list[CalleeStateOut]


class CallActionResponse(BaseModel):
    call_id: str
    room_id: str
    state: str


async def _room_or_404(db: AsyncSession, room_id: uuid.UUID) -> Room:
    room = (await db.execute(select(Room).where(Room.id == room_id))).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return room


async def _in_call_participant_ids(livekit: LiveKitService, room: Room) -> set[str]:
    """Participant ids CONNECTED to this room's LiveKit call right now.

    The media plane is the only honest source for "on the line": Redis room
    presence conflates "has the app open" with "in the call" (both the WS
    handler and the LiveKit webhook write it), and the ring-window busy latch
    dies 45s after the call is answered. Ringing someone who is already on the
    line is pure noise — their in-call device suppresses the banner while
    every OTHER device rings for a conversation they are already having.

    Best-effort by design: if the LiveKit API cannot be reached, ringing must
    keep working, so the answer degrades to "nobody provably in the call".
    """
    try:
        info = await livekit.get_room(room.livekit_room_name)
    except Exception:
        logger.warning("call_livekit_occupancy_probe_failed", room_id=str(room.id), exc_info=True)
        return set()
    ids: set[str] = set()
    for p in info.get("participants", []):
        pid = _extract_participant_id(getattr(p, "identity", "") or "")
        if pid:
            ids.add(pid)
    return ids


@router.post("/rooms/{room_id}/call/ring", response_model=RingResponse)
async def ring_room(
    room_id: uuid.UUID,
    # `require_room_member` authenticates AND enforces membership on the path
    # param, so a non-member cannot ring a DM they are not in — the check is
    # structural, not a line in the handler body somebody can forget to write.
    user: Annotated[dict[str, Any], Depends(require_room_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
    _rl: Annotated[
        None, Depends(rate_limit("call_ring", "rate_limit_token_mint_per_min"))
    ] = None,
) -> RingResponse:
    """Ring the other member(s) of a DM. Never rings a channel.

    A member who is already ON this room's call is never rung — the response
    comes back `in_call` and the client simply joins. That is what makes
    switching devices mid-call a one-click move instead of a fresh offer that
    rings the peer's other devices (or, worse, reads your own live call as
    "<peer> is busy" and locks you out of it).
    """
    room = await _room_or_404(db, room_id)

    if room.room_type == RoomType.CHANNEL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Channels are not rung. Start the channel call instead.",
        )

    caller_id = str(user["participant_id"])
    caller = (
        await db.execute(select(Participant).where(Participant.id == user["participant_id"]))
    ).scalar_one_or_none()
    caller_name = (
        (caller.display_name if caller else None)
        or user.get("display_name")
        or user.get("username")
        or "Someone"
    )

    # The other HUMAN members. Agents are deliberately excluded: an agent is
    # dispatched into a call, it does not have a phone to answer, and putting
    # one in the target list would make the caller's "ringing…" list lie.
    rows = (
        await db.execute(
            select(Participant)
            .join(RoomMember, RoomMember.participant_id == Participant.id)
            .where(
                RoomMember.room_id == room.id,
                Participant.id != user["participant_id"],
                Participant.participant_type == ParticipantType.HUMAN,
            )
        )
    ).scalars().all()

    if not rows:
        # Runner seats do not have a phone to ring. A hub/thread that points
        # at one must send the caller to the seat's provisioned canonical room
        # instead of returning an empty call with no explanation.
        runner_rows = (
            await db.execute(
                select(Participant)
                .join(RoomMember, RoomMember.participant_id == Participant.id)
                .where(
                    RoomMember.room_id == room.id,
                    Participant.participant_type == ParticipantType.AGENT,
                )
            )
        ).scalars().all()
        for runner in runner_rows:
            if participant_backend(runner) != "runner":
                continue
            canonical_room = await find_canonical_room(db, runner)
            if canonical_room is not None and canonical_room.id != room.id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=runner_voice_canonical_only(runner, canonical_room),
                )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="There is nobody in this conversation to call.",
        )

    # For a 1:1 DM the room's own display_name is "DM with <them>" — echoing
    # that back at the callee reads as "Aaron is calling / DM with Aaron".
    # The caller's name is already the headline, so the subtitle states the
    # KIND of conversation instead.
    room_label = "Direct message" if room.room_type == RoomType.DM else room.display_name

    push_ids = set((await db.execute(
        select(PushSubscription.participant_id).where(
            PushSubscription.participant_id.in_([p.id for p in rows])
        )
    )).scalars().all())
    svc = _svc(redis)
    call = await svc.ring(
        room_id=str(room.id),
        room_type=room.room_type.value,
        room_name=room_label,
        caller_id=caller_id,
        caller_name=caller_name,
        caller_avatar_url=(caller.avatar_url if caller else None),
        callees=[{
            "id": str(p.id), "display_name": p.display_name or p.username,
            "push_reachable": p.id in push_ids,
        } for p in rows],
        in_call_participant_ids=await _in_call_participant_ids(livekit, room),
    )

    # `resumed` = the service handed back an offer that is ALREADY live (the
    # caller re-rang mid-window, e.g. from a second device). Its timeout task
    # is armed and its pushes were sent the first time — doing either again
    # would double the no-answer clock and the OS notifications.
    if call["state"] == "ringing" and not call.get("resumed"):
        # Server-side no-answer clock. The client's timer is derived from the
        # `expires_at` this same call published, so the two agree by
        # construction rather than by two constants happening to match.
        svc.arm_timeout(str(call["call_id"]))
        try:
            from app.services.push_service import dispatch_call_pushes
            # A member who is already ON the call gets no OS push — "X is
            # calling" about the call they are sitting in. Everyone else keeps
            # the existing push behaviour (a busy callee may still answer from
            # the notification).
            state_by_id = {str(t["id"]): t["state"] for t in call["targets"]}
            push_rows = [p for p in rows if state_by_id.get(str(p.id)) != "in_call"]
            await dispatch_call_pushes(
                db=db, targets=push_rows, room=room, caller_name=caller_name,
                call_id=str(call["call_id"]), settings=get_settings(),
            )
        except Exception:
            logger.warning("call_push_dispatch_error", exc_info=True)

    return RingResponse(
        call_id=call.get("call_id") if call["state"] == "ringing" else None,
        room_id=str(room.id),
        state=call["state"],
        started_at=call.get("started_at") if call["state"] == "ringing" else None,
        expires_at=call.get("expires_at") if call["state"] == "ringing" else None,
        ring_timeout_seconds=_cs.RING_TIMEOUT_S,
        targets=[CalleeStateOut(**t) for t in call["targets"]],
    )


async def _load_live_call(svc: CallService, call_id: str) -> dict[str, Any]:
    call = await svc.get_call(call_id)
    if call is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such call")
    if call.get("state") != "ringing":
        # 410, not 404: the call existed and is over. The client distinguishes
        # these — "that call already ended" is a real answer, and it is what
        # lets a device that raced a timeout put its banner down honestly
        # instead of retrying.
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=f"That call already ended ({call.get('state')}).",
        )
    return call


def _require_callee(call: dict[str, Any], participant_id: str) -> None:
    if participant_id not in {str(t["id"]) for t in call.get("targets", [])}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not being called.",
        )


@router.post("/calls/{call_id}/accept", response_model=CallActionResponse)
async def accept_call(
    call_id: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> CallActionResponse:
    """Callee answers. Joining LiveKit is a separate, already-authorized step.

    This route does NOT mint a LiveKit token — `/tokens/livekit` does, and it
    re-checks room membership there. Accepting is purely the signalling half:
    tell the caller they were answered, and tell this callee's OTHER devices to
    stop ringing.
    """
    svc = _svc(redis)
    call = await _load_live_call(svc, call_id)
    _require_callee(call, str(user["participant_id"]))
    call = await svc.accept(
        call,
        participant_id=str(user["participant_id"]),
        display_name=user.get("display_name") or user.get("username") or "Someone",
    )
    return CallActionResponse(call_id=call_id, room_id=str(call["room_id"]), state="accepted")


@router.post("/calls/{call_id}/decline", response_model=CallActionResponse)
async def decline_call(
    call_id: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> CallActionResponse:
    """Callee declines — the caller is told, immediately and by name."""
    svc = _svc(redis)
    call = await _load_live_call(svc, call_id)
    _require_callee(call, str(user["participant_id"]))
    call = await svc.decline(
        call,
        participant_id=str(user["participant_id"]),
        display_name=user.get("display_name") or user.get("username") or "Someone",
    )
    return CallActionResponse(call_id=call_id, room_id=str(call["room_id"]), state="declined")


@router.post("/calls/{call_id}/cancel", response_model=CallActionResponse)
async def cancel_call(
    call_id: str,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> CallActionResponse:
    """Caller gives up before an answer — every ringing device stops ringing."""
    svc = _svc(redis)
    call = await _load_live_call(svc, call_id)
    if str(call["caller_id"]) != str(user["participant_id"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the caller can cancel this call.",
        )
    call = await svc.cancel(
        call,
        participant_id=str(user["participant_id"]),
        display_name=user.get("display_name") or user.get("username") or "Someone",
    )
    return CallActionResponse(call_id=call_id, room_id=str(call["room_id"]), state="canceled")
