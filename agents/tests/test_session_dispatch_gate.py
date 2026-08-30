"""The dispatch gate over the AgentSession's OWN turn loop.

Voice dispatch v1 gated only the browser-caption fallback path. With a healthy
STT the native session loop replies to every final utterance of its linked
participant and consulted no dispatcher at all — in the live rehearsal Majik
answered a line addressed to Rook, with zero dispatch decisions logged,
because the rules existed and nothing routed this lane through them.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase


def _agent():
    from brigade_backed.agent import _CaptioningAgent

    return _CaptioningAgent(instructions="")


def _msg(text: str) -> SimpleNamespace:
    return SimpleNamespace(text_content=text)


class GateHookTests(IsolatedAsyncioTestCase):
    async def test_a_denied_turn_raises_stop_response(self) -> None:
        from livekit.agents.llm import StopResponse

        agent = _agent()
        agent.set_reply_gate(lambda m: False)
        with self.assertRaises(StopResponse):
            await agent.on_user_turn_completed(SimpleNamespace(), _msg("hi"))

    async def test_an_allowed_turn_proceeds(self) -> None:
        agent = _agent()
        agent.set_reply_gate(lambda m: True)
        await agent.on_user_turn_completed(SimpleNamespace(), _msg("hi"))

    async def test_no_gate_means_the_old_behaviour(self) -> None:
        await _agent().on_user_turn_completed(SimpleNamespace(), _msg("hi"))

    async def test_a_broken_gate_fails_open_not_silent(self) -> None:
        """A bug in the gate must degrade to chatty, never to a co-host that
        cannot speak at all. The deliberate off-switch is the env kill switch."""
        agent = _agent()

        def broken(_msg):
            raise RuntimeError("boom")

        agent.set_reply_gate(broken)
        await agent.on_user_turn_completed(SimpleNamespace(), _msg("hi"))


class GateWiringTests(TestCase):
    def test_both_construction_sites_install_the_gate(self) -> None:
        import inspect

        from brigade_backed.agent import BrigadeBackedAgent

        source = inspect.getsource(BrigadeBackedAgent)
        self.assertGreaterEqual(source.count("set_reply_gate"), 2)

    def test_the_gate_logs_a_decision_with_its_source(self) -> None:
        """The eval set for any future classifier is real logged decisions —
        and the session lane's decisions must be distinguishable from the
        fallback lane's."""
        import inspect

        from brigade_backed.agent import BrigadeBackedAgent

        source = inspect.getsource(BrigadeBackedAgent.build_pipeline)
        self.assertIn('"voice_dispatch_decision"', source)
        self.assertIn('source="session"', source)

    def test_the_floor_is_released_when_the_agent_stops_speaking(self) -> None:
        import inspect

        from brigade_backed.agent import BrigadeBackedAgent

        source = inspect.getsource(BrigadeBackedAgent._wire_session_events)
        self.assertIn("observe_reply_finished", source)
        self.assertIn("agent_state_changed", source)


class GatedHistoryTests(TestCase):
    """A user line becomes chat ONLY when it earns a reply.

    The unconditional user_input_transcribed persister wrote every final
    utterance of the linked human into the room — the same chat-flood the
    relay was cured of, still alive on the Brigade lane, and the source of
    the duplicated "rook say ready please" row in the live rehearsal.
    """

    def test_the_gate_persists_on_allow_and_on_bypass(self) -> None:
        import inspect

        from brigade_backed.agent import BrigadeBackedAgent

        source = inspect.getsource(BrigadeBackedAgent.build_pipeline)
        gate = source[source.index("def _reply_gate"):]
        self.assertIn("_persist_user_line(speaker, text)", gate)
        # Once on the kill-switch bypass, once on decision.respond.
        self.assertGreaterEqual(gate.count("_persist_user_line(speaker, text)"), 2)

    def test_the_unconditional_listener_yields_to_the_gate(self) -> None:
        import inspect

        from brigade_backed.agent import BrigadeBackedAgent

        source = inspect.getsource(BrigadeBackedAgent._wire_session_events)
        self.assertIn('getattr(self, "_reply_gate_fn", None) is None', source)
