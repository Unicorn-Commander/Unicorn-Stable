"""The Stable help agent — a narrow, on-demand assistant about THIS app.

Three properties it is built around, in priority order:

1. **Scoped.** It answers about Stable and nothing else. Every other agent in
   the product is better at general work, so the honest move when a question
   falls outside the app is to say so and hand the user back, not to have a go.

2. **Grounded.** It answers from the help corpus and only the help corpus. The
   corpus lives in ``web/src/content/help/*.md`` as ONE copy, and the client
   retrieves the relevant articles and sends them with the question (see
   ``content/help/index.ts``). A second copy pinned here in Python would drift
   from the markdown within a week and then confidently state stale things as
   fact — the exact failure mode this whole surface exists to avoid. So the
   context arrives as an argument, and this module owns the *behaviour*, not the
   *content*.

3. **Honestly routed.** The model is named LOGICALLY (``qwen3.6-35b``) and
   resolved by the UC gateway, so the fleet can move the weights between boxes
   without touching Stable. Nothing here pins a host or a GPU.

Cost
----
The default model is served on our own hardware, so a message costs nothing and
``cost_usd`` is a real 0.0 rather than a placeholder. If an operator repoints
``HELP_AGENT_MODEL`` at a hosted model they must also set
``HELP_AGENT_IS_LOCAL=false``; the response then reports ``pricing="external"``
and the UI says the call is billed upstream INSTEAD OF quoting a number Stable
cannot actually know. We never fabricate a price.

Capacity
--------
Local models on the llama.cpp router run one-at-a-time; a concurrent model swap
kills in-flight requests. Two consequences are deliberate:

* This agent is **on demand only**. There is no polling, no warm-up call, no
  background task, and no room membership. It runs when a user presses ask.
* Upstream saturation (429 / 503 / timeout) surfaces as a plain "busy, try
  again" rather than a retry storm against a shared GPU.

Status signalling
-----------------
This agent is NOT a room participant, so it deliberately publishes no
``agent_typing`` and gets no presence dot — inventing either would be a fake
liveness signal for something that is not in the room. The only "it is working"
evidence that exists is the in-flight HTTP request, and the client shows exactly
that, for exactly as long as it is true. See ``app/services/agent_status.py``
for the same rule applied to real room agents.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import httpx
import structlog

logger = structlog.get_logger(__name__)


# --- Limits -----------------------------------------------------------------
# The client controls the context and the history, so every one of these is a
# server-side ceiling, not a suggestion.

MAX_QUESTION_CHARS = 2_000
MAX_CONTEXT_CHARS = 24_000
MAX_CONTEXT_ARTICLES = 6
MAX_HISTORY_TURNS = 8
MAX_ANSWER_TOKENS = 700

# Generous: a cold local model can spend most of a minute loading weights before
# it emits its first token, and failing that request teaches users the feature
# is broken when it is merely cold.
_REQUEST_TIMEOUT = httpx.Timeout(120.0, connect=10.0)
_PROBE_TIMEOUT = httpx.Timeout(6.0, connect=3.0)


class HelpAgentError(RuntimeError):
    """A failure that is safe to show a user verbatim."""

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class HelpAgentConfig:
    enabled: bool
    base_url: str
    model: str
    api_key: str
    is_local: bool

    @property
    def pricing(self) -> str:
        """``"local_zero"`` (a real $0) or ``"external"`` (billed upstream, and
        Stable does not know the rate — so it must not print one)."""
        return "local_zero" if self.is_local else "external"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@lru_cache(maxsize=1)
def get_config() -> HelpAgentConfig:
    """Read configuration from the environment.

    Read here rather than from ``app.config.Settings`` only because this feature
    landed alongside concurrent work on that file; these belong in Settings and
    should move there. The names are already Settings-shaped.

    ``HELP_AGENT_BASE_URL`` is deployment-owned; its neutral default is a local
    endpoint. ``HELP_AGENT_MODEL`` is a LOGICAL gateway name — the gateway owns
    which GPU serves it, so moving the model between boxes needs no change here.
    """
    return HelpAgentConfig(
        enabled=_env_bool("HELP_AGENT_ENABLED", True),
        base_url=(
            os.getenv("HELP_AGENT_BASE_URL") or "http://localhost:4000/v1"
        ).rstrip("/"),
        model=os.getenv("HELP_AGENT_MODEL") or "qwen3.6-35b",
        api_key=os.getenv("HELP_AGENT_API_KEY") or "",
        is_local=_env_bool("HELP_AGENT_IS_LOCAL", True),
    )


# --- Prompt -----------------------------------------------------------------

# Trailing `/no_think` disables Qwen's reasoning block: this is a lookup over
# supplied documents, not a reasoning task, and the visible <think> preamble
# costs latency on a shared GPU for no gain. Harmless on models that ignore it,
# and `_strip_reasoning` cleans up any that emit one anyway.
_SYSTEM_PROMPT = """You are the help agent for Stable, a chat / voice / video \
workspace where people and AI agents are members of the same rooms.

You answer questions about Stable itself: what it does, where things are, and \
how to do them.

Rules, in order of priority:

1. Answer ONLY from the HELP ARTICLES given below. They are the product \
documentation and they are authoritative.
2. If the articles do not cover the question, say plainly that the help section \
does not cover it and suggest asking the team. Do NOT guess, and do NOT fill \
the gap from general knowledge about other chat apps — Stable is not Slack or \
Discord and assuming it works like them is how you get someone lost.
3. If the question is not about Stable at all (general knowledge, writing code, \
summarising the user's own conversations, anything about the world), say that \
you only cover Stable, and point them at the other agents in the app, which are \
better at that work. Do not attempt it.
4. Never invent a feature, a menu item, a keyboard shortcut or a setting. If you \
are not sure a thing exists, say you are not sure.

Style: direct and short. Lead with the answer, then the steps. Use markdown. \
Two or three sentences is usually right; never pad. Say "I don't know" in four \
words rather than forty.

/no_think"""


_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)


def _strip_reasoning(text: str) -> str:
    """Remove a stray ``<think>…</think>`` preamble.

    Belt and braces alongside ``/no_think``: a model that ignores the directive
    must not leak its scratchpad into a help answer. An UNCLOSED block means the
    reply was truncated mid-thought and contains no answer at all — say that
    rather than showing raw reasoning.
    """
    cleaned = _THINK_BLOCK_RE.sub("", text).strip()
    if "<think>" in cleaned.lower():
        return ""
    return cleaned


def _clamp_context(articles: list[dict[str, Any]]) -> str:
    """Render the client-supplied articles into a bounded prompt block.

    The client chooses WHICH articles (it holds the corpus); the server bounds
    HOW MUCH, because the client is not a trust boundary. Articles are taken in
    the order given — the client sends them best-match first — so truncation
    drops the least relevant, never the most.
    """
    parts: list[str] = []
    budget = MAX_CONTEXT_CHARS

    for item in articles[:MAX_CONTEXT_ARTICLES]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:200]
        body = str(item.get("body") or "").strip()
        if not body:
            continue
        block = f"### {title}\n{body}" if title else body
        if len(block) > budget:
            block = block[:budget]
        if not block.strip():
            break
        parts.append(block)
        budget -= len(block)
        if budget <= 0:
            break

    return "\n\n".join(parts)


def _build_messages(
    *,
    question: str,
    context: str,
    history: list[dict[str, Any]],
) -> list[dict[str, str]]:
    system = _SYSTEM_PROMPT
    if context:
        system = f"{system}\n\n--- HELP ARTICLES ---\n\n{context}"
    else:
        # An empty corpus must not silently become an unscoped general
        # assistant; tell the model it has nothing and let rule 2 fire.
        system = (
            f"{system}\n\n--- HELP ARTICLES ---\n\n"
            "(No help articles matched this question.)"
        )

    messages: list[dict[str, str]] = [{"role": "system", "content": system}]

    # Only the last few turns, and only well-formed ones. Roles are whitelisted
    # so a client cannot smuggle in extra system instructions.
    for turn in history[-MAX_HISTORY_TURNS:]:
        if not isinstance(turn, dict):
            continue
        role = str(turn.get("role") or "")
        content = str(turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:MAX_QUESTION_CHARS]})

    messages.append({"role": "user", "content": question})
    return messages


# --- Calls ------------------------------------------------------------------


def _auth_headers(config: HelpAgentConfig) -> dict[str, str]:
    return {"Authorization": f"Bearer {config.api_key}"} if config.api_key else {}


async def ask(
    *,
    question: str,
    articles: list[dict[str, Any]],
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Answer one question. One request, no retries, no background work.

    No retry on purpose: the local pool is shared and one-at-a-time, so a
    client-invisible retry doubles the load on the exact resource that was
    already saturated. A user pressing ask again is a better rate limiter than
    anything this function could do.
    """
    config = get_config()
    if not config.enabled:
        raise HelpAgentError(
            "The help agent is turned off on this server.", status_code=503
        )

    question = question.strip()[:MAX_QUESTION_CHARS]
    if not question:
        raise HelpAgentError("Ask a question first.", status_code=400)

    payload = {
        "model": config.model,
        "messages": _build_messages(
            question=question,
            context=_clamp_context(articles or []),
            history=history or [],
        ),
        "max_tokens": MAX_ANSWER_TOKENS,
        "temperature": 0.2,
        "stream": False,
    }

    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as http:
            response = await http.post(
                f"{config.base_url}/chat/completions",
                json=payload,
                headers={"Content-Type": "application/json", **_auth_headers(config)},
            )
    except httpx.TimeoutException:
        logger.warning("help_agent_timeout", model=config.model)
        raise HelpAgentError(
            "The help agent took too long to answer — it may be starting up or "
            "busy with another request. Try again in a moment.",
            status_code=504,
        ) from None
    except httpx.HTTPError:
        logger.warning("help_agent_unreachable", model=config.model, exc_info=True)
        raise HelpAgentError(
            "Couldn't reach the help agent. The help articles above still work.",
            status_code=502,
        ) from None

    if response.status_code in (429, 503):
        # Saturation, not breakage. Say which it is.
        logger.info("help_agent_busy", status=response.status_code, model=config.model)
        raise HelpAgentError(
            "The help agent is busy right now — it shares a GPU with the rest of "
            "the fleet. Try again in a moment.",
            status_code=503,
        )
    if response.status_code >= 400:
        logger.warning(
            "help_agent_upstream_error",
            status=response.status_code,
            model=config.model,
            body=response.text[:400],
        )
        raise HelpAgentError(
            "The help agent couldn't answer that one. The help articles above "
            "still work.",
            status_code=502,
        )

    try:
        data = response.json()
        choices = data.get("choices") or []
        answer = _strip_reasoning(str(choices[0]["message"]["content"] or ""))
        served_by = str(data.get("model") or config.model)
    except (ValueError, KeyError, IndexError, TypeError):
        logger.warning("help_agent_bad_response", model=config.model, exc_info=True)
        raise HelpAgentError(
            "The help agent returned something unreadable. Try again.",
            status_code=502,
        ) from None

    if not answer:
        raise HelpAgentError(
            "The help agent came back empty. Try rephrasing the question.",
            status_code=502,
        )

    return {
        "answer": answer,
        # The LOGICAL name we asked for, and what the gateway actually served.
        # Both, because they are different facts and a fleet move changes the
        # second without changing the first.
        "model": config.model,
        "served_by": served_by,
        "pricing": config.pricing,
        # Real for local. None — never a made-up number — when an operator has
        # repointed this at a hosted model whose rate Stable does not know.
        "cost_usd": 0.0 if config.is_local else None,
    }


async def probe() -> dict[str, Any]:
    """Is the help agent configured and is the gateway answering?

    Cheap and read-only: it lists models, it does not generate. Never sends a
    warm-up completion — that would occupy the shared local model to answer a
    question nobody asked.

    ``reachable`` is deliberately three-valued via ``None``: "we could not
    check" is not "it is down", and this surface does not get to guess upward or
    downward. Same rule as ``agentStatus.ts``.
    """
    config = get_config()
    result: dict[str, Any] = {
        "enabled": config.enabled,
        "model": config.model,
        "pricing": config.pricing,
        "reachable": None,
    }
    if not config.enabled:
        result["reachable"] = False
        return result

    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as http:
            response = await http.get(
                f"{config.base_url}/models", headers=_auth_headers(config)
            )
        result["reachable"] = response.status_code < 400
    except httpx.HTTPError:
        logger.debug("help_agent_probe_failed", exc_info=True)
        # Stays None: a failed probe is "unknown", and the UI must not paint it
        # as a confirmed outage.
        pass

    return result


__all__ = [
    "HelpAgentConfig",
    "HelpAgentError",
    "MAX_CONTEXT_ARTICLES",
    "MAX_CONTEXT_CHARS",
    "MAX_HISTORY_TURNS",
    "MAX_QUESTION_CHARS",
    "ask",
    "get_config",
    "probe",
]
