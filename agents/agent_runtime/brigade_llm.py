"""Brigade LLM helper — builds a livekit-agents LLM plugin that talks to
Unicorn Brigade via its OpenAI-compatible adapter.

Each Stable agent maps 1:1 to a Brigade agent. Brigade handles persona,
memory (Graphiti + FalkorDB), delegation, and internal tools; Stable's
LiveKit runtime handles voice, the room, and the participant view.

Usage (from a StableAgent subclass):

    from agent_runtime.brigade_llm import build_brigade_llm

    llm_plugin = build_brigade_llm(
        cfg,
        brigade_agent_id="the-general",
        user_id=<room's human user_id>,
    )
"""

from __future__ import annotations

from typing import Any, Optional

import httpx
import structlog
from livekit.plugins import openai as lk_openai

logger = structlog.get_logger(__name__)


def build_brigade_llm(
    cfg: Any,
    brigade_agent_id: str,
    user_id: Optional[str] = None,
    model_override: Optional[str] = None,
) -> Any:
    """Return a livekit.plugins.openai.LLM wired to Brigade's OpenAI-compat adapter.

    Args:
        cfg: AgentSettings instance (must expose brigade_base_url, brigade_api_key).
        brigade_agent_id: which Brigade agent this Stable agent is acting as
            (e.g. "the-general", "detective-holmes"). Passed as the `model` field.
        user_id: optional authenticated user identity to forward to Brigade.
            Sets the OpenAI `user` field, which Brigade uses for memory isolation.
            If omitted, Brigade falls back to the API key's owning user.

    Raises:
        ValueError: if Brigade is not configured.
    """
    base_url = getattr(cfg, "brigade_base_url", None) or ""
    api_key = getattr(cfg, "brigade_api_key", None) or ""

    if not base_url or not api_key:
        raise ValueError(
            "Brigade not configured. Set BRIGADE_BASE_URL and BRIGADE_API_KEY in the "
            "agent runtime environment."
        )

    logger.info(
        "brigade_llm_built",
        base_url=base_url,
        agent_id=brigade_agent_id,
        has_user_id=bool(user_id),
    )

    # livekit.plugins.openai.LLM is an OpenAI-compatible client. The `user`
    # kwarg on chat.completions is forwarded automatically when supplied here.
    kwargs: dict[str, Any] = {
        "api_key": api_key,
        "model": brigade_agent_id,
        "base_url": base_url,
        # Voice replies route through Brigade to local models (e.g. the strix
        # companion) that can take tens of seconds; without this the openai
        # plugin uses httpx's 5s default and the inference task dies with
        # ReadTimeout -> no spoken reply. Match the text path (120s).
        "timeout": httpx.Timeout(120.0, connect=10.0),
    }
    if user_id:
        kwargs["user"] = user_id
    # Per-conversation LLM override (model switcher): Brigade's openai-compat
    # adapter honors a `model_override` body field that swaps the underlying
    # model while keeping the persona (`model`=brigade_agent_id). Forward it via
    # the openai client's extra_body so live voice replies match the text thread.
    if model_override:
        kwargs["extra_body"] = {"model_override": model_override}
    return lk_openai.LLM(**kwargs)
