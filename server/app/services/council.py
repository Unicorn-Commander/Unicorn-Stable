"""Council mode — fan a question out to a diverse panel of models in parallel,
then synthesize one answer.

Opt-in per turn via the ``/council`` composer command (which stamps
``message.metadata.council = true``). The room's resident agent answers the same
question under several different underlying models (the curated switcher lanes —
Claude Sonnet, Kimi, DeepSeek by default), then one synthesis pass distills them
into a single reply that also shows each model's take. This is the sanctioned
"parallel fan-out + synthesis (council)" pattern.

All model calls reuse the responder's own ``_call_brigade`` with a per-call
``model`` override (the same mechanism as the mid-conversation model switcher),
so no new infra. Fully fail-safe: fewer than two usable models → returns False
(the agent just answers normally); an error mid-council finalizes the placeholder
with whatever was gathered.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import structlog

from app.api.brigade import _SWITCHER_MODELS
from app.config import Settings
from app.services.livekit_service import LiveKitService
from app.services.message_service import MessageService

logger = structlog.get_logger(__name__)

# id -> human label, from the curated switcher menu (single source of truth).
_LABELS: dict[str, str] = {m["id"]: m.get("label", m["id"]) for m in _SWITCHER_MODELS}
_VALID_IDS = set(_LABELS)

# Default council panel: the switcher ids that ACTUALLY route 200 through the
# gateway today (probed 2026-07-07) — the local house brain + a cloud lane, two
# genuinely distinct models. The four openrouter/* lanes (Claude/Kimi) currently
# 400 "not a valid model ID" at the gateway, so they're excluded until that
# routing is fixed. Override with env STABLE_COUNCIL_MODELS (comma-separated
# switcher ids); unknown ids are dropped, and any dead member degrades to an
# "unavailable" line rather than breaking the council.
_DEFAULT_PANEL = [
    "uc/chat-default-nothink",
    "deepseek-v4-flash",
]
# Model used for the final synthesis pass (falls back to agent default if unset).
_SYNTH_MODEL = os.getenv("STABLE_COUNCIL_SYNTH_MODEL", "deepseek-v4-flash")
_MAX_PANEL = 5


def _panel_models() -> list[str]:
    raw = os.getenv("STABLE_COUNCIL_MODELS", "").strip()
    ids = [x.strip() for x in raw.split(",") if x.strip()] if raw else list(_DEFAULT_PANEL)
    # keep only verified switcher ids, de-dupe preserving order, cap
    seen: set[str] = set()
    out: list[str] = []
    for i in ids:
        if i in _VALID_IDS and i not in seen:
            seen.add(i)
            out.append(i)
        if len(out) >= _MAX_PANEL:
            break
    return out


async def try_council(
    *,
    db: Any,
    settings: Settings,
    livekit: LiveKitService,
    room: Any,
    user_msg: Any,
    sender_id: Any,
    agent_id: str,
    agent_participant: Any,
    history: list[dict[str, str]],
) -> bool:
    """Return True if the council handled the turn (caller skips the normal
    reply); False to fall through to a normal single-model answer."""
    from app.services.agent_chat_responder import (
        _call_brigade,
        _patch_message,
        _send_typing,
        _stream_patch,
        _ws_deliver_to_room,
    )

    panel = _panel_models()
    if len(panel) < 2:
        logger.info("council_skip_too_few_models", n=len(panel))
        return False

    question = user_msg.content or ""
    user_id = str(sender_id) if sender_id else "anonymous"

    await _send_typing(
        livekit=livekit,
        livekit_room_name=room.livekit_room_name,
        room_id=room.id,
        brigade_agent_id=agent_id,
        typing=True,
    )
    svc = MessageService(db=db, livekit=livekit)
    placeholder = await svc.send_message(
        room_id=room.id,
        sender_id=agent_participant.id,
        content=f"🏛️ _Convening a council of {len(panel)} models…_",
        content_type="text",
        metadata={"agent_id": agent_id, "source": "agent_chat_responder", "council": {"models": panel}},
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
        logger.debug("council_ws_new_failed", exc_info=True)

    async def _ask(model_id: str) -> tuple[str, str]:
        try:
            text, _ = await _call_brigade(
                settings=settings,
                brigade_agent_id=agent_id,
                user_id=user_id,
                messages=history,
                room=room,
                model=model_id,
            )
            return model_id, (text or "").strip() or "_(no answer)_"
        except Exception as exc:  # noqa: BLE001
            logger.warning("council_member_failed", model=model_id, err=str(exc))
            return model_id, f"_(unavailable: {exc.__class__.__name__})_"

    try:
        # Fan out to the whole panel concurrently (each _call_brigade owns its
        # own HTTP client, so this is safe).
        results = await asyncio.gather(*[_ask(m) for m in panel])

        await _stream_patch(
            room_id=room.id,
            message_id=placeholder.id,
            content=f"🏛️ _Synthesizing {len(results)} responses…_",
        )

        # Synthesis pass: hand the panel's answers to one model to distill.
        panel_block = "\n\n".join(
            f"### {_LABELS.get(mid, mid)}\n{ans}" for mid, ans in results
        )
        synth_prompt = (
            "You are the chair of a model council. Several assistants each answered "
            "the same user question. Write a single, decisive synthesis for the user: "
            "lead with the best answer, note any meaningful disagreement, and do not "
            "attribute lines to specific models (their individual answers are shown "
            "separately below your synthesis).\n\n"
            f'User question:\n"""\n{question}\n"""\n\n'
            f"The council's answers:\n{panel_block}\n\n"
            "Your synthesis:"
        )
        synth_model = _SYNTH_MODEL if _SYNTH_MODEL in _VALID_IDS else None
        try:
            synthesis, _ = await _call_brigade(
                settings=settings,
                brigade_agent_id=agent_id,
                user_id=user_id,
                messages=[{"role": "user", "content": synth_prompt}],
                room=room,
                model=synth_model,
            )
            synthesis = (synthesis or "").strip()
        except Exception:
            logger.warning("council_synth_failed", exc_info=True)
            synthesis = ""

        details = "\n\n".join(
            f"**{_LABELS.get(mid, mid)}**\n\n{ans}" for mid, ans in results
        )
        if synthesis:
            final = (
                f"🏛️ **Council synthesis** — {len(results)} models\n\n"
                f"{synthesis}\n\n---\n\n"
                f"<sub>Individual answers</sub>\n\n{details}"
            )
        else:
            final = f"🏛️ **Council** — {len(results)} models answered\n\n{details}"

        await _patch_message(
            db=db,
            livekit=livekit,
            message_id=placeholder.id,
            content=final,
            finalize=True,
            extra_metadata={"council": {"models": panel}},
        )
        logger.info("council_done", models=panel, synth=bool(synthesis))
        return True
    except Exception:
        logger.warning("council_failed", exc_info=True)
        try:
            await _patch_message(
                db=db,
                livekit=livekit,
                message_id=placeholder.id,
                content="_(the council ran into an error — try again)_",
                finalize=True,
            )
        except Exception:
            pass
        return True  # placeholder already posted; we handled the turn
    finally:
        await _send_typing(
            livekit=livekit,
            livekit_room_name=room.livekit_room_name,
            room_id=room.id,
            brigade_agent_id=agent_id,
            typing=False,
        )
