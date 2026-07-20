"""Help agent endpoints (mounted at ``/api/v1/help``).

Two routes, both authenticated:

``GET  /api/v1/help/agent``      is it configured, is the gateway answering, what does it cost
``POST /api/v1/help/agent/ask``  answer one question about Stable

There is deliberately no endpoint that serves help *content*. The corpus lives
in the web bundle (``web/src/content/help/*.md``) as a single copy and the
client sends the relevant articles with the question — see
``app/services/help_agent.py`` for why a server-side second copy would be worse
than useless.

Backpressure
------------
The help model is served on shared fleet hardware where local models run
one-at-a-time. Two gates, both fail-closed:

* a per-user rate limit, so one person cannot monopolise it, and
* a small GLOBAL in-flight cap, so a dozen people pressing ask at once queue
  behind a clear "busy" instead of stampeding a GPU that can serve one.

Both prefer refusing to pretending. The help ARTICLES are always available with
no model at all, so a refused ask degrades to "read the docs", never to a dead
help surface.
"""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from redis.asyncio import Redis

from app.deps import _rate_limit_hit, get_current_user, get_redis
from app.services import help_agent
from app.services.help_agent import HelpAgentError

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/help", tags=["Help"])


# Per-user asks per minute. Fail-closed: this fronts a shared GPU, so a Redis
# outage must not remove the only backpressure (same rule as the tts/kb buckets
# in app.deps._FAIL_CLOSED_BUCKETS).
_ASK_RATE_LIMIT_PER_MIN = 12

# Global concurrent asks. Local models on the llama.cpp router serve one request
# at a time; queueing many deep does not make them faster, it just converts a
# fast refusal into a slow timeout. Small on purpose.
_MAX_CONCURRENT_ASKS = 3
_INFLIGHT_KEY = "stable:helpagent:inflight"
# The counter is reconstructed from zero if it ever expires, so a crashed worker
# that never decrements cannot wedge the feature shut permanently. Comfortably
# longer than the upstream request timeout.
_INFLIGHT_TTL_SECONDS = 180


class HelpArticleContext(BaseModel):
    """One help article, sent by the client as grounding."""

    title: str = Field("", max_length=200)
    body: str = Field(..., min_length=1)


class HelpTurn(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., min_length=1)


class HelpAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=help_agent.MAX_QUESTION_CHARS)
    # Best-match-first. The service clamps count and total size; these bounds
    # just stop an oversized body from being parsed at all.
    articles: list[HelpArticleContext] = Field(
        default_factory=list, max_length=help_agent.MAX_CONTEXT_ARTICLES
    )
    history: list[HelpTurn] = Field(
        default_factory=list, max_length=help_agent.MAX_HISTORY_TURNS
    )


class HelpAskResponse(BaseModel):
    answer: str
    #: The LOGICAL gateway model name that was requested.
    model: str
    #: What the gateway actually served it with. Differs from ``model`` after a
    #: fleet move, which is the point of naming logically.
    served_by: str
    #: ``local_zero`` — a real $0 — or ``external``, meaning billed upstream at
    #: a rate Stable does not know and must not invent.
    pricing: str
    cost_usd: float | None


class HelpAgentStatus(BaseModel):
    enabled: bool
    model: str
    pricing: str
    #: Tri-state on purpose: ``None`` is "we could not check", which is not the
    #: same claim as ``False`` ("it is down"). The UI must not collapse them.
    reachable: bool | None


@router.get("/agent", response_model=HelpAgentStatus)
async def get_help_agent_status(
    _user: Annotated[dict[str, Any], Depends(get_current_user)],
) -> HelpAgentStatus:
    """Whether the help agent can be used, and what a question costs.

    Read-only — lists models, never generates. The client calls this to decide
    whether to offer the Ask tab at all, so it must not itself consume the
    capacity it is reporting on.
    """
    return HelpAgentStatus(**await help_agent.probe())


@router.post("/agent/ask", response_model=HelpAskResponse)
async def ask_help_agent(
    body: HelpAskRequest,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> HelpAskResponse:
    await _rate_limit_hit(
        redis,
        bucket="help_ask",
        identifier=str(user["participant_id"]),
        limit=_ASK_RATE_LIMIT_PER_MIN,
        window_seconds=60,
        fail_open=False,
    )

    if not await _acquire_slot(redis):
        raise HTTPException(
            status_code=503,
            detail=(
                "The help agent is busy right now — it shares a GPU with the "
                "rest of the fleet. Try again in a moment."
            ),
            headers={"Retry-After": "10"},
        )

    try:
        result = await help_agent.ask(
            question=body.question,
            articles=[a.model_dump() for a in body.articles],
            history=[t.model_dump() for t in body.history],
        )
    except HelpAgentError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from None
    finally:
        await _release_slot(redis)

    return HelpAskResponse(**result)


async def _acquire_slot(redis: Redis) -> bool:
    """Take one of the global in-flight slots, or report that none are free.

    Fails CLOSED: if Redis cannot be reached we cannot know how many requests
    are already in flight, and guessing "probably none" is how a shared GPU gets
    stampeded during exactly the kind of infra blip that caused the outage. The
    articles still work without a model, so refusing costs the user very little.
    """
    try:
        count = int(await redis.incr(_INFLIGHT_KEY) or 0)
        if count == 1:
            await redis.expire(_INFLIGHT_KEY, _INFLIGHT_TTL_SECONDS)
        if count > _MAX_CONCURRENT_ASKS:
            await redis.decr(_INFLIGHT_KEY)
            return False
        return True
    except Exception:
        logger.warning("help_agent_inflight_acquire_failed", exc_info=True)
        return False


async def _release_slot(redis: Redis) -> None:
    """Give the slot back. Never raises — a failure here must not turn a good
    answer into an error. The key's TTL is the backstop that stops a lost
    decrement from leaking a slot forever."""
    try:
        remaining = int(await redis.decr(_INFLIGHT_KEY) or 0)
        if remaining < 0:
            # An expiry landed mid-flight and reset the counter. Clamp rather
            # than leaving it negative, which would over-admit later.
            await redis.delete(_INFLIGHT_KEY)
    except Exception:
        logger.debug("help_agent_inflight_release_failed", exc_info=True)
