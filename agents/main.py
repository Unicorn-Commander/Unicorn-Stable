"""Stable Agent Worker — entry point for the LiveKit agent runtime."""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any

import structlog
from livekit.agents import AutoSubscribe, JobContext, JobRequest, WorkerOptions, cli

from agent_runtime.config import AgentSettings, get_agent_settings
from agent_runtime.registry import AgentRegistry
from brigade_backed.agent import BrigadeBackedAgent
from triage.agent import TriageAgent

# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------

def build_processors(is_debug: bool) -> list[Any]:
    """The structlog processor chain, extracted so tests can prove tracebacks
    actually render.

    THE SWALLOW THIS FIXES (found live, 2026-08-10): the JSON chain had no
    exc_info formatter, so every ``logger.error(..., exc_info=True)`` — every
    ``voice_transcript_reply_failed``, every ``voice_ctx_seed_skipped`` —
    serialized as ``"exc_info": true`` with NO traceback text. The one signal
    that would have named the failing exception in prod was structurally
    discarded. ``format_exc_info`` renders the traceback into an
    ``exception`` key on the JSON line; the dev ConsoleRenderer formats
    exc_info itself and must NOT be combined with it.
    """
    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.UnicodeDecoder(),
    ]
    if is_debug:
        return [*shared, structlog.dev.ConsoleRenderer()]
    return [
        *shared,
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ]


def _configure_logging(log_level: str) -> None:
    """Set up structlog with human-readable console output in dev,
    JSON in production (when LOG_LEVEL is not DEBUG)."""

    is_debug = log_level == "DEBUG"

    structlog.configure(
        processors=build_processors(is_debug),
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    numeric_level = getattr(logging, log_level, logging.INFO)
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=numeric_level,
    )


# ---------------------------------------------------------------------------
# Worker callbacks
# ---------------------------------------------------------------------------

_registry: AgentRegistry | None = None


def _get_registry() -> AgentRegistry:
    global _registry
    if _registry is None:
        # livekit-agents spawns each job in a fresh subprocess that doesn't
        # inherit module globals from the parent worker. Lazy-init here so
        # every subprocess can build its own registry on first access.
        settings = get_agent_settings()
        _configure_logging(settings.log_level)
        _registry = AgentRegistry(settings=settings)
        _registry.register(TriageAgent)
        _registry.register(BrigadeBackedAgent)
    return _registry


async def _entrypoint(ctx: JobContext) -> None:
    """Called for each dispatched job. Connects to the room and starts the agent."""
    logger = structlog.get_logger("entrypoint")

    logger.info(
        "job_dispatched",
        room=ctx.room.name,
        job_id=ctx.job.id if hasattr(ctx.job, "id") else "unknown",
    )

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    registry = _get_registry()
    await registry.on_job_dispatched(ctx)


async def _request_handler(req: JobRequest) -> None:
    """Called when a new job request arrives. Decides whether to accept."""
    logger = structlog.get_logger("request_handler")
    room_name = req.room.name if req.room else "unknown"
    logger.info("job_request", room=room_name)

    registry = _get_registry()
    await registry.on_job_request(req)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    settings: AgentSettings = get_agent_settings()
    _configure_logging(settings.log_level)

    logger = structlog.get_logger("main")
    logger.info(
        "stable_agent_worker_starting",
        livekit_url=settings.livekit_url,
        backend_url=settings.stable_backend_url,
        log_level=settings.log_level,
    )

    # Build the registry and register all agent types
    global _registry
    _registry = AgentRegistry(settings=settings)
    _registry.register(TriageAgent)
    _registry.register(BrigadeBackedAgent)

    logger.info(
        "agents_registered",
        types=_registry.registered_types,
    )

    # Start the LiveKit agent worker via the SDK CLI harness.
    # cli.run_app handles the event loop, signal handling, and worker lifecycle.
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=_entrypoint,
            request_fnc=_request_handler,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
            ws_url=settings.livekit_url,
            num_idle_processes=settings.worker_num_idle,
            agent_name="stable-brigade",  # matches backend's dispatch_agent() default
        ),
    )


if __name__ == "__main__":
    main()
