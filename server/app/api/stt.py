"""Speech-to-text proxy (Amanuensis / Parakeet / OpenAI-compatible Whisper).

The browser and off-LAN MCP clients cannot reach the LAN-only STT host, so this
endpoint proxies ``POST /api/v1/stt`` to the OpenAI-compatible transcription
front (``settings.whisper_base_url`` + ``/audio/transcriptions``) and returns
the upstream JSON to the authenticated caller.

Upstream is expected to speak the OpenAI multipart contract::

    POST {whisper_base_url}/audio/transcriptions
    form: file=<audio>, model=whisper-1, language?=en
    response: { "text": "...", "language"?: "...", "segments"?: [...] }

Defaults track the agent-side STT plug-in (an OpenAI-compatible configured
service). Env override: ``WHISPER_BASE_URL``.
"""

from __future__ import annotations

from typing import Annotated, Any

import httpx
import structlog
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.config import Settings
from app.deps import get_current_user, get_settings_dep, rate_limit

logger = structlog.get_logger(__name__)

router = APIRouter()

# Hard cap so a single request cannot soak GPU + RAM. ~25 MB is generous for a
# few minutes of speech at typical webm/opus bitrates.
MAX_AUDIO_BYTES = 25 * 1024 * 1024

ALLOWED_CONTENT_PREFIXES = (
    "audio/",
    "video/webm",
    "video/mp4",
    "application/octet-stream",
)


@router.post("/stt")
async def transcribe_audio(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    _rl: Annotated[None, Depends(rate_limit("stt", "rate_limit_stt_per_min"))],
    file: UploadFile = File(..., description="Audio file to transcribe"),
    language: str | None = Form(default=None),
    model: str | None = Form(default=None),
) -> dict[str, Any]:
    """Proxy multipart audio to the suite STT (Amanuensis/Parakeet) front."""
    content_type = (file.content_type or "application/octet-stream").split(";")[0].strip()
    if not any(
        content_type == p or content_type.startswith(p.rstrip("/"))
        for p in ALLOWED_CONTENT_PREFIXES
    ):
        # Soft check — some clients send empty/unknown types; still accept if
        # the filename looks like audio. Reject only clearly wrong types.
        name = (file.filename or "").lower()
        if not any(
            name.endswith(ext)
            for ext in (
                ".wav",
                ".mp3",
                ".m4a",
                ".ogg",
                ".webm",
                ".flac",
                ".mp4",
                ".mpeg",
                ".mpga",
            )
        ):
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail=f"Unsupported audio content-type: {content_type}",
            )

    audio = await file.read()
    if not audio:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Empty audio payload",
        )
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Audio exceeds {MAX_AUDIO_BYTES} byte limit",
        )

    base = (settings.whisper_base_url or "").rstrip("/")
    if not base:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STT service not configured",
        )
    url = f"{base}/audio/transcriptions"
    use_model = (model or settings.whisper_model or "whisper-1").strip()
    filename = file.filename or "audio.webm"

    form_data: dict[str, Any] = {"model": use_model}
    if language:
        form_data["language"] = language.strip()

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            upstream = await client.post(
                url,
                data=form_data,
                files={"file": (filename, audio, content_type or "application/octet-stream")},
            )
    except httpx.HTTPError:
        logger.warning("stt_upstream_unreachable", url=url, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="STT service unreachable",
        ) from None

    if upstream.status_code != 200:
        logger.warning(
            "stt_upstream_error",
            status=upstream.status_code,
            body=upstream.text[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="STT transcription failed",
        )

    try:
        body = upstream.json()
    except ValueError:
        body = {"text": upstream.text}

    text = body.get("text") if isinstance(body, dict) else None
    logger.info(
        "stt_transcribed",
        participant_id=user.get("participant_id") or user.get("sub"),
        bytes=len(audio),
        chars=len(text or ""),
        model=use_model,
        language=language,
    )
    if isinstance(body, dict):
        return body
    return {"text": str(body)}
