"""Every builtin + triage tool must call a REAL Stable backend route.

Regression net for the scaffold-era bug where the whole agent runtime spoke
an unversioned "/api/..." dialect (including endpoints that never existed,
like /api/agents/summon and /api/integrations/*) while the backend mounts
every router under "/api/v1" — so every tool call 404'd.

This suite executes each tool against a capturing ``httpx.MockTransport`` and
asserts the URL it emits matches one of the backend's route templates.

The template table below is the agents-side half of a two-sided pin: the
server-side twin — server/tests/test_agent_tool_routes.py — asserts the SAME
templates exist on the real FastAPI app. The two images cannot import each
other, so each side pins its half; change them together, deliberately.
"""

from __future__ import annotations

import asyncio
import json
import re

import httpx

from agent_runtime.config import STABLE_API_PREFIX, api_path
from agent_runtime.tools import ToolRegistry

# (METHOD, backend route template) — must stay in lockstep with
# server/tests/test_agent_tool_routes.py::AGENT_CALLED_ROUTES.
BACKEND_ROUTE_TEMPLATES: list[tuple[str, str]] = [
    ("GET", "/api/v1/rooms/{room_id}/messages"),
    ("POST", "/api/v1/rooms/{room_id}/messages"),
    ("POST", "/api/v1/rooms"),
    ("POST", "/api/v1/rooms/{room_id}/invite"),
    ("POST", "/api/v1/rooms/{room_name}/invite-brigade-agent"),
    ("POST", "/api/v1/internal/knowledge/search"),
    ("POST", "/api/v1/messages/{message_id}/promote-to-po-task"),
    ("GET", "/api/v1/agents"),
]


def _template_regex(template: str) -> re.Pattern[str]:
    pattern = re.sub(r"\\\{[^/]+\\\}", r"[^/]+", re.escape(template))
    return re.compile(f"^{pattern}$")

_COMPILED = [(m, t, _template_regex(t)) for m, t in BACKEND_ROUTE_TEMPLATES]


def _matches_backend_route(method: str, path: str) -> bool:
    return any(m == method and rx.match(path) for m, _t, rx in _COMPILED)


class _Capture:
    """MockTransport handler: records calls, answers with route-shaped JSON."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method = request.method
        path = request.url.path
        self.calls.append((method, path))

        if method == "GET" and re.match(r"^/api/v1/rooms/[^/]+/messages$", path):
            return httpx.Response(
                200,
                json={
                    "messages": [
                        {
                            "sender_name": "alice",
                            "content": "hello",
                            "content_type": "text",
                            "sender_type": "human",
                        }
                    ],
                    "cursor": None,
                    "has_more": False,
                },
            )
        if method == "POST" and re.match(r"^/api/v1/rooms/[^/]+/messages$", path):
            return httpx.Response(201, json={"id": "11111111-1111-1111-1111-111111111111"})
        if method == "POST" and path == "/api/v1/rooms":
            return httpx.Response(201, json={"id": "room-1"})
        if method == "POST" and re.match(r"^/api/v1/rooms/[^/]+/invite$", path):
            return httpx.Response(200, json={"id": "member-1"})
        if method == "POST" and re.match(
            r"^/api/v1/rooms/[^/]+/invite-brigade-agent$", path
        ):
            return httpx.Response(200, json={"room_name": "lk-room-1"})
        if method == "POST" and path == "/api/v1/internal/knowledge/search":
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "notice": None,
                    "results": [{"text": "excerpt", "filename": "doc.md", "score": 0.9}],
                },
            )
        if method == "POST" and re.match(
            r"^/api/v1/messages/[^/]+/promote-to-po-task$", path
        ):
            return httpx.Response(
                200,
                json={"task_id": "T1", "project_number": "P-00001", "task_url": "u"},
            )
        if method == "GET" and path == "/api/v1/agents":
            return httpx.Response(200, json=[])
        return httpx.Response(404, json={"detail": f"no such route: {method} {path}"})


def _mock_client(capture: _Capture) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.MockTransport(capture),
        base_url="http://backend:8400",
        headers={"Authorization": "Bearer per-room-agent-token"},
    )


def test_api_path_builder() -> None:
    assert STABLE_API_PREFIX == "/api/v1"
    assert api_path("rooms") == "/api/v1/rooms"
    assert api_path("/rooms") == "/api/v1/rooms"
    assert api_path("internal/agent-events") == "/api/v1/internal/agent-events"


def test_builtin_tools_hit_real_backend_routes() -> None:
    capture = _Capture()

    async def run() -> None:
        registry = ToolRegistry(agent_token="t", backend_url="http://backend:8400")
        registry._http = _mock_client(capture)
        registry._register_builtin_tools()

        assert set(registry.definitions) == {
            "send_message",
            "create_room",
            "invite_to_room",
            "summon_agent",
            "http_request",
        }

        await registry.execute(
            "send_message", {"room_id": "R1", "content": "hi"}
        )
        await registry.execute("create_room", {"name": "warroom", "type": "channel"})
        await registry.execute(
            "invite_to_room", {"room_id": "R1", "participant_id": "P1"}
        )
        await registry.execute(
            "summon_agent", {"agent_type": "the-general", "room_id": "R1"}
        )
        # http_request is the mesh escape hatch (LLM-supplied URL); exercised
        # here with a versioned backend path to document intended use.
        await registry.execute(
            "http_request", {"method": "GET", "url": api_path("agents"), "body": ""}
        )
        await registry.shutdown()

    asyncio.run(run())

    expected = [
        ("POST", "/api/v1/rooms/R1/messages"),
        ("POST", "/api/v1/rooms"),
        ("POST", "/api/v1/rooms/R1/invite"),
        ("POST", "/api/v1/rooms/R1/invite-brigade-agent"),
        ("GET", "/api/v1/agents"),
    ]
    assert capture.calls == expected

    for method, path in capture.calls:
        assert path.startswith(STABLE_API_PREFIX + "/"), (method, path)
        assert _matches_backend_route(method, path), (
            f"{method} {path} does not match any backend route template — "
            "if the backend actually serves this route, update "
            "BACKEND_ROUTE_TEMPLATES here AND in "
            "server/tests/test_agent_tool_routes.py"
        )


def test_triage_tools_hit_real_backend_routes() -> None:
    from agent_runtime.config import AgentSettings
    from triage.agent import TriageAgent

    capture = _Capture()

    async def run() -> None:
        settings = AgentSettings(
            internal_agent_secret="internal-secret",
            livekit_api_secret="lk-secret",
        )
        agent = TriageAgent(settings=settings)
        agent._room_id = "ROOMUUID"
        agent._room_name = "lk-room-1"
        agent.tools._http = _mock_client(capture)
        agent.tools._register_builtin_tools()
        agent._register_triage_tools()

        for name in (
            "summarize_conversation",
            "create_ticket",
            "lookup_info",
            "summon_specialist",
            "post_status_update",
        ):
            assert agent.tools.get(name) is not None, f"triage tool missing: {name}"

        summary = await agent.tools.execute(
            "summarize_conversation", {"room_id": "R1"}
        )
        assert "alice: hello" in summary

        ticket = await agent.tools.execute(
            "create_ticket",
            {
                "title": "Fix pipeline",
                "description": "It broke",
                "priority": "high",
                "project_number": "P-00001",
            },
        )
        assert json.loads(ticket)["task_id"] == "T1"

        info = await agent.tools.execute("lookup_info", {"query": "roadmap"})
        assert "doc.md" in info

        # Delegates to the builtin summon_agent.
        await agent.tools.execute(
            "summon_specialist", {"agent_type": "the-general", "room_id": "R1"}
        )

        posted = await agent.tools.execute(
            "post_status_update", {"room_id": "R1", "status": "all green"}
        )
        assert json.loads(posted)["posted"] is True
        await agent.tools.shutdown()

    asyncio.run(run())

    expected = [
        ("GET", "/api/v1/rooms/R1/messages"),
        # create_ticket = post the ticket message, then promote it to a PO task
        ("POST", "/api/v1/rooms/ROOMUUID/messages"),
        (
            "POST",
            "/api/v1/messages/11111111-1111-1111-1111-111111111111/promote-to-po-task",
        ),
        ("POST", "/api/v1/internal/knowledge/search"),
        ("POST", "/api/v1/rooms/R1/invite-brigade-agent"),
        ("POST", "/api/v1/rooms/R1/messages"),
    ]
    assert capture.calls == expected

    for method, path in capture.calls:
        assert path.startswith(STABLE_API_PREFIX + "/"), (method, path)
        assert _matches_backend_route(method, path), (
            f"{method} {path} does not match any backend route template — "
            "if the backend actually serves this route, update "
            "BACKEND_ROUTE_TEMPLATES here AND in "
            "server/tests/test_agent_tool_routes.py"
        )


def test_lookup_info_uses_internal_bearer() -> None:
    """The KB search rides the internal agent surface, not the room token."""
    from agent_runtime.config import AgentSettings
    from triage.agent import TriageAgent

    seen_auth: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_auth.append(request.headers.get("Authorization", ""))
        return httpx.Response(
            200, json={"status": "ok", "notice": None, "results": []}
        )

    async def run() -> None:
        settings = AgentSettings(
            internal_agent_secret="internal-secret",
            livekit_api_secret="lk-secret",
        )
        agent = TriageAgent(settings=settings)
        agent._room_id = "ROOMUUID"
        agent._room_name = "lk-room-1"
        agent.tools._http = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://backend:8400",
            headers={"Authorization": "Bearer per-room-agent-token"},
        )
        agent._register_triage_tools()
        result = await agent.tools.execute("lookup_info", {"query": "q"})
        assert "No results found" in result
        await agent.tools.shutdown()

    asyncio.run(run())
    assert seen_auth == ["Bearer internal-secret"]
