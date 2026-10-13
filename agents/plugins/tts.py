"""TTS plugin configuration.

Default provider is ``kokoro`` — an optional OpenAI-compatible service configured
with ``KOKORO_BASE_URL``.

This is the stock ``kokoro-fastapi`` server, which IS OpenAI-body-compatible:
``POST /v1/audio/speech`` takes ``{model, input, voice, response_format, speed}``
(field ``input`` like the OpenAI SDK, *not* ``text``) and returns audio in the
requested ``response_format``. We request ``wav`` so the ``AudioEmitter`` can parse
the WAV container directly; output is 24 kHz mono. ``af_heart`` (Majik) and the
rest of the preset voices below are all served.

NOTE — this plugin speaks the OpenAI
``{model, input, voice}`` contract (kept over ``openai.TTS`` for its WAV chunk
emit + per-agent voice presets).

The other providers (elevenlabs, cartesia, openai) stay OpenAI/native-SDK based
and are unchanged.
"""

from __future__ import annotations

import asyncio
import os
import re
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


# Empty keeps the optional local provider off until an endpoint is supplied.
DEFAULT_KOKORO_BASE_URL = os.getenv("KOKORO_BASE_URL", "").strip()
DEFAULT_KOKORO_MODEL = os.getenv("KOKORO_MODEL", "kokoro")

# --- Usage metering (best-effort) -------------------------------------------
# Report TTS character counts to the ops-center metering bridge so voice usage
# lands on the same Lago rail (metric ``tts_characters``) as the rest of the
# platform. Fire-and-forget: a failed/unset report NEVER affects audio. No-op
# unless METERING_REPORT_URL and METERING_KEY are set. The bridge skips exempt
# orgs ("collect-don't-gate"), so an internal org is collected but not charged.
_METERING_URL = os.getenv("METERING_REPORT_URL", "")
_METERING_KEY = os.getenv("METERING_KEY", "")
_METERING_ORG = os.getenv("STABLE_METERING_ORG_ID", "stable-internal")

# Orator returns 24kHz mono WAV (per its /health: "sample_rate": 24000).
_ORATOR_SAMPLE_RATE = int(os.getenv("KOKORO_SAMPLE_RATE", "24000"))
_ORATOR_NUM_CHANNELS = 1

# Per-agent Kokoro voice presets. Kokoro voice format: <accent><gender>_<name>.
# af = American female, am = American male, bf = British female, bm = British male.
# All of these are served by Orator (verified in its /voices list).
KOKORO_VOICE_PRESETS: dict[str, str] = {
    # Majik — the flagship "Chat with Majik" agent — American male, per Aaron
    # 2026-08-10 ("he needs a male voice"). am_puck verified in Orator
    # /v1/voices and deliberately assigned to NO other agent, so Majik stays
    # acoustically distinct in multi-agent calls.
    "majik": "am_puck",
    # Rook — Aaron's own seat (participant agent-claude-code), so the preset is
    # keyed on the brigade id "claude-code"; "rook" is the same voice under the
    # show name. am_echo picked by Aaron from the 2026-08-28 audition, and it
    # is free of the two voices resident in the Build In Public room (majik
    # am_puck, the-general am_michael) — an agent that sounds like another
    # agent on camera is indistinguishable to a viewer. sgt-swift gave am_echo
    # up for this.
    "claude-code": "am_echo",
    "rook": "am_echo",
    # Persephone — Aaron's main assistant seat (participant agent-persephone),
    # 2026-09-03. af_heart is HERS: Corporal Forge moved to af_bella the same
    # day so the one voice Aaron talks to all day is worn by nobody else.
    "persephone": "af_heart",
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
    # Moved off am_echo (now Rook's) 2026-08-28. bm_lewis rather than one of
    # the American voices because its other holders are legal/finance agents
    # that will not share a room with a Swift dev agent, whereas am_adam and
    # am_michael are already worn by its actual peers (cpt-fullstack,
    # sgt-cipher, code-reviewer, maj-devops).
    "sgt-swift": "bm_lewis",
    "sgt-cocoa": "am_onyx",
    "corporal-qwen": "bm_george",
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

#: What the deployed Kokoro actually serves — MEASURED against
#: ``GET /v1/voices`` on 2026-09-01, not copied from the model card. A room
#: setting that names a voice outside this list would synthesise nothing and
#: fail silently mid-show, so the relay checks against it before trusting a
#: per-sender voice (see ``known_kokoro_voice``).
KOKORO_SERVED_VOICES: frozenset[str] = frozenset(
    {
        "af", "af_alloy", "af_bella", "af_heart", "af_nicole", "af_nova",
        "af_river", "af_sarah", "af_sky",
        "am_adam", "am_echo", "am_michael", "am_onyx", "am_puck",
        "bf_emma", "bf_isabella",
        "bm_george", "bm_lewis",
    }
)


def _resolve_kokoro_voice(personality: str, explicit: str | None) -> str:
    voice = explicit or KOKORO_VOICE_PRESETS.get(
        personality, KOKORO_VOICE_PRESETS["default"]
    )
    return _ORATOR_VOICE_FALLBACKS.get(voice, voice)


def known_kokoro_voice(voice: Any) -> str | None:
    """The served voice id for ``voice``, or None when Kokoro does not have it.

    Applies the same alias fallbacks the presets rely on (``bm_daniel`` ->
    ``bm_lewis``) so a caller can hand in anything a preset would, and gets
    back the id that will actually produce audio.
    """
    if not isinstance(voice, str):
        return None
    candidate = voice.strip().lower()
    if not candidate:
        return None
    candidate = _ORATOR_VOICE_FALLBACKS.get(candidate, candidate)
    return candidate if candidate in KOKORO_SERVED_VOICES else None


# Strip model "thinking" out of text before it is spoken. Some local models
# (Qwen3.x, etc.) can emit <think>...</think> reasoning inline in the content;
# without this the TTS reads the tags/reasoning aloud (e.g. "less than slash
# think..."). The 3090 router is configured no-think, but this is defense-in-depth
# for any model routed through the per-room switcher. 2026-06-23.
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_THINK_TAG_RE = re.compile(r"</?think\s*>", re.IGNORECASE)


def _strip_think(text: str) -> str:
    if not text:
        return text
    cleaned = _THINK_BLOCK_RE.sub("", text)   # drop paired <think>..</think> blocks
    cleaned = _THINK_TAG_RE.sub("", cleaned)  # drop any stray/unpaired tags
    cleaned = cleaned.strip()
    # If that removed everything (response was only a think block), at least return
    # the original with literal tags stripped so we never speak "<think>".
    return cleaned if cleaned else _THINK_TAG_RE.sub("", text).strip()


class OratorTTS(tts.TTS):
    """Native Kokoro-FastAPI TTS plugin (livekit-agents 1.5).

    Speaks the OpenAI-compatible ``POST /v1/audio/speech`` contract of the
    configured GPU Kokoro service (``{model, input, voice, response_format}`` -> WAV).
    """

    def __init__(
        self,
        *,
        base_url: str,
        voice: str,
        model: str = DEFAULT_KOKORO_MODEL,
        personality: str = "default",
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
        self._model = model
        self._personality = personality
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
            input_text=_strip_think(text),
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
        # OpenAI-compatible kokoro-fastapi body (field is ``input``, not ``text``).
        # response_format=wav so the AudioEmitter parses the WAV container below.
        payload = {
            "model": self._tts._model,
            "input": self.input_text,
            "voice": self._tts._voice,
            "response_format": "wav",
            "speed": self._tts._speed,
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
                # Best-effort usage metering (fire-and-forget; never blocks audio).
                asyncio.create_task(
                    _report_tts_usage(
                        len(self.input_text or ""),
                        self._tts._voice,
                        self._tts._personality,
                    )
                )
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


async def _report_tts_usage(char_count: int, voice: str, personality: str) -> None:
    """Fire-and-forget char-count report to the ops-center metering bridge.

    Never raises into the TTS path. No-op when metering is unconfigured.
    """
    if not _METERING_URL or not _METERING_KEY or char_count <= 0:
        return
    try:
        import aiohttp

        session = utils.http_context.http_session()
        async with session.post(
            _METERING_URL,
            json={
                "service_type": "tts",
                "quantity": char_count,
                "org_id": _METERING_ORG,
                "model": "kokoro",
                "metadata": {
                    "voice": voice,
                    "personality": personality,
                    "engine": "kokoro-fastapi",
                },
            },
            headers={"X-Metering-Key": _METERING_KEY},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            if resp.status >= 300:
                logger.debug("tts_metering_non_2xx", status=resp.status)
    except Exception as e:
        logger.debug("tts_metering_report_failed", error=str(e))


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
        if not base_url:
            raise ValueError("KOKORO_BASE_URL is required for kokoro TTS")
        tts_plugin = OratorTTS(
            base_url=base_url, voice=voice, model=DEFAULT_KOKORO_MODEL, personality=personality
        )
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
