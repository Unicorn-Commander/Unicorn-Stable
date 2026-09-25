"""Cast names and aliases address exactly, and the earliest match wins.

Review 2026-09-25, blocker 1. A one-letter-off leading token and a bare
"magic" alias were sending ordinary sentences to Shox, Grok and Majik.
Those lines go to nobody, or to the co-host, the way they do without the
alias work. A real spelling still reaches the seat, and when two names
both sit in address position the one that starts earlier wins (a tie goes
to the longer match, never to list order).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock

AARON = "aaron_c0cf018d-f9d4-4638-a43b-23914024aad4"

# Everyday lines the review showed landing on a cast member. On origin/main
# each is nobody, or the co-host when one human is talking to a named one.
FALSE_POSITIVES = (
    "show me the rundown",
    "shot list is ready",
    "stocks are down today",
    "shock and awe",
    "grow the channel first",
    "manic monday again",
    "magic unicorn is building this in public",
    "and magic unicorn ships friday",
    "so magic is just practice",
    "That trick was magic.",
)


class CastAddressTests(TestCase):
    def setUp(self) -> None:
        from agent_runtime.floor_store import InMemoryFloorStore, configure_floor_store

        configure_floor_store(InMemoryFloorStore())

    def tearDown(self) -> None:
        from agent_runtime.floor_store import configure_floor_store

        configure_floor_store()

    def _agent(self, *, primary="zen", aliases=None):
        from voice_relay.agent import VoiceRelayAgent

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        agent._activation = "name"
        agent._my_names = {"rook"}
        agent._identity = "agent-claude-code"
        agent._relay_persona = "rook"
        agent._room_name = "stable-rehearsal"
        agent._primary_agent = primary
        # Server json.dumps(stage, sort_keys=True) — Majik before Shox before Zen.
        names = {
            "agent-grok": "Grok",
            "agent-gunny": "Gunny",
            "agent-majik": "Majik Mane",
            "agent-persephone": "Persephone",
            "agent-shox": "Shox",
            "agent-the-general": "The General",
            "agent-zen": "Zen",
        }
        agent._cast = {
            key: SimpleNamespace(display_name=names[key]) for key in sorted(names)
        }
        if aliases:
            agent._cast_aliases = aliases
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

    def _route(self, text: str, *, primary="zen", aliases=None) -> list[str]:
        from agent_runtime.floor_store import InMemoryFloorStore, configure_floor_store

        # One utterance, one floor. A previous line in this test must not
        # stick and make an unaddressed sentence look addressed.
        configure_floor_store(InMemoryFloorStore())
        agent = self._agent(primary=primary, aliases=aliases)
        agent._maybe_persist(AARON, text, ear="stt")
        return self._persisted(agent)

    def test_builtin_aliases_are_shocks_and_the_mane_spellings(self) -> None:
        from voice_relay.agent import BUILTIN_CAST_ALIASES, aliases_for_seat

        self.assertEqual(set(BUILTIN_CAST_ALIASES["shox"]), {"shocks"})
        self.assertEqual(
            set(BUILTIN_CAST_ALIASES["majik"]), {"magic mane", "majik mane"}
        )
        self.assertNotIn("magic", aliases_for_seat("agent-majik"))
        self.assertIn("magic mane", aliases_for_seat("agent-majik"))
        self.assertIn("majik mane", aliases_for_seat("agent-majik"))

    def test_everyday_lines_go_to_the_cohost_or_to_nobody(self) -> None:
        mismatches: list[str] = []
        for text in FALSE_POSITIVES:
            cohost = self._route(text, primary="zen")
            nobody = self._route(text, primary=None)
            if cohost != [f"@zen {text}"]:
                mismatches.append(f"co-host {text!r} -> {cohost!r}")
            if nobody != []:
                mismatches.append(f"nobody {text!r} -> {nobody!r}")
        self.assertEqual(mismatches, [])

    def test_shocks_magic_mane_zen_and_shox_reach_the_named_seat(self) -> None:
        self.assertEqual(
            self._route("shocks what is two plus two"),
            ["@shox shocks what is two plus two"],
        )
        self.assertEqual(
            self._route("Magic Mane, play something"),
            ["@majik Magic Mane, play something"],
        )
        self.assertEqual(
            self._route("majik mane, play something"),
            ["@majik majik mane, play something"],
        )
        self.assertEqual(
            self._route("zen and magic unicorn is live now"),
            ["@zen zen and magic unicorn is live now"],
        )
        self.assertEqual(
            self._route("shox, magic numbers are bad"),
            ["@shox shox, magic numbers are bad"],
        )

    def test_a_one_edit_leading_token_does_not_reach_a_cast_member(self) -> None:
        self.assertEqual(
            self._route("grak, what is two plus two"),
            ["@zen grak, what is two plus two"],
        )
        self.assertEqual(
            self._route("grak, what is two plus two", primary=None),
            [],
        )

    def test_the_earliest_match_wins_and_a_tie_goes_to_the_longer_one(self) -> None:
        # Both names are in address position. Shox is earlier in sorted list
        # order; Zen is earlier in the sentence.
        self.assertEqual(
            self._route("zen, shox what is next"),
            ["@zen zen, shox what is next"],
        )
        # "magic" is a prefix of "magic mane" at the same start. The longer
        # match is Majik, even though Grok owns the shorter alias and is
        # earlier in list order.
        routed = self._route(
            "Magic Mane, play something",
            aliases={"agent-grok": {"magic"}},
        )
        self.assertEqual(routed, ["@majik Magic Mane, play something"])

    def test_a_room_may_add_magic_for_itself(self) -> None:
        routed = self._route(
            "Magic, what's next",
            aliases={"agent-majik": {"magic"}},
        )
        self.assertEqual(routed, ["@majik Magic, what's next"])
        # Mentioned, not addressed: still the co-host, alias or not.
        mentioned = self._route(
            "that trick was magic",
            aliases={"agent-majik": {"magic"}},
        )
        self.assertEqual(mentioned, ["@zen that trick was magic"])
