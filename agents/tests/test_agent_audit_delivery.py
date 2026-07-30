import asyncio

from agent_runtime.base import StableAgent
from agent_runtime.config import AgentSettings


class FakeResponse:
    status_code = 201


class FakeHttp:
    def __init__(self):
        self.calls = []

    async def post(self, path, **kwargs):
        self.calls.append((path, kwargs))
        return FakeResponse()


def test_agent_events_use_internal_authenticated_audit_surface():
    settings = AgentSettings(
        internal_agent_secret="audit-secret",
        livekit_api_secret="different-livekit-secret",
    )
    agent = StableAgent(settings=settings)
    agent._identity = "agent-test"
    agent._room_id = "room-test"
    fake = FakeHttp()
    agent._http = fake

    asyncio.run(agent._log_agent_event("tool.finished", {"success": True}))

    assert len(fake.calls) == 1
    path, kwargs = fake.calls[0]
    assert path == "/api/v1/internal/agent-events"
    assert kwargs["headers"]["Authorization"] == "Bearer audit-secret"
    assert kwargs["json"]["event"] == "tool.finished"
