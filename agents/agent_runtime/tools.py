"""Tool registry and built-in tools for Stable agents.

Tool model (livekit-agents 1.5):
    Agents register plain async handlers via the ``@tool`` decorator into a
    ``ToolRegistry``. The registry serves two consumers:

      1. The REST/runtime path — ``registry.execute(name, args)`` and
         ``registry.http`` are used by the data-channel ChatHandler and by
         agent code that invokes tools directly.
      2. The LiveKit voice/LLM path — ``registry.as_function_tools()`` adapts
         every registered handler into a ``livekit.agents.FunctionTool`` (via
         ``livekit.agents.function_tool``) so they can be passed to
         ``Agent(tools=[...])``.

    livekit-agents 1.5 removed ``llm.FunctionContext`` /
    ``fnc_ctx._register_ai_function``. The 1.5 replacement is the
    ``@function_tool`` / ``FunctionTool`` / ``Agent(tools=...)`` API, which
    ``as_function_tools()`` targets.
"""

from __future__ import annotations

import functools
import inspect
import json
from dataclasses import dataclass
from typing import Any, Callable, Coroutine

import httpx
import structlog
from livekit.agents import FunctionTool, function_tool

from agent_runtime.config import get_agent_settings

logger = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    """Metadata for a registered tool."""

    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Coroutine[Any, Any, Any]]


def _extract_json_schema(fn: Callable[..., Any]) -> dict[str, Any]:
    """Build a minimal JSON Schema (object/properties) from a function's type hints.

    Used for the REST/audit description of a tool. The LiveKit FunctionTool
    path derives its own schema from the same type hints via function_tool().
    """
    sig = inspect.signature(fn)
    hints = fn.__annotations__
    properties: dict[str, Any] = {}
    required: list[str] = []

    type_map: dict[type, str] = {
        str: "string",
        int: "integer",
        float: "number",
        bool: "boolean",
    }

    for param_name, param in sig.parameters.items():
        if param_name == "self":
            continue
        hint = hints.get(param_name, str)
        json_type = type_map.get(hint, "string")
        properties[param_name] = {"type": json_type}
        if param.default is inspect.Parameter.empty:
            required.append(param_name)

    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
    }
    if required:
        schema["required"] = required
    return schema


def tool(
    name: str | None = None,
    description: str = "",
) -> Callable[
    [Callable[..., Coroutine[Any, Any, Any]]],
    Callable[..., Coroutine[Any, Any, Any]],
]:
    """Decorator that marks an async function as an agent-callable tool.

    Usage::

        @tool(name="send_message", description="Send a chat message to a room")
        async def send_message(room_id: str, content: str) -> str:
            ...
    """

    def decorator(
        fn: Callable[..., Coroutine[Any, Any, Any]],
    ) -> Callable[..., Coroutine[Any, Any, Any]]:
        tool_name = name or fn.__name__
        tool_desc = description or (fn.__doc__ or "").strip()
        schema = _extract_json_schema(fn)

        fn._tool_definition = ToolDefinition(  # type: ignore[attr-defined]
            name=tool_name,
            description=tool_desc,
            parameters=schema,
            handler=fn,
        )

        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            return await fn(*args, **kwargs)

        wrapper._tool_definition = fn._tool_definition  # type: ignore[attr-defined]
        return wrapper

    return decorator


class ToolRegistry:
    """Manages tools available to an agent and adapts them to LiveKit 1.5 FunctionTools."""

    def __init__(self, *, agent_token: str = "", backend_url: str = "") -> None:
        self._tools: dict[str, ToolDefinition] = {}
        self._agent_token: str = agent_token
        self._backend_url: str = backend_url or get_agent_settings().stable_backend_url
        self._http: httpx.AsyncClient | None = None

    # -- lifecycle --

    async def start(self) -> None:
        self._http = httpx.AsyncClient(
            base_url=self._backend_url,
            headers={"Authorization": f"Bearer {self._agent_token}"},
            timeout=httpx.Timeout(30.0, connect=10.0),
        )
        self._register_builtin_tools()

    async def shutdown(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("ToolRegistry not started -- call await start() first")
        return self._http

    # -- registration --

    def register(self, fn: Callable[..., Coroutine[Any, Any, Any]]) -> None:
        """Register a function (decorated with @tool) into this registry."""
        defn: ToolDefinition | None = getattr(fn, "_tool_definition", None)
        if defn is None:
            raise ValueError(
                f"Function {fn.__name__} is not decorated with @tool"
            )
        self._tools[defn.name] = defn
        logger.debug("tool_registered", tool=defn.name)

    def register_all(self, *fns: Callable[..., Coroutine[Any, Any, Any]]) -> None:
        for fn in fns:
            self.register(fn)

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    @property
    def definitions(self) -> dict[str, ToolDefinition]:
        return dict(self._tools)

    # -- execute --

    async def execute(self, name: str, args: dict[str, Any]) -> Any:
        defn = self._tools.get(name)
        if defn is None:
            raise KeyError(f"Unknown tool: {name}")
        logger.info("tool_execute", tool=name, args=args)
        result = await defn.handler(**args)
        logger.info("tool_result", tool=name, result_type=type(result).__name__)
        return result

    # -- LiveKit 1.5 FunctionTool bridge --

    def as_function_tools(self) -> list[FunctionTool]:
        """Adapt every registered tool into a livekit-agents 1.5 FunctionTool.

        Pass the result to ``Agent(tools=...)``. Replaces the removed
        ``to_function_context()`` (livekit-agents <1.5 ``llm.FunctionContext``).

        Each handler is wrapped by ``function_tool(handler, name=..., description=...)``.
        livekit-agents derives the JSON parameter schema from the handler's
        type hints, so the same annotations that drive ``_extract_json_schema``
        also drive the LLM-facing schema.
        """
        tools: list[FunctionTool] = []
        for defn in self._tools.values():
            try:
                ft = function_tool(
                    defn.handler,
                    name=defn.name,
                    description=defn.description or defn.name,
                )
                tools.append(ft)
            except Exception:
                logger.warning(
                    "function_tool_adapt_failed", tool=defn.name, exc_info=True
                )
        logger.info("function_tools_built", count=len(tools))
        return tools

    # -- built-in tools --

    def _register_builtin_tools(self) -> None:
        """Register the platform-level tools every agent gets."""

        @tool(name="send_message", description="Send a chat message to a room on the Stable platform")
        async def send_message(room_id: str, content: str) -> str:
            resp = await self.http.post(
                f"/api/rooms/{room_id}/messages",
                json={"content": content},
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
            return json.dumps(data)

        @tool(name="create_room", description="Create a new room on the Stable platform")
        async def create_room(name: str, type: str) -> str:
            resp = await self.http.post(
                "/api/rooms",
                json={"name": name, "type": type},
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
            return json.dumps(data)

        @tool(name="invite_to_room", description="Invite a participant into a room")
        async def invite_to_room(room_id: str, participant_id: str) -> str:
            resp = await self.http.post(
                f"/api/rooms/{room_id}/invite",
                json={"participant_id": participant_id},
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
            return json.dumps(data)

        @tool(name="summon_agent", description="Bring another AI agent into a room")
        async def summon_agent(agent_type: str, room_id: str) -> str:
            resp = await self.http.post(
                "/api/agents/summon",
                json={"agent_type": agent_type, "room_id": room_id},
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
            return json.dumps(data)

        @tool(
            name="http_request",
            description="Make an authenticated HTTP request to a UC mesh service (Project-Ops, Center Deep, etc.)",
        )
        async def http_request(method: str, url: str, body: str) -> str:
            parsed_body: Any = None
            if body:
                try:
                    parsed_body = json.loads(body)
                except json.JSONDecodeError:
                    parsed_body = body

            resp = await self.http.request(
                method=method.upper(),
                url=url,
                json=parsed_body if isinstance(parsed_body, (dict, list)) else None,
                content=parsed_body if isinstance(parsed_body, str) else None,
            )
            resp.raise_for_status()
            return resp.text

        self.register(send_message)
        self.register(create_room)
        self.register(invite_to_room)
        self.register(summon_agent)
        self.register(http_request)
