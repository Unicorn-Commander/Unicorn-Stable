"""Error + performance observability (Sentry / GlitchTip).

GlitchTip is Sentry-API-compatible, so the same ``sentry_sdk`` talks to either.
Entirely env-gated: with no DSN set, ``init_observability`` is a no-op and the
app runs exactly as before. Point ``SENTRY_DSN`` (or ``GLITCHTIP_DSN``) at the
GlitchTip project and every unhandled 5xx / exception is captured and alertable
instead of dying silently in container logs (which is how the TTS 500s hid).

The release is stamped from ``STABLE_GIT_SHA`` (baked by the Dockerfile), so
errors are attributable to an exact build.
"""

from __future__ import annotations

import os

import structlog

logger = structlog.get_logger("observability")


def init_observability(settings) -> bool:
    """Initialise Sentry/GlitchTip if a DSN is configured. Returns True if active.

    Fail-safe: any import or init error is logged and swallowed — observability
    must never take down the app it is meant to watch.
    """
    dsn = (getattr(settings, "sentry_dsn", "") or os.getenv("GLITCHTIP_DSN", "")).strip()
    if not dsn:
        logger.info("observability_disabled", reason="no SENTRY_DSN/GLITCHTIP_DSN set")
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except Exception as exc:  # noqa: BLE001
        logger.warning("observability_sdk_missing", err=str(exc))
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=getattr(settings, "environment", "production"),
            release=os.getenv("STABLE_GIT_SHA") or None,
            # Errors are the priority; tracing is opt-in and cheap by default.
            traces_sample_rate=float(getattr(settings, "sentry_traces_sample_rate", 0.0) or 0.0),
            send_default_pii=False,
            integrations=[StarletteIntegration(), FastApiIntegration()],
        )
        logger.info(
            "observability_enabled",
            environment=getattr(settings, "environment", "production"),
            release=os.getenv("STABLE_GIT_SHA") or "unknown",
        )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("observability_init_failed", err=str(exc))
        return False
