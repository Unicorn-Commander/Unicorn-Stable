"""NeverFatalSTT — an STT wrapper whose failures cannot kill the AgentSession.

Why this exists (incident, 2026-08-10 16:38Z, room stable-chat-with-majik-*):
the configured whisper endpoint answered 404. The failure chain in
livekit-agents 1.6.9 is:

    openai.STT._recognize_impl              → APIStatusError(status_code=404)
    _exceptions.APIStatusError.__init__     → 4xx (≠408/429/499) ⇒ retryable=False
    stt.STT.recognize retry loop            → retries anyway, then
                                              _emit_error(e, recoverable=False)
    AgentSession._on_error                  → unrecoverable stt_error;
                                              after max_unrecoverable_errors (3)
                                              CONSECUTIVE ones:
                                              "AgentSession is closing due to
                                              unrecoverable error"
                                              → aclose(reason=CloseReason.ERROR)

One person talking produces a VAD segment every few seconds, so a dead STT
endpoint closes the whole session — voice reply pipeline, TTS, everything —
within ~20 seconds of the first utterance. Every later
``generate_reply`` then raises ``RuntimeError("AgentSession isn't running")``.

That is exactly backwards for Stable: the browser-transcript fallback
(voice_transcripts.py) exists so the agent can HEAR without its own STT. An
STT outage must therefore degrade to "the session has no ears" — empty
transcripts, zero emitted errors — never to "the session is gone".

The wrapper intercepts at ``_recognize_impl`` and converts ANY failure of the
inner plugin's full ``recognize`` (its own retries included) into an empty
FINAL_TRANSCRIPT event. The outer retry loop sees success, no ``stt_error``
is ever emitted, the session's unrecoverable-error counter never moves. The
failure is still LOUD in the logs (with a real traceback, now that
format_exc_info renders them).

Only meaningful for NON-STREAMING plugins (whisper/openai — the deployed
default), which is the only path the brigade agent wraps; a streaming STT
uses ``stream()``, which this wrapper does not intercept.
"""

from __future__ import annotations

from typing import Any

import structlog
from livekit.agents import stt as lk_stt
from livekit.agents.types import NOT_GIVEN, APIConnectOptions, NotGivenOr

logger = structlog.get_logger(__name__)


class NeverFatalSTT(lk_stt.STT):
    """Delegates to an inner non-streaming STT; failures become empty finals."""

    def __init__(self, inner: lk_stt.STT) -> None:
        super().__init__(capabilities=inner.capabilities)
        self._inner = inner
        # Consecutive-failure counter, for observability only (the session
        # never sees these as errors). Reset on any successful recognize.
        self._consecutive_failures = 0

    # -- identification passthroughs (metrics/labels stay truthful) -------- #

    @property
    def label(self) -> str:
        return f"NeverFatal({getattr(self._inner, 'label', type(self._inner).__name__)})"

    @property
    def model(self) -> str:
        try:
            return self._inner.model
        except Exception:
            return "unknown"

    @property
    def provider(self) -> str:
        try:
            return self._inner.provider
        except Exception:
            return "unknown"

    # -- the seam ---------------------------------------------------------- #

    async def _recognize_impl(
        self,
        buffer: Any,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions,
    ) -> lk_stt.SpeechEvent:
        try:
            event = await self._inner.recognize(
                buffer, language=language, conn_options=conn_options
            )
            self._consecutive_failures = 0
            return event
        except Exception:
            self._consecutive_failures += 1
            # LOUD and with the real traceback — this is the "agent has no
            # ears" signal that must reach an operator. The browser-transcript
            # fallback keeps the agent conversational meanwhile.
            logger.error(
                "stt_recognize_failed_degrading_to_silence",
                consecutive_failures=self._consecutive_failures,
                inner=type(self._inner).__name__,
                exc_info=True,
            )
            lang = language if isinstance(language, str) and language else ""
            return lk_stt.SpeechEvent(
                type=lk_stt.SpeechEventType.FINAL_TRANSCRIPT,
                alternatives=[lk_stt.SpeechData(language=lang, text="")],
            )

    async def aclose(self) -> None:
        try:
            await self._inner.aclose()
        finally:
            await super().aclose()
