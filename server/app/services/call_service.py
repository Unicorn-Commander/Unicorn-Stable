from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import structlog
from redis.asyncio import Redis

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Direct calls ("ringing") — Redis-backed, no schema
# ---------------------------------------------------------------------------
#
# A direct call is an EPHEMERAL offer, not a record: it lives ~45 seconds and
# then it is either answered or it is nothing. That is exactly the shape
# presence_service already has, so this rides the same Redis and deliberately
# adds no table and no migration.
#
# THE ONE INVARIANT: the 45s ring deadline is decided HERE, published on the
# wire as `expires_at` + `ring_timeout_seconds`, and every client derives its
# own timer from that value rather than from a local constant. The banner used
# to own a private RING_TIMEOUT_MS; two independent clocks on two machines
# disagree the moment either end is slow, and the visible failure is a callee
# whose banner is still ringing for a call the server already declared dead.
# (`_typing_payload` publishes `ttl_seconds` for the same reason.)
#
# EVERY terminal path publishes to BOTH sides. There is no path that ends a
# call for one party only — see `_resolve`, which is the single exit.

#: How long an unanswered call rings before the server declares "no answer".
RING_TIMEOUT_S: int = 45
#: Grace on the state key so a late accept/decline gets 410 rather than 404.
_STATE_GRACE_S: int = 30

#: `call:{id}` → the call record. `callring:{participant_id}` → the call that
#: participant is currently engaged in (busy latch, both caller and callees).
_CALL_KEY = "call:{call_id}"
_BUSY_KEY = "callring:{participant_id}"

CalleeState = Literal["ringing", "offline", "busy", "unknown"]
Resolution = Literal["accepted", "declined", "canceled", "timeout"]

#: Presence facts we are willing to assert. "unknown" is NOT a synonym for
#: "offline": it means the presence store could not be consulted. Ringing a
#: possibly-online person is the right call there, but telling their caller
#: "they're offline" on the strength of a Redis timeout is a lie, so the two
#: stay distinct all the way to the caller's UI.
PresenceFact = Literal["online", "offline", "unknown"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CallService:
    """Lifecycle for direct (ringing) calls: ring → accept/decline/cancel/timeout.

    Fan-out goes over the Redis channel `user:{participant_id}`, which
    ``ws/handler._subscribe_to_rooms`` already subscribes every socket to. That
    choice is load bearing twice over:

    * **Multi-worker.** ``ws.handler.manager`` (ConnectionManager) is an
      in-process dict, so a ring handled by worker A could never reach a socket
      held by worker B. Redis pub/sub crosses workers.
    * **Multi-device.** ConnectionManager stores ONE socket per participant id
      (`_connections[pid] = ws`), so a second device silently evicts the first
      from the map. Each WebSocket, by contrast, opens its OWN pubsub and
      subscribes to `user:{pid}` — so N devices genuinely get N deliveries.
      That is what makes "both my laptops ring" work, and it is why answering
      on one stops the other: the `call_resolved` frame goes to the same
      channel and every device dismisses on it.
    """

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    # -- presence ---------------------------------------------------------

    async def presence_of(self, participant_id: str) -> PresenceFact:
        """Is this participant reachable? Never guesses.

        ``PresenceService.get_status`` collapses "no key" and "no Redis" into
        the string "offline" (a missing key returns "offline"; a Redis fault
        raises past it). For ringing we must not: "they are offline" is a
        claim we show the caller, and we may only make it when we actually
        read the presence store and found nothing.
        """
        try:
            val = await self._redis.get(f"presence:{participant_id}")
        except Exception:
            logger.warning("call_presence_probe_failed", participant_id=participant_id, exc_info=True)
            return "unknown"
        if val is None:
            return "offline"
        return "online"

    # -- busy latch -------------------------------------------------------

    async def _is_busy(self, participant_id: str) -> bool:
        try:
            return bool(await self._redis.exists(_BUSY_KEY.format(participant_id=participant_id)))
        except Exception:
            # Can't prove busy → don't claim busy. Worst case we ring someone
            # who is already talking, and their client suppresses it
            # (incomingCallStore drops a ring while `voiceActive`).
            logger.warning("call_busy_probe_failed", participant_id=participant_id, exc_info=True)
            return False

    async def _mark_busy(self, participant_id: str, call_id: str, ttl: int) -> None:
        await self._redis.set(
            _BUSY_KEY.format(participant_id=participant_id), call_id, ex=ttl
        )

    async def _clear_busy(self, participant_id: str, call_id: str) -> None:
        """Release the latch only if it is still OURS.

        A blind DELETE would let a timed-out call clear the latch of the *next*
        call the same person already started, handing them a phantom "busy"
        gap. Compare-then-delete keeps each call responsible for its own key.
        """
        key = _BUSY_KEY.format(participant_id=participant_id)
        try:
            cur = await self._redis.get(key)
            if cur is None:
                return
            if isinstance(cur, bytes):
                cur = cur.decode("utf-8")
            if str(cur) == call_id:
                await self._redis.delete(key)
        except Exception:
            logger.debug("call_busy_clear_failed", participant_id=participant_id, exc_info=True)

    # -- state ------------------------------------------------------------

    async def get_call(self, call_id: str) -> dict[str, Any] | None:
        try:
            raw = await self._redis.get(_CALL_KEY.format(call_id=call_id))
        except Exception:
            logger.warning("call_state_read_failed", call_id=call_id, exc_info=True)
            return None
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    async def _put_call(self, call: dict[str, Any], ttl: int) -> None:
        await self._redis.set(
            _CALL_KEY.format(call_id=call["call_id"]), json.dumps(call), ex=ttl
        )

    # -- publishing -------------------------------------------------------

    async def _publish_user(self, participant_id: str, payload: dict[str, Any]) -> None:
        """One user-channel frame. A dead subscriber must not strand the rest."""
        try:
            await self._redis.publish(f"user:{participant_id}", json.dumps(payload))
        except Exception:
            logger.warning(
                "call_publish_failed",
                participant_id=participant_id,
                event=payload.get("type"),
                exc_info=True,
            )

    # -- ring -------------------------------------------------------------

    async def ring(
        self,
        *,
        room_id: str,
        room_type: str,
        room_name: str,
        caller_id: str,
        caller_name: str,
        caller_avatar_url: str | None,
        callees: list[dict[str, str | None]],
    ) -> dict[str, Any]:
        """Offer a call to `callees` and return the caller's feedback record.

        `callees` is [{id, display_name}] — the OTHER human members of the DM,
        resolved and authorized by the caller. Agents are not rung: an agent is
        dispatched into a call, it does not answer a phone.

        Returns the record the caller's UI renders as "Ringing Shafen…" /
        "Shafen is offline" — every callee gets a state, so the caller is never
        left staring at nothing.
        """
        call_id = str(uuid.uuid4())
        started = _now()
        expires = started + timedelta(seconds=RING_TIMEOUT_S)

        targets: list[dict[str, Any]] = []
        for c in callees:
            cid = str(c["id"])
            state: CalleeState
            fact = await self.presence_of(cid)
            if await self._is_busy(cid):
                state = "busy"
            elif fact == "offline":
                state = "offline"
            elif fact == "unknown":
                # Ring anyway — we could not prove they're away — but SAY that
                # we could not tell, rather than dressing it up as "ringing".
                state = "unknown"
            else:
                state = "ringing"
            targets.append({"id": cid, "display_name": c.get("display_name") or "Someone", "state": state})

        rung = [t for t in targets if t["state"] in ("ringing", "unknown")]

        call = {
            "call_id": call_id,
            "room_id": room_id,
            "room_type": room_type,
            "room_name": room_name,
            "caller_id": caller_id,
            "caller_name": caller_name,
            "caller_avatar_url": caller_avatar_url,
            "started_at": started.isoformat(),
            "expires_at": expires.isoformat(),
            "targets": targets,
            "state": "ringing" if rung else "unreachable",
        }

        if not rung:
            # Nobody to ring. No state is stored and no timer is armed: an
            # offer with no recipient is not a pending call, and leaving a
            # record behind would busy-latch a caller who never got through.
            logger.info("call_ring_unreachable", call_id=call_id, room_id=room_id, targets=targets)
            return call

        ttl = RING_TIMEOUT_S + _STATE_GRACE_S
        await self._put_call(call, ttl)
        # The caller is busy for the ring window too — otherwise a second
        # inbound call rings over their own outgoing one.
        await self._mark_busy(caller_id, call_id, RING_TIMEOUT_S)

        offer = {
            "type": "call_started",
            "call_id": call_id,
            "room_id": room_id,
            "room_type": room_type,
            "room_name": room_name,
            "caller": {
                "id": caller_id,
                "display_name": caller_name,
                "avatar_url": caller_avatar_url,
            },
            "started_at": call["started_at"],
            "expires_at": call["expires_at"],
            "ring_timeout_seconds": RING_TIMEOUT_S,
        }
        for t in rung:
            await self._mark_busy(str(t["id"]), call_id, RING_TIMEOUT_S)
            await self._publish_user(str(t["id"]), offer)

        logger.info(
            "call_ring_started",
            call_id=call_id,
            room_id=room_id,
            caller_id=caller_id,
            rung=[t["id"] for t in rung],
        )
        return call

    def arm_timeout(self, call_id: str) -> asyncio.Task[None]:
        """Arm the server's own no-answer clock for a ringing call.

        Held by the worker that served the ring; if that worker dies the state
        key's TTL still expires the call, so a late accept gets 410 rather than
        joining a call nobody is waiting in. The task is the *fast* path, the
        TTL is the floor — neither one alone leaves a caller ringing forever.
        """

        async def _run() -> None:
            try:
                await asyncio.sleep(RING_TIMEOUT_S)
                call = await self.get_call(call_id)
                if call is None or call.get("state") != "ringing":
                    return  # already accepted / declined / canceled
                await self._resolve(call, "timeout", by_id=None)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("call_timeout_task_failed", call_id=call_id)

        return asyncio.create_task(_run())

    # -- terminal transitions ---------------------------------------------

    async def _resolve(
        self,
        call: dict[str, Any],
        resolution: Resolution,
        *,
        by_id: str | None,
        by_name: str | None = None,
    ) -> dict[str, Any]:
        """THE single exit from a ringing call.

        Every terminal path funnels here precisely so that no path can end a
        call for one party and not the other: this writes the terminal state,
        releases every busy latch, tells the CALLER what happened, and tells
        EVERY callee device to take the banner down. A caller left ringing or a
        callee left with a stuck banner is only possible if a transition skips
        this function — so none of them do.
        """
        call_id = str(call["call_id"])
        call["state"] = resolution
        call["resolved_at"] = _now().isoformat()
        call["resolved_by"] = by_id
        try:
            await self._put_call(call, _STATE_GRACE_S)
        except Exception:
            logger.warning("call_state_write_failed", call_id=call_id, exc_info=True)

        target_ids = [str(t["id"]) for t in call.get("targets", [])]
        await self._clear_busy(str(call["caller_id"]), call_id)
        for tid in target_ids:
            await self._clear_busy(tid, call_id)

        # Caller feedback. `state` is the word their UI shows; "timeout" is
        # rendered as "No answer".
        await self._publish_user(
            str(call["caller_id"]),
            {
                "type": "call_ring_state",
                "call_id": call_id,
                "room_id": call["room_id"],
                "state": resolution,
                "by": {"id": by_id, "display_name": by_name} if by_id else None,
            },
        )

        # Callee side: dismiss on EVERY device, including the one that acted
        # (it has already dismissed locally — the frame is idempotent).
        for tid in target_ids:
            await self._publish_user(
                tid,
                {
                    "type": "call_resolved",
                    "call_id": call_id,
                    "room_id": call["room_id"],
                    "reason": resolution,
                    "by_participant_id": by_id,
                },
            )

        logger.info("call_resolved", call_id=call_id, resolution=resolution, by=by_id)
        return call

    async def accept(self, call: dict[str, Any], *, participant_id: str, display_name: str) -> dict[str, Any]:
        return await self._resolve(call, "accepted", by_id=participant_id, by_name=display_name)

    async def decline(self, call: dict[str, Any], *, participant_id: str, display_name: str) -> dict[str, Any]:
        return await self._resolve(call, "declined", by_id=participant_id, by_name=display_name)

    async def cancel(self, call: dict[str, Any], *, participant_id: str, display_name: str) -> dict[str, Any]:
        return await self._resolve(call, "canceled", by_id=participant_id, by_name=display_name)
