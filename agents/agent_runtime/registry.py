"""AgentRegistry — manages agent class registration, spawning, and lifecycle."""

from __future__ import annotations

import asyncio
from typing import Any, Type

import httpx
import structlog
from livekit.agents import JobContext, JobRequest

from agent_runtime.base import StableAgent
from agent_runtime.config import AgentSettings, get_agent_settings

logger = structlog.get_logger(__name__)


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

        logger.info(
            "registry_accepting_job",
            agent_type=agent_type,
            room=room_name,
        )
        await req.accept(
            name=f"stable-{agent_type}",
            identity=f"agent-{agent_type}",
        )

    async def on_job_dispatched(self, ctx: JobContext) -> None:
        """Called after a job is accepted. Spawns the agent into the room."""
        room_name: str = ctx.room.name
        agent_type = self._resolve_agent_type_from_ctx(ctx)

        agent_cls = self._agent_classes.get(agent_type or "triage")
        if agent_cls is None:
            logger.error("registry_unknown_agent_type", agent_type=agent_type)
            return

        agent = agent_cls(settings=self._settings)
        run_key = f"{agent_type}:{room_name}"

        # If there is already an agent of this type in this room, skip
        if run_key in self._running:
            logger.warning(
                "registry_agent_already_running",
                agent_type=agent_type,
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

    def _resolve_agent_type(self, req: JobRequest) -> str | None:
        """Extract the requested agent type from a JobRequest."""
        metadata: dict[str, Any] = {}
        room_meta_str: str = getattr(req.room, "metadata", "") or "" if req.room else ""

        if room_meta_str:
            try:
                import json

                metadata = json.loads(room_meta_str)
            except (ValueError, TypeError):
                pass

        agent_type: str | None = metadata.get("agent_type")

        if agent_type is None:
            # Default to triage if no specific type is requested
            agent_type = "triage" if "triage" in self._agent_classes else None

        return agent_type

    def _resolve_agent_type_from_ctx(self, ctx: JobContext) -> str | None:
        """Extract the requested agent type from a JobContext."""
        metadata: dict[str, Any] = {}
        room_meta_str: str = getattr(ctx.room, "metadata", "") or ""

        if room_meta_str:
            try:
                import json

                metadata = json.loads(room_meta_str)
            except (ValueError, TypeError):
                pass

        agent_type: str | None = metadata.get("agent_type")
        if agent_type is None:
            agent_type = "triage" if "triage" in self._agent_classes else None
        return agent_type

    async def _load_remote_configs(self) -> None:
        """Fetch agent configurations from the Stable backend."""
        try:
            resp = await self.http.get("/api/agents/configs")
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
