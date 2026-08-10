"""The JSON log chain must render tracebacks — the incident's blindfold.

2026-08-10: every ``logger.error(..., exc_info=True)`` in prod serialized as
``"exc_info": true`` with no traceback, because the JSON processor chain had
no exc_info formatter. The exception class behind a total voice outage
(RuntimeError: AgentSession isn't running) was invisible for a full incident
cycle. These tests pin the fix at the exact seam: the processor list that
production configures.
"""

from __future__ import annotations

import io
import json

import structlog

from main import build_processors


class _NamedPrintLogger(structlog.PrintLogger):
    """PrintLogger with the `.name` the stdlib add_logger_name processor
    reads — stand-in for the prod stdlib LoggerFactory, minus the handler
    plumbing, so the test exercises the EXACT prod processor chain."""

    name = "capture"


def _capture_configured(is_debug: bool) -> io.StringIO:
    out = io.StringIO()
    structlog.configure(
        processors=build_processors(is_debug),
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=lambda *args: _NamedPrintLogger(file=out),
        cache_logger_on_first_use=False,
    )
    return out


def teardown_function() -> None:
    structlog.reset_defaults()


def test_json_chain_renders_the_traceback() -> None:
    out = _capture_configured(is_debug=False)
    log = structlog.get_logger("incident")
    try:
        raise RuntimeError("AgentSession isn't running")
    except RuntimeError:
        log.error("voice_transcript_reply_failed", exc_info=True)

    line = out.getvalue().strip()
    payload = json.loads(line)  # still valid one-line JSON
    assert payload["event"] == "voice_transcript_reply_failed"
    # THE fix: the traceback text is IN the log line.
    exception_text = payload.get("exception", "")
    assert "Traceback (most recent call last)" in exception_text
    assert "RuntimeError: AgentSession isn't running" in exception_text
    # And the raw boolean marker no longer leaks through unformatted.
    assert payload.get("exc_info") is not True


def test_json_chain_renders_explicit_exception_objects() -> None:
    """`exc_info=error` (the SDK's own close log style) renders too."""
    out = _capture_configured(is_debug=False)
    log = structlog.get_logger("incident")
    try:
        raise ValueError("whisper endpoint answered 404")
    except ValueError as exc:
        log.error("voice_session_closed", exc_info=exc)

    payload = json.loads(out.getvalue().strip())
    assert "ValueError: whisper endpoint answered 404" in payload.get(
        "exception", ""
    )


def test_plain_logs_are_unaffected() -> None:
    out = _capture_configured(is_debug=False)
    structlog.get_logger("x").info("agent_started", room="r1")
    payload = json.loads(out.getvalue().strip())
    assert payload["event"] == "agent_started"
    assert payload["room"] == "r1"
    assert "exception" not in payload
