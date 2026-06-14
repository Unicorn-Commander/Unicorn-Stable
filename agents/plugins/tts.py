"""TTS plugin configuration.

Default provider is ``kokoro`` — served by the self-hosted **Unicorn Orator**
voice service on the live uc-1 box over Tailscale
(``http://100.78.236.160:8880`` by default; override with ``KOKORO_BASE_URL``).

IMPORTANT — Orator is NOT OpenAI-body-compatible. Its ``POST /v1/audio/speech``
takes a native ``{text, voice, speed, stream}`` body (field ``text``, *not* the
OpenAI ``input``) and returns ``audio/wav``. Verified live: an OpenAI-shape body
``{model,input,voice}`` is rejected with HTTP 422 ("Field required: text"),
while ``{text,voice}`` returns 200 + WAV. The stock ``livekit.plugins.openai.TTS``
sends ``input=`` via the OpenAI SDK, so it CANNOT drive Orator. We therefore ship
a small native ``OratorTTS`` plugin (a ``livekit.agents.tts.TTS`` subclass) that
speaks Orator's real contract.

Orator advertises both pocket-tts custom voices (alba, javert, ...) and the
kokoro voice set (am_michael, af_bella, bm_lewis, ...). The per-agent presets
below map to kokoro voices, which Orator serves via its kokoro-onnx fallback.

The other providers (elevenlabs, cartesia, openai) stay OpenAI/native-SDK based
and are unchanged.
"""

from __future__ import annotations

import os
from typing import Any

import structlog
from livekit.agents import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    tts,
    utils,
)
from livekit.agents.types import (
    DEFAULT_API_CONNECT_OPTIONS,
    APIConnectOptions,
)

from agent_runtime.config import AgentSettings, get_agent_settings

logger = structlog.get_logger(__name__)


# Deployed default = live Unicorn Orator on uc-1 (Tailscale), reachable from the
# stable-agents container via the host tailnet.
DEFAULT_KOKORO_BASE_URL = os.getenv("KOKORO_BASE_URL", "http://100.78.236.160:8880")
DEFAULT_KOKORO_MODEL = os.getenv("KOKORO_MODEL", "kokoro")

# Orator returns 24kHz mono WAV (per its /health: "sample_rate": 24000).
_ORATOR_SAMPLE_RATE = int(os.getenv("KOKORO_SAMPLE_RATE", "24000"))
_ORATOR_NUM_CHANNELS = 1

# Per-agent Kokoro voice presets. Kokoro voice format: <accent><gender>_<name>.
# af = American female, am = American male, bf = British female, bm = British male.
# All of these are served by Orator (verified in its /voices list).
KOKORO_VOICE_PRESETS: dict[str, str] = {
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
    "default": "af_bella",
}

# bm_daniel appears in presets but is not in Orator's built-in list; fall back
# to a guaranteed-present British male voice.
_ORATOR_VOICE_FALLBACKS: dict[str, str] = {
    "bm_daniel": "bm_lewis",
}


def _resolve_kokoro_voice(personality: str, explicit: str | None) -> str:
    voice = explicit or KOKORO_VOICE_PRESETS.get(
        personality, KOKORO_VOICE_PRESETS["default"]
    )
    return _ORATOR_VOICE_FALLBACKS.get(voice, voice)


class OratorTTS(tts.TTS):
    """Native Unicorn Orator TTS plugin (livekit-agents 1.5).

    Speaks Orator's real ``POST /v1/audio/speech`` contract
    (``{text, voice, speed}`` -> ``audio/wav``). NOT OpenAI-body-compatible,
    which is exactly why this exists instead of ``openai.TTS``.
    """

    def __init__(
        self,
        *,
        base_url: str,
        voice: str,
        speed: float = 1.0,
        sample_rate: int = _ORATOR_SAMPLE_RATE,
        http_session: Any = None,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=sample_rate,
            num_channels=_ORATOR_NUM_CHANNELS,
        )
        self._base_url = base_url.rstrip("/")
        self._voice = voice
        self._speed = speed
        # Optional explicit aiohttp session. Inside the agent worker the
        # managed job-context session is used (utils.http_context.http_session);
        # standalone callers (tests, scripts) pass their own.
        self._session = http_session

    def _ensure_session(self) -> Any:
        if self._session is not None:
            return self._session
        return utils.http_context.http_session()

    @property
    def voice(self) -> str:
        return self._voice

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> "OratorChunkedStream":
        return OratorChunkedStream(
            tts=self,
            input_text=text,
            conn_options=conn_options,
        )


class OratorChunkedStream(tts.ChunkedStream):
    """One-shot synthesis against Orator's /v1/audio/speech."""

    def __init__(
        self,
        *,
        tts: OratorTTS,
        input_text: str,
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._tts: OratorTTS = tts

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        url = f"{self._tts._base_url}/v1/audio/speech"
        payload = {
            "text": self.input_text,
            "voice": self._tts._voice,
            "speed": self._tts._speed,
            "stream": False,
        }
        session = self._tts._ensure_session()
        request_id = utils.shortuuid()
        try:
            async with session.post(
                url,
                json=payload,
                headers={"Accept": "audio/wav"},
                timeout=self._make_timeout(),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    raise APIStatusError(
                        f"Orator TTS returned {resp.status}: {body[:300]}",
                        status_code=resp.status,
                        request_id=request_id,
                        body=body,
                    )
                # Orator returns a complete WAV container; the AudioEmitter
                # parses the WAV header from the mime_type and emits PCM frames.
                output_emitter.initialize(
                    request_id=request_id,
                    sample_rate=self._tts.sample_rate,
                    num_channels=self._tts.num_channels,
                    mime_type="audio/wav",
                )
                async for chunk in resp.content.iter_chunked(8192):
                    output_emitter.push(chunk)
                output_emitter.flush()
        except APIStatusError:
            raise
        except TimeoutError:
            raise APITimeoutError() from None
        except Exception as e:
            raise APIConnectionError() from e

    def _make_timeout(self) -> Any:
        import aiohttp

        return aiohttp.ClientTimeout(
            total=60,
            connect=self._conn_options.timeout,
        )


def get_tts_plugin(
    provider: str = "kokoro",
    *,
    settings: AgentSettings | None = None,
    personality: str = "default",
    voice_id: str | None = None,
    model: str | None = None,
) -> Any:
    cfg = settings or get_agent_settings()
    provider = provider.lower()

    if provider == "kokoro":
        voice = _resolve_kokoro_voice(personality, voice_id)
        base_url = _cfg_get(cfg, "kokoro_base_url") or DEFAULT_KOKORO_BASE_URL
        tts_plugin = OratorTTS(base_url=base_url, voice=voice)
        logger.info(
            "tts_configured",
            provider="kokoro-orator",
            base_url=base_url,
            voice=voice,
            personality=personality,
        )
        return tts_plugin

    if provider == "elevenlabs":
        from livekit.plugins import elevenlabs
        if not cfg.elevenlabs_api_key:
            raise ValueError("ELEVENLABS_API_KEY is required for ElevenLabs TTS")
        plugin = elevenlabs.TTS(
            api_key=cfg.elevenlabs_api_key,
            voice_id=voice_id or "pNInz6obpgDQGcFmaJgB",
        )
        logger.info("tts_configured", provider="elevenlabs", voice_id=voice_id)
        return plugin

    if provider == "cartesia":
        from livekit.plugins import cartesia
        if not cfg.cartesia_api_key:
            raise ValueError("CARTESIA_API_KEY is required for Cartesia TTS")
        plugin = cartesia.TTS(
            api_key=cfg.cartesia_api_key,
            voice=voice_id or "a0e99841-438c-4a64-b679-ae501e7d6091",
        )
        logger.info("tts_configured", provider="cartesia", voice=voice_id)
        return plugin

    if provider == "openai":
        from livekit.plugins import openai as lk_openai
        if not cfg.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required for openai TTS")
        plugin = lk_openai.TTS(
            api_key=cfg.openai_api_key,
            model=model or "gpt-4o-mini-tts",
            voice=voice_id or "ash",
        )
        logger.info("tts_configured", provider="openai", voice=voice_id)
        return plugin

    raise ValueError(f"Unsupported TTS provider: {provider}")


def _cfg_get(cfg: AgentSettings, name: str) -> str | None:
    """Read an optional setting that may not exist on older config objects."""
    return getattr(cfg, name, None) or None
