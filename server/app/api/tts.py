"""Read-aloud TTS proxy.

The browser cannot reach the LAN-only kokoro GPU host, so this endpoint
proxies ``POST /api/v1/tts`` to the kokoro front (``settings.kokoro_base_url``,
OpenAI-body-compatible ``/v1/audio/speech``) and returns the synthesized audio
to the authenticated caller as mp3 (~10x smaller than wav over the WAN).

Voice selection: an explicit ``voice`` wins; else ``agent`` (the sender's
brigade agent id or display name) resolves through AGENT_VOICES — the same
presets the live voice pipeline uses — else the suite default (af_heart).

Read-aloud (``read_aloud=true``, the per-message speaker button in the web
client) is the lenient variant: the sender is resolved through the presets by
brigade id, participant identity ("agent-persephone") or display name
("Majik Mane"), and a sender with no preset — a human, a plain-model seat, an
unknown agent — gets ``settings.tts_read_aloud_default_voice`` instead of a
422. The 422 mattered: the client treated it as "Kokoro failed" and read the
message with the browser's speechSynthesis (Aaron, 2026-09-07). Callers that
pass ``agent`` without ``read_aloud`` keep the strict 422 so a typo in a
script is still caught.

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

# Mirror of the voice-call presets in agents/plugins/tts.py
# (KOKORO_VOICE_PRESETS) — that table is the source of truth; this copy exists
# only because the server image does not ship the agents package.
# tests/test_tts_read_aloud.py fails when the two drift. Unknown-but-named
# agents get the same "default" the voice pipeline uses (af_bella); requests
# with no agent at all fall back to settings.tts_default_voice (af_heart).
AGENT_VOICES = {
    # Majik is am_puck (agents/plugins/tts.py, Aaron 2026-08-10 "he needs a male
    # voice"); this mirror had drifted to af_heart, which is Persephone's since 2026-09-03.
    "majik": "am_puck",
    # Rook — Aaron's seat. Missing from this map on 2026-08-30 silently
    # fell through to af_bella, so agent:"rook" wore the wrong voice.
    "rook": "am_echo",
    "claude-code": "am_echo",
    # Persephone — Aaron's main assistant seat, 2026-09-03. Mirrors agents/plugins/tts.py.
    "persephone": "af_heart",
    "the-general": "am_michael",
    "gunny": "am_adam",
    # Perry and The Colonel, 2026-10-19 (mirrors agents/plugins/tts.py): the uc-1
    # Kokoro pack grew to 55 voices that day. Perry is bm_daniel's only holder;
    # the four legal-evidence agents keep bm_lewis, the voice they had always
    # resolved to through the old fallback map.
    "perry": "bm_daniel",
    "the-colonel": "am_fenrir",
    "judge-advocate": "bm_lewis",
    "detective-holmes": "bm_lewis",
    "doc-medresearch": "af_nicole",
    "col-finance": "bm_lewis",
    "cpt-fullstack": "am_adam",
    "code-reviewer": "am_michael",
    "maj-devops": "am_michael",
    "sgt-cipher": "am_adam",
    "sgt-scribe": "af_bella",
    # bm_lewis since 2026-08-28 (gave am_echo up for Rook); this mirror had
    # kept the old value.
    "sgt-swift": "bm_lewis",
    "sgt-cocoa": "am_onyx",
    "corporal-qwen": "bm_george",
    "prof-datasci": "af_bella",
    "sql-analyst": "af_bella",
    "lt-docanalyst": "af_nicole",
    "lt-taxstrat": "bm_lewis",
    "maj-leadgen": "af_bella",
    "support-agent": "af_bella",
    "evidence-correlator": "bm_lewis",
    "gap-analyzer": "bm_lewis",
    "timeline-builder": "bm_lewis",
    "triage": "am_michael",
}
AGENT_DEFAULT_VOICE = "af_bella"

# Names the read-aloud button sees that are not preset keys. Presets are keyed
# on brigade ids; a message carries the sender's display name (and sometimes
# the participant identity), so those are mapped back onto the preset key here
# rather than by growing a second table.
AGENT_ALIASES = {
    "majik-mane": "majik",
}

# Voices owned by a named crew seat. The read-aloud default may never be one
# of these: a plain model reading in Persephone's or Rook's voice is the same
# on-camera confusion the preset comments in agents/plugins/tts.py warn about.
RESERVED_SEAT_VOICES = frozenset({"af_heart", "am_echo", "am_puck", "am_michael"})

# Guard value if the configured read-aloud default is empty or reserved. Every
# male Kokoro voice is worn by some preset; am_adam's holders (gunny,
# cpt-fullstack, sgt-cipher; ShOX in the puppet manifest) are not Build In
# Public room regulars, whereas am_onyx (Grok), bm_lewis (Flow) and bm_george
# (Producer) are — so a default that collides with am_adam is heard least.
READ_ALOUD_FALLBACK_VOICE = "am_adam"


def _normalize_agent(name: str) -> str:
    # "Sgt. Swift" / "sgt_swift" / "Sgt Swift" -> "sgt-swift"
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def resolve_agent_voice(hint: str | None) -> str | None:
    """Preset voice for a sender hint, or None when the presets have no entry.

    Accepts a brigade id ("persephone"), a participant identity
    ("agent-persephone") or a display name ("Majik Mane", "The General").
    """
    if not hint:
        return None
    key = _normalize_agent(hint)
    if not key:
        return None
    candidates = [key]
    if key.startswith("agent-"):
        candidates.append(key[len("agent-"):])
    for candidate in candidates:
        candidate = AGENT_ALIASES.get(candidate, candidate)
        if candidate in AGENT_VOICES:
            return AGENT_VOICES[candidate]
    return None


def read_aloud_default_voice(settings: Settings) -> str:
    """The configured read-aloud default, refusing a reserved crew voice."""
    voice = (settings.tts_read_aloud_default_voice or "").strip()
    if voice and voice not in RESERVED_SEAT_VOICES:
        return voice
    if voice:
        logger.warning(
            "tts_read_aloud_default_reserved",
            configured=voice,
            using=READ_ALOUD_FALLBACK_VOICE,
        )
    return READ_ALOUD_FALLBACK_VOICE


# Who the line is spoken TO, when the caller does not want to remember
# the voice. Today's live rule: am_echo to Aaron/room, af_heart to Sam.
RECIPIENT_VOICES = {
    "aaron": "am_echo",
    "room": "am_echo",
    "sam": "af_heart",
}


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TTS_CHARS)
    voice: str | None = None
    agent: str | None = None
    recipient: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    # Read-aloud button: resolve the sender leniently (agent, then
    # sender_name) and fall back to the read-aloud default voice rather than
    # 422 on an unknown sender. See module docstring.
    read_aloud: bool = False
    sender_name: str | None = Field(default=None, max_length=200)


@router.post("/tts")
async def synthesize_speech(
    body: TtsRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    _rl: Annotated[None, Depends(rate_limit("tts", "rate_limit_tts_per_min"))],
) -> Response:
    # Kokoro's phonemizer raises ValueError on text with no speakable
    # content (whitespace-only, or anything that yields zero phonemes),
    # which the upstream returns as a 500 and this proxy surfaces as a 502.
    # Strip emoji/symbol-only noise so pure-reaction messages 422 cleanly
    # instead of becoming a 502 from the GPU host.
    speakable = re.sub(r"\s+", " ", body.text).strip()
    # Keep letters/numbers/common punctuation; drop most emoji/symbol runs
    # that phonemize to nothing. Leave enough ASCII so "ok :)" still works.
    speakable = re.sub(
        r"[\U00010000-\U0010ffff"
        r"\u2600-\u27BF"
        r"\uFE0F"
        r"\u200D]+",
        " ",
        speakable,
    )
    speakable = re.sub(r"\s+", " ", speakable).strip()
    if not speakable or not re.search(r"[A-Za-z0-9]", speakable):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Nothing to read aloud",
        )
    if body.voice:
        voice = body.voice
    elif body.read_aloud:
        voice = (
            resolve_agent_voice(body.agent)
            or resolve_agent_voice(body.sender_name)
            or read_aloud_default_voice(settings)
        )
    elif body.recipient:
        rkey = _normalize_agent(body.recipient)
        if rkey not in RECIPIENT_VOICES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Unknown TTS recipient {body.recipient!r}. "
                    "Known: aaron, room, sam. Or pass voice=."
                ),
            )
        voice = RECIPIENT_VOICES[rkey]
    elif body.agent:
        key = _normalize_agent(body.agent)
        if key not in AGENT_VOICES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Unknown TTS agent {body.agent!r}. "
                    "Pass voice= explicitly or use a known agent id "
                    f"(rook, claude-code, majik, …)."
                ),
            )
        voice = AGENT_VOICES[key]
    else:
        voice = settings.tts_default_voice

    audio, content_type = await _synthesize_resilient(
        settings, speakable, voice, body.speed
    )

    logger.info(
        "tts_synthesized",
        participant_id=user.get("participant_id") or user.get("sub"),
        chars=len(speakable),
        agent=body.agent,
        sender_name=body.sender_name,
        read_aloud=body.read_aloud,
        voice=voice,
    )
    return Response(
        content=audio,
        media_type=content_type,
    )


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


async def _synthesize_resilient(
    settings: Settings, text: str, voice: str, speed: float
) -> tuple[bytes, str]:
    """Retry, then sentence-chunk, a Kokoro 500 on long number-heavy lines."""
    last_error: str | None = None
    async with httpx.AsyncClient(timeout=120.0) as client:
        for attempt in range(3):
            try:
                upstream = await client.post(
                    f"{settings.kokoro_base_url}/v1/audio/speech",
                    json={
                        "model": "kokoro",
                        "input": text,
                        "voice": voice,
                        "response_format": "mp3",
                        "speed": speed,
                    },
                )
            except httpx.HTTPError:
                logger.warning("tts_upstream_unreachable", attempt=attempt, exc_info=True)
                last_error = "unreachable"
                continue
            if upstream.status_code == 200:
                return (
                    upstream.content,
                    upstream.headers.get("content-type", "audio/mpeg"),
                )
            last_error = f"HTTP {upstream.status_code}"
            logger.warning(
                "tts_upstream_error",
                status=upstream.status_code,
                attempt=attempt,
                body=upstream.text[:200],
            )
            if upstream.status_code < 500:
                break
        parts = _SENTENCE_SPLIT.split(text)
        if len(parts) < 2:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"TTS synthesis failed ({last_error})",
            )
        chunks: list[bytes] = []
        content_type = "audio/mpeg"
        midpoint = max(1, len(parts) // 2)
        for piece in (" ".join(parts[:midpoint]), " ".join(parts[midpoint:])):
            if not piece.strip():
                continue
            audio, content_type = await _synthesize_resilient(
                settings, piece.strip(), voice, speed
            )
            chunks.append(audio)
        if not chunks:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"TTS synthesis failed ({last_error})",
            )
        logger.info("tts_chunked_after_failure", pieces=len(chunks), chars=len(text))
        return b"".join(chunks), content_type
