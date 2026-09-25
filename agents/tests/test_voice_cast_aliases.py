"""Cast members answer to the names Whisper actually writes down.

Measured 2026-09-24: "Shox, what is two plus two" arrived as "shocks what is
two plus two" and fell through to the co-host. Majik's full name is heard
as "magic mane". Aliases use the same position rule as real names. Bare
"magic" is not built in.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock

AARON = "aaron_c0cf018d-f9d4-4638-a43b-23914024aad4"
SHAFEN = "shafen_d1cf018d-f9d4-4638-a43b-23914024aad4"


class CastAliasParserTests(TestCase):
    def test_a_json_string_and_a_dict_both_read_lowercase(self) -> None:
        from voice_relay.agent import cast_aliases_from_metadata

        raw = {"agent-shox": [" Shocks ", "SHOCKS"], "agent-majik": ["Magic"]}
        self.assertEqual(
            cast_aliases_from_metadata({"voice_relay_cast_aliases": raw}),
            {"agent-shox": {"shocks"}, "agent-majik": {"magic"}},
        )
        wrapped = json.dumps({"voice_relay_cast_aliases": json.dumps(raw)})
        self.assertEqual(
            cast_aliases_from_metadata(wrapped)["agent-shox"],
            {"shocks"},
        )

    def test_junk_is_an_empty_map(self) -> None:
        from voice_relay.agent import cast_aliases_from_metadata

        for junk in (None, "", "not json", [], 7, {"voice_relay_cast_aliases": "nope"}):
            self.assertEqual(cast_aliases_from_metadata(junk), {})

    def test_builtins_cover_the_measured_spellings(self) -> None:
        from voice_relay.agent import aliases_for_seat

        self.assertIn("shocks", aliases_for_seat("agent-shox"))
        self.assertNotIn("magic", aliases_for_seat("agent-majik"))
        for phrase in ("magic mane", "majik mane"):
            self.assertIn(phrase, aliases_for_seat("agent-majik"), phrase)
        # A room entry adds a spelling and does not erase the built-in one.
        names = aliases_for_seat("agent-shox", {"agent-shox": {"shoxx"}})
        self.assertIn("shocks", names)
        self.assertIn("shoxx", names)


class CastAliasRoutingTests(TestCase):
    def setUp(self) -> None:
        from agent_runtime.floor_store import InMemoryFloorStore, configure_floor_store

        configure_floor_store(InMemoryFloorStore())

    def tearDown(self) -> None:
        from agent_runtime.floor_store import configure_floor_store

        configure_floor_store()

    def _agent(self, *, humans=(AARON,), primary="zen"):
        from voice_relay.agent import VoiceRelayAgent

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        agent._activation = "name"
        agent._my_names = {"rook"}
        agent._identity = "agent-claude-code"
        agent._relay_persona = "rook"
        agent._room_name = "stable-rehearsal"
        agent._primary_agent = primary
        agent._cast = {
            "agent-grok": SimpleNamespace(display_name="Grok"),
            "agent-zen": SimpleNamespace(display_name="Zen"),
            "agent-majik": SimpleNamespace(display_name="Majik Mane"),
            "agent-shox": SimpleNamespace(display_name="Shox"),
        }
        identities = [*humans, *agent._cast]
        agent._lk_room = SimpleNamespace(
            remote_participants={i: SimpleNamespace(identity=i, metadata="") for i in identities}
        )
        agent._publisher = MagicMock()
        return agent

    def _persisted(self, agent) -> list[str]:
        return [c.args[1] for c in agent._publisher.persist_user_utterance.call_args_list]

    def test_shocks_reaches_shox_instead_of_the_cohost(self) -> None:
        agent = self._agent()
        self.assertTrue(agent._maybe_persist(AARON, "shocks what is two plus two", ear="stt"))
        self.assertEqual(self._persisted(agent), ["@shox shocks what is two plus two"])

    def test_magic_at_the_start_reaches_majik(self) -> None:
        agent = self._agent()
        # Bare "magic" is the company name, not Majik, unless the room adds it.
        self.assertTrue(agent._maybe_persist(AARON, "Magic, what's next", ear="stt"))
        self.assertEqual(self._persisted(agent), ["@zen Magic, what's next"])
        agent._publisher.persist_user_utterance.reset_mock()
        self.assertTrue(agent._maybe_persist(AARON, "magic mane, play the bed", ear="stt"))
        self.assertEqual(self._persisted(agent), ["@majik magic mane, play the bed"])

    def test_magic_mentioned_in_passing_does_not_reach_majik(self) -> None:
        agent = self._agent()
        self.assertTrue(agent._maybe_persist(AARON, "that trick was magic", ear="stt"))
        self.assertEqual(self._persisted(agent), ["@zen that trick was magic"])

    def test_a_room_alias_extends_the_builtins(self) -> None:
        agent = self._agent()
        agent._cast_aliases = {"agent-shox": {"shoxx"}, "agent-zen": {"then"}}
        self.assertTrue(agent._maybe_persist(AARON, "shoxx, you there", ear="stt"))
        self.assertEqual(self._persisted(agent), ["@shox shoxx, you there"])
        agent._publisher.persist_user_utterance.reset_mock()
        self.assertTrue(agent._maybe_persist(AARON, "shocks what is two plus two", ear="stt"))
        self.assertEqual(self._persisted(agent), ["@shox shocks what is two plus two"])
        agent._publisher.persist_user_utterance.reset_mock()
        self.assertTrue(agent._maybe_persist(AARON, "then, play the bed", ear="stt"))
        self.assertEqual(self._persisted(agent), ["@zen then, play the bed"])

    def test_a_one_edit_leading_token_does_not_reach_the_cast_member(self) -> None:
        agent = self._agent()
        self.assertTrue(agent._maybe_persist(AARON, "grak, what is two plus two", ear="stt"))
        self.assertEqual(self._persisted(agent), ["@zen grak, what is two plus two"])

    def test_a_live_frame_replaces_the_room_aliases(self) -> None:
        agent = self._agent()
        agent._on_data(
            SimpleNamespace(
                data=json.dumps(
                    {
                        "type": "relay_config",
                        "cast_aliases": {"agent-zen": [" Then ", "THEN"]},
                    }
                ).encode()
            )
        )
        self.assertEqual(agent._cast_aliases, {"agent-zen": {"then"}})
        self.assertEqual(agent._activation, "name")
