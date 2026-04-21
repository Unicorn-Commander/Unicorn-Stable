"""BrigadeBackedAgent — a generic Stable agent that acts as any Brigade agent.

The specific Brigade agent ID is read from the room metadata at dispatch time,
so one registered class can serve all 20+ Brigade agents without needing a
separate Python subclass for each.
"""

from agent_runtime.brigade_llm import build_brigade_llm  # noqa: F401
from brigade_backed.agent import BrigadeBackedAgent

__all__ = ["BrigadeBackedAgent"]
