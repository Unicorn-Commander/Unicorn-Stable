"""Read-aloud TTS proxy.

The browser cannot reach the LAN-only kokoro GPU host, so this endpoint
proxies ``POST /api/v1/tts`` to the kokoro front (``settings.kokoro_base_url``,
OpenAI-body-compatible ``/v1/audio/speech``) and returns the synthesized audio
to the authenticated caller as mp3 (~10x smaller than wav over the WAN).

Voice selection: an explicit ``voice`` wins; else ``agent`` (the sender's
brigade agent id or display name) resolves through AGENT_VOICES — the same
presets the live voice pipeline uses — else the suite default (af_heart).

History: this used to chunk text to <=300 chars and stitch WAVs because the
uc-1 kokoro server 500'd on multi-chunk synthesis (kokoro-onnx returns (1, N)
batch-shaped audio; its np.concatenate choked). That was fixed at the source
(flatten + mp3 transcode, 2026-07-05), so this proxy is a single pass-through
again. Kept deliberately dumb: no caching, no persistence.
"""

from __future__ import annotations

import re
from typing import Annotated, Any

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.config import Settings
from app.deps import get_current_user, get_settings_dep, rate_limit

logger = structlog.get_logger(__name__)

router = APIRouter()

MAX_TTS_CHARS = 4000

# Mirror of the voice-call presets in agents/plugins/tts.py (VOICE_PRESETS) —
# keep the two in sync when adding agents. Unknown-but-named agents get the
# same "default" the voice pipeline uses (af_bella); requests with no agent at
# all fall back to settings.tts_default_voice (af_heart, Majik).
AGENT_VOICES = {
    "majik": "af_heart",
    "the-general": "am_michael",
    "gunny": "am_adam",
    "judge-advocate": "bm_lewis",
    "detective-holmes": "bm_daniel",
    "doc-medresearch": "af_nicole",
    "col-finance": "bm_lewis",
    "cpt-fullstack": "am_adam",
    "code-reviewer": "am_michael",
    "maj-devops": "am_michael",
    "sgt-cipher": "am_adam",
    "sgt-scribe": "af_bella",
    "sgt-swift": "am_echo",
    "sgt-cocoa": "am_onyx",
    "prof-datasci": "af_bella",
    "sql-analyst": "af_bella",
    "lt-docanalyst": "af_nicole",
    "lt-taxstrat": "bm_lewis",
    "maj-leadgen": "af_bella",
    "support-agent": "af_bella",
    "evidence-correlator": "bm_daniel",
    "gap-analyzer": "bm_daniel",
    "timeline-builder": "bm_daniel",
    "triage": "am_michael",
}
AGENT_DEFAULT_VOICE = "af_bella"


def _normalize_agent(name: str) -> str:
    # "Sgt. Swift" / "sgt_swift" / "Sgt Swift" -> "sgt-swift"
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TTS_CHARS)
    voice: str | None = None
    agent: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@router.post("/tts")
async def synthesize_speech(
    body: TtsRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    _rl: Annotated[None, Depends(rate_limit("tts", "rate_limit_tts_per_min"))],
) -> Response:
    if body.voice:
        voice = body.voice
    elif body.agent:
        voice = AGENT_VOICES.get(_normalize_agent(body.agent), AGENT_DEFAULT_VOICE)
    else:
        voice = settings.tts_default_voice

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.post(
                f"{settings.kokoro_base_url}/v1/audio/speech",
                json={
                    "model": "kokoro",
                    "input": body.text,
                    "voice": voice,
                    "response_format": "mp3",
                    "speed": body.speed,
                },
            )
    except httpx.HTTPError:
        logger.warning("tts_upstream_unreachable", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TTS service unreachable",
        ) from None

    if upstream.status_code != 200:
        logger.warning(
            "tts_upstream_error",
            status=upstream.status_code,
            body=upstream.text[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TTS synthesis failed",
        )

    logger.info(
        "tts_synthesized",
        participant_id=user.get("participant_id") or user.get("sub"),
        chars=len(body.text),
        agent=body.agent,
        voice=voice,
    )
    return Response(
        content=upstream.content,
        media_type=upstream.headers.get("content-type", "audio/mpeg"),
    )
