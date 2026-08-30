"""AgentRegistry — manages agent class registration, spawning, and lifecycle.

**Participant identity is PER AGENT, not per agent TYPE.** Every Brigade agent
used to join LiveKit as the single identity ``agent-brigade`` (identity is
derived from ``agent_type``, and ``agent_type`` is ``"brigade"`` for all ~56
Brigade personas). LiveKit treats identity as unique within a room, so a second
dispatch EVICTED the first and the room ended up agentless. Workers now accept
as ``agent-<brigade_agent_id>`` — ``agent-majik``, ``agent-the-general`` — so
several agents can hold one room at once, each with its own tile, name and
voice. The type-shaped form is still the fallback for a job that names no
Brigade persona (the ``triage`` agent), so nothing that never had a
``brigade_agent_id`` changes shape.
"""

from __future__ import annotations

import asyncio
from typing import Any, Type

import httpx
import structlog
from livekit.agents import JobContext, JobRequest

from agent_runtime.base import StableAgent
from agent_runtime.config import AgentSettings, api_path, get_agent_settings

logger = structlog.get_logger(__name__)


def agent_participant_identity(
    agent_type: str, brigade_agent_id: str | None
) -> str:
    """The LiveKit identity a worker joins under.

    Persona-shaped when the dispatch names a Brigade agent, so two agents in
    one room are two participants instead of one eviction. Falls back to the
    historical type-shaped form for agents that have no Brigade persona.

    Matches the aliases the backend already resolves
    (server/app/services/transcript_identity.py) and the eviction patterns
    ``remove_brigade_agent`` tries, so a persona identity was already
    understood everywhere it needed to be.
    """
    if brigade_agent_id:
        return f"agent-{brigade_agent_id}"
    return f"agent-{agent_type}"


def agent_participant_name(agent_type: str, brigade_agent_id: str | None) -> str:
    """The LiveKit display name — what the call tile's name plate shows.

    Mirrors the server's canonical derivation
    (``brigade_agent_id.replace("-", " ").title()``, used by
    agent_chat_responder and transcript_publisher._agent_display_name) so a
    tile, a caption line and a chat message all label the same agent the same
    way. Previously every agent was named ``stable-brigade`` in the call.
    """
    if brigade_agent_id:
        return brigade_agent_id.replace("-", " ").title()
    return f"stable-{agent_type}"


class _RunningAgent:
    """Tracks a single running agent instance."""

    __slots__ = ("agent", "room_name", "task")

    def __init__(self, agent: StableAgent, room_name: str, task: asyncio.Task[None]) -> None:
        self.agent = agent
        self.room_name = room_name
        self.task = task


class AgentRegistry:
    """Central registry that maps agent types to classes, spawns them into
    LiveKit rooms on dispatch, and manages graceful shutdown.
    """

    def __init__(self, settings: AgentSettings | None = None) -> None:
        self._settings: AgentSettings = settings or get_agent_settings()
        self._agent_classes: dict[str, Type[StableAgent]] = {}
        self._running: dict[str, _RunningAgent] = {}
        self._http: httpx.AsyncClient | None = None
        self._shutting_down: bool = False

    # ---------- lifecycle ----------

    async def start(self) -> None:
        """Initialize the registry (fetch remote configs, open HTTP client)."""
        self._http = httpx.AsyncClient(
            base_url=self._settings.stable_backend_url,
            timeout=httpx.Timeout(15.0, connect=5.0),
        )
        await self._load_remote_configs()
        logger.info(
            "registry_started",
            registered_types=list(self._agent_classes.keys()),
        )

    async def shutdown(self) -> None:
        """Gracefully stop all running agents and close connections."""
        self._shutting_down = True
        logger.info("registry_shutting_down", running_count=len(self._running))

        tasks: list[asyncio.Task[None]] = []
        for key, entry in list(self._running.items()):
            entry.task.cancel()
            tasks.append(entry.task)

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        self._running.clear()

        if self._http is not None:
            await self._http.aclose()
            self._http = None

        logger.info("registry_stopped")

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("AgentRegistry not started")
        return self._http

    # ---------- registration ----------

    def register(self, agent_cls: Type[StableAgent]) -> Type[StableAgent]:
        """Register an agent class by its ``agent_type``."""
        agent_type = agent_cls.agent_type
        if agent_type in self._agent_classes:
            logger.warning("registry_overwrite", agent_type=agent_type)
        self._agent_classes[agent_type] = agent_cls
        logger.info("registry_registered", agent_type=agent_type)
        return agent_cls

    def get_class(self, agent_type: str) -> Type[StableAgent] | None:
        return self._agent_classes.get(agent_type)

    @property
    def registered_types(self) -> list[str]:
        return list(self._agent_classes.keys())

    # ---------- dispatching ----------

    async def on_job_request(self, req: JobRequest) -> None:
        """Called by the LiveKit worker when a new job request arrives.

        Decides whether to accept the job based on room metadata or agent type
        requested in the job metadata.
        """
        if self._shutting_down:
            await req.reject()
            return

        room_name: str = req.room.name if req.room else ""
        agent_type = self._resolve_agent_type(req)

        if agent_type is None or agent_type not in self._agent_classes:
            logger.warning(
                "registry_no_agent_for_job",
                room=room_name,
                requested_type=agent_type,
            )
            await req.reject()
            return

        brigade_agent_id = self._resolve_brigade_agent_id(req)
        # An explicit override wins. The voice relay uses it to join AS the
        # participant it speaks for, so the call tile resolves to that
        # character's name and art instead of the type-shaped `agent-relay`.
        #
        # JOB metadata ONLY — never the room's. The identity is a property of
        # ONE dispatch, and room metadata is shared mutable state that the
        # previous dispatch baked its own override into: read from there, the
        # NEXT agent dispatched into the room (Majik, in the live rehearsal
        # that caught this) inherits the relay's identity, joins as
        # agent-claude-code, and LiveKit's duplicate-identity handling evicts
        # the real relay. Exactly the class of bug the brigade_agent_id
        # comment below already warns about.
        job_meta_str = getattr(getattr(req, "job", None), "metadata", "") or ""
        override = self._string_from_metadata(job_meta_str, "agent_identity")
        identity = override or agent_participant_identity(agent_type, brigade_agent_id)
        name_override = self._string_from_metadata(job_meta_str, "agent_display_name")
        display_name = name_override or agent_participant_name(
            agent_type, brigade_agent_id
        )

        logger.info(
            "registry_accepting_job",
            agent_type=agent_type,
            brigade_agent_id=brigade_agent_id,
            identity=identity,
            display_name=display_name,
            room=room_name,
        )
        await req.accept(name=display_name, identity=identity)

    async def on_job_dispatched(self, ctx: JobContext) -> None:
        """Called after a job is accepted. Spawns the agent into the room."""
        room_name: str = ctx.room.name
        agent_type = self._resolve_agent_type_from_ctx(ctx)

        agent_cls = self._agent_classes.get(agent_type or "triage")
        if agent_cls is None:
            logger.error("registry_unknown_agent_type", agent_type=agent_type)
            return

        agent = agent_cls(settings=self._settings)
        # Keyed by PERSONA, not just type: `brigade:<room>` would have made
        # Majik and The General the same running agent and dropped the second
        # job on the floor in any worker process that handled both.
        brigade_agent_id = self._resolve_brigade_agent_id_from_ctx(ctx)
        run_key = f"{agent_type}:{brigade_agent_id or '-'}:{room_name}"

        # If this same agent is already running in this room, skip
        if run_key in self._running:
            logger.warning(
                "registry_agent_already_running",
                agent_type=agent_type,
                brigade_agent_id=brigade_agent_id,
                room=room_name,
            )
            return

        task = asyncio.create_task(self._run_agent(agent, ctx, run_key))
        self._running[run_key] = _RunningAgent(
            agent=agent,
            room_name=room_name,
            task=task,
        )

        logger.info(
            "registry_agent_spawned",
            agent_type=agent_type,
            brigade_agent_id=brigade_agent_id,
            identity=agent_participant_identity(
                agent_type or "triage", brigade_agent_id
            ),
            room=room_name,
            running_count=len(self._running),
        )

    # ---------- internals ----------

    async def _run_agent(self, agent: StableAgent, ctx: JobContext, run_key: str) -> None:
        """Run an agent's lifecycle and clean up when it's done."""
        try:
            await agent.start(ctx)
            # The agent stays alive until the job context shuts it down.
            # We wait on the context's shutdown signal.
            # livekit-agents 1.5 expects shutdown callbacks to return an
            # awaitable. Provide an async no-op that also resolves the
            # wait-future so the agent loop exits cleanly.
            disconnect_future: asyncio.Future[None] = asyncio.Future()

            async def _on_shutdown() -> None:
                if not disconnect_future.done():
                    disconnect_future.set_result(None)

            ctx.add_shutdown_callback(_on_shutdown)
            await disconnect_future
        except asyncio.CancelledError:
            logger.info("agent_run_cancelled", run_key=run_key)
        except Exception as exc:
            import traceback
            logger.error(
                "agent_run_error",
                run_key=run_key,
                error=repr(exc),
                tb=traceback.format_exc(),
            )
        finally:
            self._running.pop(run_key, None)
            logger.info(
                "agent_run_ended",
                run_key=run_key,
                running_count=len(self._running),
            )

    @staticmethod
    def _string_from_metadata(meta_str: str, key: str) -> str | None:
        """Parse a JSON metadata string and return a non-empty string ``key``.

        Defensive in exactly the way ``_agent_type_from_metadata`` is:
        empty/missing/malformed metadata, or a non-dict, or a non-string value,
        all return ``None`` rather than raising into the job-accept path.
        """
        if not meta_str:
            return None
        try:
            import json

            metadata = json.loads(meta_str)
        except (ValueError, TypeError):
            return None
        if not isinstance(metadata, dict):
            return None
        value = metadata.get(key)
        return value if isinstance(value, str) and value else None

    def _resolve_brigade_agent_id(self, req: JobRequest) -> str | None:
        """Which Brigade PERSONA this dispatch is for, or None.

        Job metadata first for the same reason ``_resolve_agent_type`` reads it
        first: it is the source of truth for THIS dispatch, while room metadata
        is shared mutable state that the next dispatch overwrites. In a
        multi-agent room the room copy names whoever was invited most recently,
        so trusting it would give two workers the same identity again — the
        exact bug this change exists to fix.
        """
        job_meta_str: str = getattr(getattr(req, "job", None), "metadata", "") or ""
        room_meta_str: str = (
            getattr(req.room, "metadata", "") or "" if req.room else ""
        )
        return self._string_from_metadata(
            job_meta_str, "brigade_agent_id"
        ) or self._string_from_metadata(room_meta_str, "brigade_agent_id")

    def _resolve_brigade_agent_id_from_ctx(self, ctx: JobContext) -> str | None:
        """``_resolve_brigade_agent_id`` for the post-accept JobContext."""
        job_meta_str: str = getattr(getattr(ctx, "job", None), "metadata", "") or ""
        room_meta_str: str = getattr(ctx.room, "metadata", "") or ""
        return self._string_from_metadata(
            job_meta_str, "brigade_agent_id"
        ) or self._string_from_metadata(room_meta_str, "brigade_agent_id")

    @staticmethod
    def _agent_type_from_metadata(meta_str: str) -> str | None:
        """Parse a JSON metadata string and return its ``agent_type``.

        Defensive: returns ``None`` for empty/missing/malformed metadata or
        when ``agent_type`` is absent.
        """
        if not meta_str:
            return None
        try:
            import json

            metadata = json.loads(meta_str)
        except (ValueError, TypeError):
            return None
        if not isinstance(metadata, dict):
            return None
        agent_type = metadata.get("agent_type")
        return agent_type if isinstance(agent_type, str) and agent_type else None

    def _resolve_agent_type(self, req: JobRequest) -> str | None:
        """Extract the requested agent type from a JobRequest.

        The dispatch (job) metadata is the source of truth for this dispatch
        (it carries ``{"agent_type": "brigade", ...}`` from the backend's
        ``dispatch_agent``), so we read it FIRST, then fall back to room
        metadata, then to the ``triage`` default.
        """
        job_meta_str: str = getattr(getattr(req, "job", None), "metadata", "") or ""
        room_meta_str: str = (
            getattr(req.room, "metadata", "") or "" if req.room else ""
        )

        agent_type = self._agent_type_from_metadata(job_meta_str)
        if agent_type is None:
            agent_type = self._agent_type_from_metadata(room_meta_str)
        if agent_type is None:
            # Default to triage if no specific type is requested
            agent_type = "triage" if "triage" in self._agent_classes else None

        return agent_type

    def _resolve_agent_type_from_ctx(self, ctx: JobContext) -> str | None:
        """Extract the requested agent type from a JobContext.

        The dispatch (job) metadata is the source of truth for a single
        dispatch -- it carries ``{"agent_type": "brigade", ...}`` written by
        the backend's ``dispatch_agent``. We honour it FIRST, falling back to
        room metadata (which may be stale or only partially written if the
        room-metadata bake failed) and finally to the ``triage`` default.
        """
        job_meta_str: str = getattr(getattr(ctx, "job", None), "metadata", "") or ""
        room_meta_str: str = getattr(ctx.room, "metadata", "") or ""

        agent_type = self._agent_type_from_metadata(job_meta_str)
        if agent_type is None:
            agent_type = self._agent_type_from_metadata(room_meta_str)
        if agent_type is None:
            agent_type = "triage" if "triage" in self._agent_classes else None
        return agent_type

    async def _load_remote_configs(self) -> None:
        """Fetch agent configurations from the Stable backend.

        GET /api/v1/agents is the backend's agent-config listing (the
        scaffold-era /api/agents/configs endpoint never existed).
        """
        try:
            resp = await self.http.get(api_path("agents"))
            resp.raise_for_status()
            configs: list[dict[str, Any]] = resp.json()
            logger.info("registry_configs_loaded", count=len(configs))
        except Exception:
            logger.warning("registry_configs_unavailable", exc_info=True)

    # ---------- introspection ----------

    @property
    def running_agents(self) -> dict[str, str]:
        """Return a mapping of run_key to room_name for all running agents."""
        return {key: entry.room_name for key, entry in self._running.items()}

    @property
    def running_count(self) -> int:
        return len(self._running)
