"""TriageAgent — routes requests, answers questions, coordinates between humans and agents."""

from __future__ import annotations

import json
import re
from typing import Any

import structlog
from livekit.agents import JobContext
from livekit.agents.pipeline import VoicePipelineAgent
from livekit.plugins import anthropic, openai, silero

from agent_runtime.base import StableAgent
from agent_runtime.config import AgentSettings, get_agent_settings
from agent_runtime.tools import tool
from plugins.stt import get_stt_plugin
from plugins.tts import get_tts_plugin

logger = structlog.get_logger(__name__)

TRIAGE_SYSTEM_PROMPT: str = """You are the Triage agent for Unicorn Commander on the Stable platform.

Your role:
- Route incoming requests to the right person or specialist agent
- Answer general questions about projects, status, and team activity
- Coordinate between humans and other AI agents in the room
- Summarize conversations when asked
- Create tickets and tasks in Project-Ops when action items are identified
- Look up information in Center Deep when research is needed

Behavior:
- Be concise and action-oriented. Don't ramble.
- When you don't know something, say so and offer to look it up or summon a specialist.
- Monitor the room for keywords like "help", "urgent", "bug", "blocked" and proactively offer assistance.
- Respond to @mentions and direct questions immediately.
- For complex requests, break them down into steps and coordinate.

Available tools let you: send messages, create rooms, invite participants, summon other agents, create tickets, look up info, and post status updates.
"""

# Keywords that trigger proactive response
_PROACTIVE_KEYWORDS: set[str] = {
    "help",
    "urgent",
    "bug",
    "blocked",
    "broken",
    "down",
    "error",
    "critical",
    "emergency",
    "asap",
}

_MENTION_PATTERN: re.Pattern[str] = re.compile(
    r"@(?:triage|agent|stable)\b", re.IGNORECASE
)


class TriageAgent(StableAgent):
    agent_type: str = "triage"
    system_prompt: str = TRIAGE_SYSTEM_PROMPT

    def __init__(self, settings: AgentSettings | None = None) -> None:
        super().__init__(settings)
        self._tts_provider: str = "elevenlabs"
        self._tts_voice_id: str | None = None
        self._stt_provider: str = "deepgram"

    async def build_pipeline(self, ctx: JobContext) -> VoicePipelineAgent:
        """Assemble the full voice pipeline: VAD + STT + LLM + TTS."""
        cfg = self._settings

        # VAD
        vad = silero.VAD.load()

        # STT
        stt = get_stt_plugin(self._stt_provider, settings=cfg)

        # TTS
        tts = get_tts_plugin(
            self._tts_provider,
            voice_id=self._tts_voice_id,
            personality="triage",
            settings=cfg,
        )

        # LLM — Anthropic Claude primary, OpenAI fallback
        llm_plugin = self._build_llm(cfg)

        # Register triage-specific tools
        self._register_triage_tools()

        pipeline = VoicePipelineAgent(
            vad=vad,
            stt=stt,
            llm=llm_plugin,
            tts=tts,
            chat_ctx=self._build_chat_context(),
            fnc_ctx=self.tools.to_function_context(),
        )

        logger.info("triage_pipeline_built", llm=type(llm_plugin).__name__)
        return pipeline

    def _build_llm(self, cfg: AgentSettings) -> Any:
        """Build the LLM plugin, preferring Anthropic, falling back to OpenAI."""
        if cfg.anthropic_api_key:
            logger.info("triage_llm_provider", provider="anthropic")
            return anthropic.LLM(
                api_key=cfg.anthropic_api_key,
                model="claude-sonnet-4-20250514",
            )

        if cfg.openai_api_key:
            logger.info("triage_llm_provider", provider="openai")
            return openai.LLM(
                api_key=cfg.openai_api_key,
                model="gpt-4o",
            )

        if cfg.openrouter_api_key:
            logger.info("triage_llm_provider", provider="openrouter")
            return openai.LLM(
                api_key=cfg.openrouter_api_key,
                model="anthropic/claude-sonnet-4-20250514",
                base_url="https://openrouter.ai/api/v1",
            )

        raise ValueError(
            "No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY."
        )

    def _build_chat_context(self) -> Any:
        """Build the initial chat context with the system prompt."""
        from livekit.agents import llm as lk_llm

        chat_ctx = lk_llm.ChatContext()
        chat_ctx.append(role="system", text=self.system_prompt)
        return chat_ctx

    def _register_triage_tools(self) -> None:
        """Register triage-specific tools on top of the built-in platform tools."""

        @tool(
            name="summarize_conversation",
            description="Summarize the recent conversation in the current room",
        )
        async def summarize_conversation(room_id: str) -> str:
            resp = await self.tools.http.get(
                f"/api/rooms/{room_id}/messages",
                params={"limit": "50", "order": "desc"},
            )
            resp.raise_for_status()
            messages: list[dict[str, Any]] = resp.json()
            if not messages:
                return "No recent messages to summarize."

            text_block = "\n".join(
                f"{m.get('sender', 'unknown')}: {m.get('content', '')}"
                for m in reversed(messages)
            )
            return f"Recent conversation ({len(messages)} messages):\n{text_block}"

        @tool(
            name="create_ticket",
            description="Create a ticket or task in Project-Ops for tracking work",
        )
        async def create_ticket(title: str, description: str, priority: str) -> str:
            resp = await self.tools.http.post(
                "/api/integrations/project-ops/tickets",
                json={
                    "title": title,
                    "description": description,
                    "priority": priority,
                    "source": "triage-agent",
                },
            )
            resp.raise_for_status()
            return json.dumps(resp.json())

        @tool(
            name="lookup_info",
            description="Look up information in Center Deep knowledge base",
        )
        async def lookup_info(query: str) -> str:
            resp = await self.tools.http.post(
                "/api/integrations/center-deep/search",
                json={"query": query, "limit": 5},
            )
            resp.raise_for_status()
            results: list[dict[str, Any]] = resp.json().get("results", [])
            if not results:
                return f"No results found for: {query}"
            formatted = "\n".join(
                f"- {r.get('title', 'Untitled')}: {r.get('snippet', '')}"
                for r in results
            )
            return f"Found {len(results)} results:\n{formatted}"

        @tool(
            name="summon_specialist",
            description="Summon a specialist agent into the current room for a specific task",
        )
        async def summon_specialist(agent_type: str, room_id: str) -> str:
            return await self.tools.execute(
                "summon_agent",
                {"agent_type": agent_type, "room_id": room_id},
            )

        @tool(
            name="post_status_update",
            description="Post a status update visible to the room and logged to the backend",
        )
        async def post_status_update(room_id: str, status: str) -> str:
            resp = await self.tools.http.post(
                f"/api/rooms/{room_id}/status",
                json={"status": status, "source": "triage-agent"},
            )
            resp.raise_for_status()
            if self.chat is not None:
                await self.chat.send_chat(f"Status update: {status}")
            return json.dumps({"posted": True, "status": status})

        self.tools.register(summarize_conversation)
        self.tools.register(create_ticket)
        self.tools.register(lookup_info)
        self.tools.register(summon_specialist)
        self.tools.register(post_status_update)

    # ---------- event overrides ----------

    async def on_message(self, message: dict[str, Any]) -> None:
        """React to incoming chat messages — handle mentions and proactive keywords."""
        content: str = message.get("content", "")
        sender: str = message.get("sender", "unknown")

        # Always respond to direct mentions
        if _MENTION_PATTERN.search(content):
            logger.info("triage_mention_detected", sender=sender)
            if self.chat is not None:
                await self.chat.send_chat(
                    f"I'm here, {sender}. What do you need?"
                )
            return

        # Proactive response to urgent keywords
        content_lower = content.lower()
        triggered_keywords = _PROACTIVE_KEYWORDS.intersection(content_lower.split())
        if triggered_keywords:
            logger.info(
                "triage_keyword_triggered",
                sender=sender,
                keywords=list(triggered_keywords),
            )
            if self.chat is not None:
                await self.chat.send_chat(
                    f"I noticed you mentioned {', '.join(triggered_keywords)}. "
                    f"Can I help with anything?"
                )

    async def on_user_speech(self, text: str) -> None:
        """Handle transcribed speech — the pipeline LLM handles response generation,
        but we log and can trigger stage content here."""
        logger.info("triage_user_speech", text_length=len(text), preview=text[:100])
        await self._log_agent_event("user_speech", {"text": text})

    async def on_function_call(self, name: str, args: dict[str, Any]) -> Any:
        """Execute a tool call, with logging."""
        logger.info("triage_function_call", tool=name, args=args)
        result = await self.tools.execute(name, args)

        # If the tool returned substantial content, show it on the stage
        if isinstance(result, str) and len(result) > 200:
            await self.stage.show_text(result[:500])

        return result
