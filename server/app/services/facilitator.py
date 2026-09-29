"""Facilitator mode — orchestrator picks the right specialist, specialist
answers in-room as itself.

Opt-in per turn via the ``/facilitate`` composer command (which stamps
``message.metadata.facilitate = true``). When the room's resident agent is an
orchestrator (Brigade ``domain == "orchestration"``, an "Orchestrator" title,
or the ``delegate_to_agent`` tool), the responder calls ``try_facilitate``:

  1. fetch the live Brigade roster and build a specialist menu,
  2. ask the orchestrator (one short non-streaming turn) which specialist should
     handle the request — or ANSWER to handle it itself,
  3. if it named a specialist, invite that agent into the room and let IT answer
     (streamed, as itself), tagged ``delegated_from`` so the UI shows who routed.

This is the market-winning "orchestrator picks next speaker, hard turn cap"
pattern, implemented Stable-side so the cap lives under our control (exactly ONE
hand-off, no recursion) and the specialist visibly participates — rather than the
orchestrator silently absorbing the answer via Brigade's own delegate tool.

Everything is fail-safe: any error / empty roster / self-answer returns ``False``
so the orchestrator just answers normally (unchanged behaviour). No Brigade
rebuild — this only uses Brigade's existing ``GET /agents`` + ``/agents/{id}/chat``
contracts, and reuses the responder's own post/stream primitives.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx
import structlog
from fastapi import HTTPException
from sqlalchemy import select

from app.config import Settings
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import MemberRole, Room, RoomMember
from app.services.agent_routing import find_agent_participant, participant_backend
from app.services.livekit_service import LiveKitService
from app.services.message_service import MessageService

logger = structlog.get_logger(__name__)

_ROSTER_TIMEOUT = 12.0
_MAX_MENU = 40
# Roster statuses we treat as reachable; anything else (e.g. "offline") is skipped.
_OK_STATUS = {None, "active", "online", "available", "idle"}


def _is_orchestrator(a: dict[str, Any] | None) -> bool:
    # Narrow on purpose: the `delegate_to_agent` tool is spread across many
    # specialists (legal drafters, cmo, claude, …), so tool possession is NOT a
    # reliable orchestrator signal. Only a true orchestration domain or an
    # "Orchestrator" title qualifies → majik / gflow / the-general / the-fixer.
    if not a:
        return False
    domain = (a.get("domain") or "").lower()
    title = (a.get("title") or "").lower()
    return domain == "orchestration" or "orchestrator" in title


def _who(a: dict[str, Any]) -> str:
    return a.get("displayName") or a.get("name") or a.get("id") or "agent"


async def _fetch_roster(settings: Settings) -> list[dict[str, Any]]:
    """GET Brigade's agent roster. Returns [] on any problem (fail-safe)."""
    base = settings.brigade_api_base_url.rstrip("/")
    url = f"{base}/agents"
    try:
        async with httpx.AsyncClient(timeout=_ROSTER_TIMEOUT) as client:
            r = await client.get(url, headers={"X-API-Key": settings.brigade_api_key})
        if r.status_code != 200:
            logger.warning("facilitate_roster_http", status=r.status_code)
            return []
        data = r.json()
        agents = data.get("agents") if isinstance(data, dict) else data
        return [a for a in agents if isinstance(a, dict)] if isinstance(agents, list) else []
    except Exception:
        logger.warning("facilitate_roster_failed", exc_info=True)
        return []


def _parse_choice(reply: str, specialist_ids: list[str]) -> str | None:
    """Extract the chosen specialist id from the orchestrator's routing reply.

    Accepts an exact id, an id embedded in a sentence, or ``ANSWER``/none → None.
    Longer ids are matched first so a substring id can't shadow a longer one.
    """
    low = (reply or "").strip().lower()
    if not low:
        return None
    for sid in specialist_ids:
        if low == sid.lower():
            return sid
    for sid in sorted(specialist_ids, key=len, reverse=True):
        if re.search(r"(^|[^a-z0-9-])" + re.escape(sid.lower()) + r"([^a-z0-9-]|$)", low):
            return sid
    return None


async def _ensure_member(
    db: Any, room: Room, agent_id: str, entry: dict[str, Any]
) -> Participant:
    """Resolve (auto-create) the specialist's Participant and ensure it's a
    member of the room, mirroring _resolve_agent's bootstrap so send_message's
    membership check passes."""
    sub = f"brigade:{agent_id}"
    # Nav v3 R5 / P2-8: a Brigade roster id that is ALSO someone's runner
    # seat (perry, producer…) is never added by the facilitator — exactly
    # the 409 invite-brigade-agent gives. Adding the seat would post Brigade
    # text as that seat and hand it a watched line.
    if participant_backend(await find_agent_participant(db, agent_id)) == "runner":
        raise HTTPException(
            status_code=409,
            detail=f"'{agent_id}' is a runner seat; the facilitator never adds seats",
        )
    p = (
        await db.execute(select(Participant).where(Participant.keycloak_sub == sub))
    ).scalar_one_or_none()
    if p is None:
        p = Participant(
            keycloak_sub=sub,
            username=f"agent-{agent_id}",
            display_name=_who(entry) if _who(entry) != agent_id else agent_id.replace("-", " ").title(),
            participant_type=ParticipantType.AGENT,
            status=ParticipantStatus.ONLINE,
            avatar_url=entry.get("avatarUrl") or None,
        )
        db.add(p)
        await db.commit()
        await db.refresh(p)
    existing = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.id,
                RoomMember.participant_id == p.id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(RoomMember(room_id=room.id, participant_id=p.id, role=MemberRole.MEMBER))
        await db.commit()
    return p


async def _route(
    *,
    settings: Settings,
    orchestrator_id: str,
    question: str,
    specialists: list[dict[str, Any]],
    user_id: str,
    room: Room,
) -> str:
    """One short non-streaming turn: ask the orchestrator who should answer."""
    lines = []
    for a in specialists[:_MAX_MENU]:
        focus = a.get("title") or a.get("domain") or a.get("subdomain") or ""
        lines.append(f"- {a['id']}: {_who(a)}" + (f" — {focus}" if focus else ""))
    menu = "\n".join(lines)
    prompt = (
        "You are triaging a request inside a team chat room. Decide which ONE "
        "specialist should answer it, or answer it yourself.\n\n"
        f'User\'s request:\n"""\n{question}\n"""\n\n'
        f"Available specialists (id: who — focus):\n{menu}\n\n"
        "Reply with ONLY the single best specialist id, exactly as written above. "
        "If none fit or you should handle it yourself, reply with exactly: ANSWER. "
        "Output just the id or ANSWER — nothing else."
    )
    from app.services.agent_chat_responder import _call_brigade

    reply, _ = await _call_brigade(
        settings=settings,
        brigade_agent_id=orchestrator_id,
        user_id=user_id,
        messages=[{"role": "user", "content": prompt}],
        room=room,
        model=None,
    )
    return reply or ""


async def _specialist_reply(
    *,
    db: Any,
    settings: Settings,
    livekit: LiveKitService,
    room: Room,
    specialist_id: str,
    spec_participant: Participant,
    history: list[dict[str, str]],
    user_id: str,
    delegated_from: dict[str, Any],
) -> None:
    """Post the specialist's streamed reply into the room, as the specialist,
    tagged with who delegated to it. Reuses the responder's own primitives."""
    from app.services.agent_chat_responder import (
        _call_brigade,
        _patch_message,
        _send_typing,
        _stream_patch,
        _ws_deliver_to_room,
    )

    await _send_typing(
        livekit=livekit,
        livekit_room_name=room.livekit_room_name,
        room_id=room.id,
        brigade_agent_id=specialist_id,
        typing=True,
    )
    svc = MessageService(db=db, livekit=livekit)
    placeholder = await svc.send_message(
        room_id=room.id,
        sender_id=spec_participant.id,
        content="…",
        content_type="text",
        metadata={
            "agent_id": specialist_id,
            "source": "agent_chat_responder",
            "delegated_from": delegated_from,
        },
    )
    try:
        from app.api.messages import _msg_to_response as _ser

        await _ws_deliver_to_room(
            db=db,
            room_id=room.id,
            envelope={
                "type": "message",
                "payload": {
                    "room_id": str(room.id),
                    "streaming": True,
                    "message": _ser(placeholder, 0).model_dump(mode="json"),
                },
            },
        )
    except Exception:
        logger.debug("facilitate_ws_new_failed", exc_info=True)

    _last = [0.0]

    async def _on_progress(text: str, is_content: bool) -> None:
        now = asyncio.get_running_loop().time()
        if (not is_content) or (now - _last[0] >= 0.12):
            _last[0] = now
            await _stream_patch(room_id=room.id, message_id=placeholder.id, content=text)

    accumulated = ""
    artifact_meta: dict[str, str] | None = None
    try:
        accumulated, artifact_meta = await _call_brigade(
            settings=settings,
            brigade_agent_id=specialist_id,
            user_id=user_id,
            messages=history,
            room=room,
            model=None,
            on_progress=_on_progress,
        )
    except Exception as exc:
        logger.exception("facilitate_specialist_call_failed")
        if not accumulated:
            accumulated = f"_(couldn't reach the specialist: {exc.__class__.__name__})_"
    finally:
        if not accumulated.strip():
            accumulated = "_(empty reply)_"
        final_meta: dict[str, Any] = dict(artifact_meta or {})
        final_meta["delegated_from"] = delegated_from
        await _patch_message(
            db=db,
            livekit=livekit,
            message_id=placeholder.id,
            content=accumulated,
            finalize=True,
            extra_metadata=final_meta,
        )
        await _send_typing(
            livekit=livekit,
            livekit_room_name=room.livekit_room_name,
            room_id=room.id,
            brigade_agent_id=specialist_id,
            typing=False,
        )


async def try_facilitate(
    *,
    db: Any,
    settings: Settings,
    livekit: LiveKitService,
    room: Room,
    user_msg: Any,
    sender_id: Any,
    orchestrator_id: str,
    orchestrator_participant: Participant,
    history: list[dict[str, str]],
) -> bool:
    """Return True if a specialist handled the turn (caller skips the normal
    orchestrator reply); False to fall through to the orchestrator answering."""
    try:
        roster = await _fetch_roster(settings)
        if not roster:
            return False
        by_id = {a["id"]: a for a in roster if a.get("id")}
        orch = by_id.get(orchestrator_id)
        if not _is_orchestrator(orch):
            logger.info("facilitate_skip_not_orchestrator", agent=orchestrator_id)
            return False
        specialists = [
            a
            for a in roster
            if a.get("id")
            and a["id"] != orchestrator_id
            and not _is_orchestrator(a)
            and (a.get("status") in _OK_STATUS)
        ]
        if not specialists:
            logger.info("facilitate_no_specialists", agent=orchestrator_id)
            return False

        user_id = str(sender_id) if sender_id else "anonymous"
        reply = await _route(
            settings=settings,
            orchestrator_id=orchestrator_id,
            question=user_msg.content or "",
            specialists=specialists,
            user_id=user_id,
            room=room,
        )
        choice = _parse_choice(reply, [s["id"] for s in specialists])
        if not choice:
            logger.info("facilitate_self_answer", agent=orchestrator_id, reply=reply[:80])
            return False

        entry = by_id[choice]
        spec_participant = await _ensure_member(db, room, choice, entry)
        delegated_from = {
            "agent_id": orchestrator_id,
            "name": _who(orch or {}),
            "emoji": (orch or {}).get("avatar"),
        }
        await _specialist_reply(
            db=db,
            settings=settings,
            livekit=livekit,
            room=room,
            specialist_id=choice,
            spec_participant=spec_participant,
            history=history,
            user_id=user_id,
            delegated_from=delegated_from,
        )
        logger.info("facilitate_delegated", orchestrator=orchestrator_id, specialist=choice)
        return True
    except Exception:
        logger.warning("facilitate_failed", exc_info=True)
        return False
