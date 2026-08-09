"""The routes the agent runtime calls must actually exist on this app.

Server-side half of a two-sided regression pin (the agents and server images
cannot import each other, so each side pins its half):

  * agents/tests/test_tool_backend_routes.py executes every builtin + triage
    tool against a capturing transport and asserts the URLs it emits match
    the templates below.
  * THIS test builds the real FastAPI app and asserts those same templates
    are mounted — so a backend route rename/removal fails here instead of
    silently 404ing every agent tool again (the scaffold-era bug: the agent
    runtime spoke unversioned "/api/..." — including endpoints that never
    existed — while everything real is mounted under "/api/v1").

If either table changes, change the other in the same commit.
"""

from __future__ import annotations

import unittest

from fastapi.routing import APIRoute

from app.main import create_app

# (METHOD, route template) called by agents/agent_runtime/* and
# agents/triage/agent.py — keep in lockstep with
# agents/tests/test_tool_backend_routes.py::BACKEND_ROUTE_TEMPLATES.
AGENT_CALLED_ROUTES: list[tuple[str, str]] = [
    # builtin tools (agents/agent_runtime/tools.py)
    ("POST", "/api/v1/rooms/{room_id}/messages"),          # send_message
    ("POST", "/api/v1/rooms"),                             # create_room
    ("POST", "/api/v1/rooms/{room_id}/invite"),            # invite_to_room
    ("POST", "/api/v1/rooms/{room_name}/invite-brigade-agent"),  # summon_agent
    # triage tools (agents/triage/agent.py)
    ("GET", "/api/v1/rooms/{room_id}/messages"),           # summarize_conversation
    ("POST", "/api/v1/messages/{message_id}/promote-to-po-task"),  # create_ticket
    ("POST", "/api/v1/internal/knowledge/search"),         # lookup_info
    # post_status_update posts a room message (covered by send_message's route)
    # other runtime callers (registry / base / brigade_backed / transcripts)
    ("GET", "/api/v1/agents"),                             # registry config load
    ("POST", "/api/v1/internal/agent-events"),             # audit log
    ("POST", "/api/v1/internal/agent-messages"),           # brigade chat post
    ("PATCH", "/api/v1/internal/agent-messages/{message_id}"),  # stream patch
    ("POST", "/api/v1/internal/agent-typing"),             # typing indicator
    ("POST", "/api/v1/internal/voice-user-message"),       # voice transcripts
]


class AgentToolRouteMembershipTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        app = create_app()
        cls.mounted: set[tuple[str, str]] = {
            (method, route.path)
            for route in app.routes
            if isinstance(route, APIRoute)
            for method in route.methods
        }

    def test_every_agent_called_route_is_mounted(self) -> None:
        for method, template in AGENT_CALLED_ROUTES:
            with self.subTest(route=f"{method} {template}"):
                self.assertIn(
                    (method, template),
                    self.mounted,
                    msg=(
                        f"{method} {template} is not mounted on the backend, "
                        "but the agent runtime calls it. Either restore the "
                        "route or update the agent callers AND both route "
                        "tables (this file + agents/tests/"
                        "test_tool_backend_routes.py) in the same commit."
                    ),
                )

    def test_agent_surface_is_versioned(self) -> None:
        """Every template the agents call must live under /api/v1."""
        for _method, template in AGENT_CALLED_ROUTES:
            self.assertTrue(
                template.startswith("/api/v1/"),
                msg=f"agent-called route not under /api/v1: {template}",
            )


if __name__ == "__main__":
    unittest.main()
