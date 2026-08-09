"""TriageAgent — routes requests, answers questions, coordinates between humans and agents.

Migrated to livekit-agents 1.5: builds an ``Agent`` + ``AgentSession`` (the
``VoicePipelineAgent`` / ``llm.FunctionContext`` APIs were removed in 1.5).
Triage-specific tools are adapted to 1.5 ``FunctionTool`` objects via
``ToolRegistry.as_function_tools()`` and passed to ``Agent(tools=[...])``.

Voice (STT/TTS) is wired only when the plugins build successfully; otherwise the
Agent is LLM-only and text replies flow through the data-channel ChatHandler /
the server-side text path. The server text path remains the shipping default.
"""

from __future__ import annotations

import json
import re
from typing import Any

import structlog
from livekit.agents import Agent, AgentSession, JobContext

from agent_runtime.base import StableAgent
from agent_runtime.config import AgentSettings, api_path
from agent_runtime.tools import tool

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
    # When Brigade is the LLM backend, this Stable agent acts as this Brigade agent.
    # The General is the primary orchestrator — same role as triage here.
    brigade_agent_id: str = "the-general"

    def __init__(self, settings: AgentSettings | None = None) -> None:
        super().__init__(settings)
        self._tts_provider: str = "kokoro"
        self._tts_voice_id: str | None = None
        self._stt_provider: str = "whisper"
        self._session: AgentSession | None = None
        self._lk_agent: Agent | None = None

    async def build_pipeline(self, ctx: JobContext) -> Any:
        """Assemble the LiveKit Agent + AgentSession (VAD + STT + LLM + TTS + tools).

        Returns the AgentSession, exposing a ``start_room(room)`` shim so
        base.py's lifecycle (which calls ``self._pipeline.start_room(room)``)
        works the same way it did for the old VoicePipelineAgent.
        """
        cfg = self._settings

        # LLM — Brigade primary, then Anthropic / OpenAI / OpenRouter.
        llm_plugin = self._build_llm(cfg)

        # Register triage-specific tools on top of the built-in platform tools,
        # then adapt the whole registry to 1.5 FunctionTools for the Agent.
        self._register_triage_tools()
        function_tools = self.tools.as_function_tools()

        # Optional voice plugins. Failure here keeps the agent text-only.
        stt_plugin = None
        tts_plugin = None
        vad_plugin = None
        try:
            from plugins.stt import get_stt_plugin
            stt_plugin = get_stt_plugin(self._stt_provider, settings=cfg)
        except Exception as e:
            logger.info("triage_no_stt", reason=str(e))
        try:
            from plugins.tts import get_tts_plugin
            tts_plugin = get_tts_plugin(
                self._tts_provider,
                voice_id=self._tts_voice_id,
                personality="triage",
                settings=cfg,
            )
        except Exception as e:
            logger.info("triage_no_tts", reason=str(e))
        if stt_plugin is not None:
            # Whisper-compat STT does not stream; a VAD slices audio into
            # utterances before STT.
            try:
                from livekit.plugins import silero
                vad_plugin = silero.VAD.load()
            except Exception as e:
                logger.info("triage_no_vad", reason=str(e))

        agent_kwargs: dict[str, Any] = {
            "instructions": self.system_prompt,
            "llm": llm_plugin,
            "tools": function_tools,
        }
        if stt_plugin is not None:
            agent_kwargs["stt"] = stt_plugin
        if vad_plugin is not None:
            agent_kwargs["vad"] = vad_plugin
        if tts_plugin is not None:
            agent_kwargs["tts"] = tts_plugin

        self._lk_agent = Agent(**agent_kwargs)

        session = AgentSession()
        self._session = session

        async def _start(room: Any) -> None:
            await session.start(agent=self._lk_agent, room=room)

        session.start_room = _start  # type: ignore[attr-defined]

        logger.info(
            "triage_session_built",
            llm=type(llm_plugin).__name__,
            num_tools=len(function_tools),
            has_stt=stt_plugin is not None,
            has_tts=tts_plugin is not None,
            has_vad=vad_plugin is not None,
        )
        return session

    def _build_llm(self, cfg: AgentSettings) -> Any:
        """Build the LLM plugin.

        Preference order:
          1. Unicorn Brigade (via OpenAI-compat adapter) — persona, memory,
             delegation all come from Brigade. The LiveKit side stays a
             thin voice/room host.
          2. Direct Anthropic.
          3. OpenAI.
          4. OpenRouter.
        """
        if cfg.brigade_api_key:
            from agent_runtime.brigade_llm import build_brigade_llm
            brigade_agent_id = getattr(self, "brigade_agent_id", None) or "the-general"
            user_id = getattr(self, "_human_user_id", None)
            logger.info(
                "triage_llm_provider",
                provider="brigade",
                brigade_agent_id=brigade_agent_id,
                has_user_id=bool(user_id),
            )
            return build_brigade_llm(
                cfg,
                brigade_agent_id=brigade_agent_id,
                user_id=user_id,
            )

        from livekit.plugins import anthropic, openai

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
            "No LLM provider configured. Set BRIGADE_API_KEY, ANTHROPIC_API_KEY, "
            "OPENAI_API_KEY, or OPENROUTER_API_KEY."
        )

    def _register_triage_tools(self) -> None:
        """Register triage-specific tools on top of the built-in platform tools.

        Every path targets a real backend route under ``/api/v1`` (the
        scaffold-era ``/api/integrations/*`` and ``/api/rooms/{id}/status``
        endpoints never existed at any prefix). The route templates are pinned
        by server/tests/test_agent_tool_routes.py and the emitted URLs by
        agents/tests/test_tool_backend_routes.py.
        """

        @tool(
            name="summarize_conversation",
            description="Summarize the recent conversation in the current room",
        )
        async def summarize_conversation(room_id: str) -> str:
            resp = await self.tools.http.get(
                api_path(f"rooms/{room_id}/messages"),
                params={"limit": "50"},
            )
            resp.raise_for_status()
            # MessageListResponse: {"messages": [...], "cursor": ..., "has_more": ...},
            # newest first.
            messages: list[dict[str, Any]] = (resp.json() or {}).get("messages", [])
            if not messages:
                return "No recent messages to summarize."

            text_block = "\n".join(
                f"{m.get('sender_name') or 'unknown'}: {m.get('content', '')}"
                for m in reversed(messages)
            )
            return f"Recent conversation ({len(messages)} messages):\n{text_block}"

        @tool(
            name="create_ticket",
            description=(
                "Create a task in Project-Ops for tracking work. Requires the "
                "Project-Ops project number (e.g. P-00042) the task belongs to."
            ),
        )
        async def create_ticket(
            title: str, description: str, priority: str, project_number: str
        ) -> str:
            # The backend's Project-Ops federation is message-anchored: a
            # Stable message is promoted into a PO task. Post the ticket text
            # into this room, then promote that message.
            msg_resp = await self.tools.http.post(
                api_path(f"rooms/{self._room_id}/messages"),
                json={
                    "content": f"Ticket: {title}\n\n{description}",
                    "content_type": "text",
                    "metadata": {"source": "triage-agent", "kind": "ticket"},
                },
            )
            msg_resp.raise_for_status()
            message_id = (msg_resp.json() or {}).get("id")
            if not message_id:
                return "Ticket message was created but no message id was returned."

            normalized_priority = priority.upper()
            if normalized_priority not in {"LOW", "MEDIUM", "HIGH", "URGENT"}:
                normalized_priority = "MEDIUM"
            resp = await self.tools.http.post(
                api_path(f"messages/{message_id}/promote-to-po-task"),
                json={
                    "project_number": project_number,
                    "title": title,
                    "description": description,
                    "priority": normalized_priority,
                },
            )
            resp.raise_for_status()
            return json.dumps(resp.json())

        @tool(
            name="lookup_info",
            description="Look up information in the knowledge bases attached to this room",
        )
        async def lookup_info(query: str) -> str:
            # Internal agent surface — authenticated with the shared internal
            # bearer, not the per-room agent token the registry client carries.
            secret = (
                self._settings.internal_agent_secret
                or self._settings.livekit_api_secret
            )
            resp = await self.tools.http.post(
                api_path("internal/knowledge/search"),
                json={
                    "livekit_room_name": self._room_name,
                    "brigade_agent_id": self.brigade_agent_id or self.agent_type,
                    "query": query,
                    "k": 5,
                },
                headers={"Authorization": f"Bearer {secret}"},
            )
            resp.raise_for_status()
            body: dict[str, Any] = resp.json() or {}
            if body.get("status") != "ok":
                return body.get("notice") or (
                    "The knowledge base could not be searched right now."
                )
            results: list[dict[str, Any]] = body.get("results", [])
            if not results:
                return f"No results found for: {query}"
            formatted = "\n".join(
                f"- {r.get('filename', 'Untitled')}: {r.get('text', '')}"
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
            # There is no dedicated status endpoint on the backend; a status
            # update IS a room message (persisted + broadcast like any other).
            resp = await self.tools.http.post(
                api_path(f"rooms/{room_id}/messages"),
                json={
                    "content": f"Status update: {status}",
                    "content_type": "text",
                    "metadata": {"source": "triage-agent", "kind": "status_update"},
                },
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
        """Handle transcribed speech — the AgentSession LLM handles response
        generation, but we log and can trigger stage content here."""
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
