"""Post each voice-dispatch decision to Stable.

The server appends an ``agent_events`` row (type ``voice_dispatch``) and
fans a room-scoped WebSocket event ``voice_dispatch`` ``{winner, rule}``
for the floor pill. This poster never raises and never logs the utterance
or the bearer.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import structlog

from agent_runtime.config import AgentSettings, api_path, get_agent_settings
from agent_runtime.voice_dispatch import set_decision_recorder

logger = structlog.get_logger(__name__)


def _post_sync_schedule(settings: AgentSettings, record: dict[str, Any]) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_post(settings, record), name="voice-dispatch-log")


async def _post(settings: AgentSettings, record: dict[str, Any]) -> None:
    secret = (settings.internal_agent_secret or settings.livekit_api_secret or "").strip()
    if not secret:
        logger.info("voice_dispatch_log_skipped", reason="no internal secret")
        return
    base = (settings.stable_backend_url or "").rstrip("/")
    if not base:
        return
    body = {
        "room": record.get("room") or "",
        "speaker": record.get("speaker") or "",
        "text_hash": record.get("text_hash") or "",
        "rule": record.get("rule") or "",
        "winner": record.get("winner"),
        "human_count": int(record.get("human_count") or 0),
        "shared_mic": bool(record.get("shared_mic")),
        "agent_identity": record.get("agent_identity") or "voice-dispatch",
        "agent_type": record.get("agent_type") or "voice",
    }
    try:
        async with httpx.AsyncClient(timeout=2.0) as http:
            response = await http.post(
                f"{base}{api_path('internal/voice-dispatch')}",
                json=body,
                headers={"Authorization": f"Bearer {secret}"},
            )
        if response.status_code >= 300:
            logger.warning(
                "voice_dispatch_log_http_error",
                status_code=response.status_code,
            )
    except Exception:
        logger.warning("voice_dispatch_log_failed", exc_info=True)


def install_dispatch_logger(settings: AgentSettings | None = None) -> None:
    """Send every later ``decide()`` to the server. Safe to call more than once."""
    cfg = settings or get_agent_settings()

    def _record(payload: dict[str, Any]) -> None:
        _post_sync_schedule(cfg, payload)

    set_decision_recorder(_record)
    logger.info("voice_dispatch_logger_installed")
