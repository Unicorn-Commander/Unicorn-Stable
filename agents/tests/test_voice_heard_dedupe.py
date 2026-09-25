"""Duplicate lines are whole words, and the window depends on the ear.

Review 2026-09-25, minor 8. A letter-level substring was dropping "no"
after "I know that" and keeping "grok in one sentence" after the punctuated
question. Tokens fix both. An exact copy from the other ear is dropped for
8 seconds; the same ear only for 2, so "yes" again at 5 seconds stays.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock

AARON = "aaron_c0cf018d-f9d4-4638-a43b-23914024aad4"
LONG = "Grok, in one sentence, what is the point of a rehearsal?"


class HeardDedupeTests(TestCase):
    def setUp(self) -> None:
        from agent_runtime.floor_store import InMemoryFloorStore, configure_floor_store

        configure_floor_store(InMemoryFloorStore())

    def tearDown(self) -> None:
        from agent_runtime.floor_store import configure_floor_store

        configure_floor_store()

    def _agent(self):
        from voice_relay.agent import VoiceRelayAgent

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        agent._activation = "name"
        agent._my_names = {"rook"}
        agent._identity = "agent-claude-code"
        agent._relay_persona = "rook"
        agent._room_name = "stable-rehearsal"
        agent._primary_agent = "zen"
        agent._cast = {
            "agent-grok": SimpleNamespace(display_name="Grok"),
            "agent-zen": SimpleNamespace(display_name="Zen"),
        }
        identities = [AARON, *agent._cast]
        agent._lk_room = SimpleNamespace(
            remote_participants={
                i: SimpleNamespace(identity=i, metadata="") for i in identities
            }
        )
        agent._publisher = MagicMock()
        return agent

    def _persisted(self, agent) -> list[str]:
        return [c.args[1] for c in agent._publisher.persist_user_utterance.call_args_list]

    def test_words_are_not_letters_and_punctuation_does_not_save_a_fragment(self) -> None:
        from agent_runtime.voice_dispatch import line_subsumes

        self.assertFalse(line_subsumes("I know that", "no"))
        self.assertFalse(line_subsumes("look at this", "ok"))
        self.assertFalse(line_subsumes("this is good", "go"))
        self.assertTrue(line_subsumes("yes please", "yes"))
        self.assertTrue(line_subsumes(LONG, "grok in one sentence"))

        agent = self._agent()
        agent._hear(AARON, "I know that", ear="stt", now=0.0)
        agent._hear(AARON, "No.", ear="stt", now=1.5)
        self.assertEqual(self._persisted(agent), ["@zen I know that", "@zen No."])

        agent = self._agent()
        agent._hear(AARON, LONG, ear="stt", now=0.0)
        agent._hear(AARON, "grok in one sentence", ear="captions", now=0.5)
        self.assertEqual(self._persisted(agent), [f"@grok {LONG}"])

    def test_exact_duplicate_window_depends_on_the_ear(self) -> None:
        agent = self._agent()
        agent._hear(AARON, "yes", ear="stt", now=0.0)
        agent._hear(AARON, "yes", ear="stt", now=5.0)
        self.assertEqual(self._persisted(agent), ["@zen yes", "@zen yes"])

        agent = self._agent()
        agent._hear(AARON, "yes", ear="stt", now=0.0)
        agent._hear(AARON, "Yes.", ear="captions", now=5.0)
        self.assertEqual(self._persisted(agent), ["@zen yes"])

        agent = self._agent()
        agent._hear(AARON, "yes", ear="stt", now=0.0)
        agent._hear(AARON, "yes", ear="captions", now=9.0)
        self.assertEqual(self._persisted(agent), ["@zen yes", "@zen yes"])
