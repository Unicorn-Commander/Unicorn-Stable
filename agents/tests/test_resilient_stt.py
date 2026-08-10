"""NeverFatalSTT — an STT outage must not be able to kill the AgentSession.

Includes the targeted 2026-08-10 repro: a REAL local HTTP server answering
404 (exactly what the deployed whisper base_url did), driven through the REAL
``livekit.plugins.openai.STT``. The bare plugin raises a NON-RECOVERABLE
``APIStatusError`` — the class of error that ``AgentSession._on_error``
counts toward ``max_unrecoverable_errors`` (3) before closing the whole
session with ``CloseReason.ERROR`` (livekit-agents 1.6.9,
voice/agent_session.py). Wrapped, the same call returns an empty final and
emits no error at all.
"""

from __future__ import annotations

import asyncio
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from livekit import rtc
from livekit.agents import stt as lk_stt
from livekit.agents._exceptions import APIConnectionError, APIError, APIStatusError
from livekit.agents.types import APIConnectOptions

from agent_runtime.resilient_stt import NeverFatalSTT

# One retry at most and no backoff, so failure-path tests stay fast.
FAST = APIConnectOptions(max_retry=0, timeout=5.0)


def audio_frame(ms: int = 100) -> rtc.AudioFrame:
    samples = 16000 * ms // 1000
    return rtc.AudioFrame(
        data=b"\x00\x00" * samples,
        sample_rate=16000,
        num_channels=1,
        samples_per_channel=samples,
    )


class FakeSTT(lk_stt.STT):
    """Scriptable inner: raise N times, then succeed."""

    def __init__(self, fail_times: int = 0) -> None:
        super().__init__(
            capabilities=lk_stt.STTCapabilities(streaming=False, interim_results=False)
        )
        self.fail_times = fail_times
        self.calls = 0

    async def _recognize_impl(self, buffer, *, language, conn_options):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise APIStatusError("boom", status_code=404)
        return lk_stt.SpeechEvent(
            type=lk_stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[lk_stt.SpeechData(language="en", text="hello there")],
        )


def test_success_passes_through() -> None:
    async def run() -> None:
        wrapped = NeverFatalSTT(FakeSTT(fail_times=0))
        event = await wrapped.recognize(audio_frame(), conn_options=FAST)
        assert event.alternatives[0].text == "hello there"

    asyncio.run(run())


def test_inner_failure_degrades_to_empty_final_not_an_exception() -> None:
    async def run() -> None:
        wrapped = NeverFatalSTT(FakeSTT(fail_times=99))
        errors: list = []
        wrapped.on("error", errors.append)
        event = await wrapped.recognize(audio_frame(), conn_options=FAST)
        # Empty final: the session hears silence instead of dying.
        assert event.type == lk_stt.SpeechEventType.FINAL_TRANSCRIPT
        assert event.alternatives[0].text == ""
        # And crucially: no stt error event ever reaches session._on_error.
        assert errors == []

    asyncio.run(run())


def test_recovery_resets_and_returns_real_text() -> None:
    async def run() -> None:
        inner = FakeSTT(fail_times=1)
        wrapped = NeverFatalSTT(inner)
        first = await wrapped.recognize(audio_frame(), conn_options=FAST)
        assert first.alternatives[0].text == ""  # degraded, silently
        second = await wrapped.recognize(audio_frame(), conn_options=FAST)
        assert second.alternatives[0].text == "hello there"  # endpoint back
        assert wrapped._consecutive_failures == 0  # noqa: SLF001

    asyncio.run(run())


# ---------------------------------------------------------------------------
# The incident repro: a real 404 endpoint through the real openai plugin
# ---------------------------------------------------------------------------


class _Always404(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = b'{"detail": "Not Found"}'
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST

    def log_message(self, *args):  # silence
        return


def _serve_404() -> tuple[HTTPServer, str]:
    server = HTTPServer(("127.0.0.1", 0), _Always404)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}/v1"


def test_2026_08_10_repro_bare_openai_stt_raises_unrecoverable() -> None:
    """The deployed failure, minimally: whisper URL answers 404 → the plugin
    raises an APIError chain whose terminal emit is recoverable=False — the
    exact input AgentSession._on_error counts toward closing the session."""
    from livekit.plugins import openai as lk_openai

    server, base_url = _serve_404()
    try:

        async def run() -> None:
            plugin = lk_openai.STT(base_url=base_url, api_key="not-needed")
            emitted: list = []
            plugin.on("error", emitted.append)
            try:
                await plugin.recognize(audio_frame(), conn_options=FAST)
                raise AssertionError("expected the 404 to raise")
            except (APIStatusError, APIConnectionError) as exc:
                # 4xx (≠408/429/499) ⇒ retryable=False per
                # livekit.agents._exceptions.APIStatusError.__init__.
                if isinstance(exc, APIStatusError):
                    assert exc.status_code == 404
                    assert exc.retryable is False
            assert len(emitted) == 1
            assert emitted[0].recoverable is False  # the session-killer

        asyncio.run(run())
    finally:
        server.shutdown()


def test_2026_08_10_repro_wrapped_stt_survives_the_same_endpoint() -> None:
    """Same dead endpoint, wrapped: empty final, zero error events, session
    unrecoverable-error counter never moves."""
    from livekit.plugins import openai as lk_openai

    server, base_url = _serve_404()
    try:

        async def run() -> None:
            wrapped = NeverFatalSTT(
                lk_openai.STT(base_url=base_url, api_key="not-needed")
            )
            emitted: list = []
            wrapped.on("error", emitted.append)
            for _ in range(5):  # well past max_unrecoverable_errors (3)
                event = await wrapped.recognize(audio_frame(), conn_options=FAST)
                assert event.alternatives[0].text == ""
            assert emitted == []

        asyncio.run(run())
    finally:
        server.shutdown()


def test_wrapper_is_transparent_about_identity() -> None:
    inner = FakeSTT()
    wrapped = NeverFatalSTT(inner)
    assert wrapped.capabilities.streaming is False
    assert "NeverFatal" in wrapped.label


_ = APIError  # referenced for readers; the class union above is the contract
