"""One spoken utterance is one chat line and one dispatch.

Measured 2026-09-24: "Grok, in one sentence, what is the point of a rehearsal?"
was persisted four times — three per-track partial finals and the session
ear's copy of the whole sentence. The dedupe key was the exact text, so the
fragments slipped through.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from agent_runtime.multi_track_stt import (
    UTTERANCE_SILENCE_GATE_FRAMES,
    UTTERANCE_SILENCE_GATE_S,
    LiveTrackSession,
)
from agent_runtime.voice_dispatch import join_partial_finals, line_subsumes

AARON = "aaron_c0cf018d-f9d4-4638-a43b-23914024aad4"
SHAFEN = "shafen_d1cf018d-f9d4-4638-a43b-23914024aad4"
FRAGMENTS = (
    "grok",
    "in one sentence",
    "what is the point of a rehearsal",
)
WHOLE = "grok in one sentence what is the point of a rehearsal"


def _covering(*speakers: str):
    """A multi-track controller that already has these humans' mics open."""

    class _Controller:
        @property
        def active_sids(self) -> set[str]:
            return set(speakers)

        def session_for(self, sid: str):
            return SimpleNamespace(track=SimpleNamespace(participant_identity=sid))

    return _Controller()


class PartialFinalTests(TestCase):
    def test_the_silence_gate_is_one_second(self) -> None:
        self.assertEqual(UTTERANCE_SILENCE_GATE_S, 1.0)
        self.assertLessEqual(UTTERANCE_SILENCE_GATE_S, 1.0)
        self.assertEqual(UTTERANCE_SILENCE_GATE_FRAMES, 50)
        source = inspect.getsource(LiveTrackSession._run)
        self.assertIn("UTTERANCE_SILENCE_GATE_FRAMES", source)
        self.assertIn("join_partial_finals", inspect.getsource(LiveTrackSession._emit_pending))

    def test_the_measured_fragments_join_into_the_sentence(self) -> None:
        self.assertEqual(join_partial_finals(list(FRAGMENTS)), WHOLE)

    def test_a_cumulative_hypothesis_does_not_stutter(self) -> None:
        self.assertEqual(
            join_partial_finals(["grok", "grok in one sentence", WHOLE]),
            WHOLE,
        )

    def test_a_shorter_echo_does_not_replace_the_longer_line(self) -> None:
        self.assertTrue(line_subsumes(WHOLE, "grok"))
        self.assertTrue(line_subsumes(WHOLE, "in one sentence"))
        self.assertEqual(join_partial_finals([WHOLE, "grok"]), WHOLE)


class OneUtteranceTests(TestCase):
    def setUp(self) -> None:
        from agent_runtime.floor_store import InMemoryFloorStore, configure_floor_store

        configure_floor_store(InMemoryFloorStore())

    def tearDown(self) -> None:
        from agent_runtime.floor_store import configure_floor_store

        configure_floor_store()

    def _agent(self, *, humans=(AARON,), primary=None, activation="name"):
        from voice_relay.agent import VoiceRelayAgent

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        agent._activation = activation
        agent._my_names = {"rook"}
        agent._identity = "agent-claude-code"
        agent._relay_persona = "rook"
        agent._room_name = "stable-rehearsal"
        agent._primary_agent = primary
        agent._cast = {
            "agent-grok": SimpleNamespace(display_name="Grok"),
            "agent-zen": SimpleNamespace(display_name="Zen"),
            "agent-majik": SimpleNamespace(display_name="Majik Mane"),
        }
        identities = [*humans, "agent-grok", "agent-zen", "agent-majik"]
        agent._lk_room = SimpleNamespace(
            remote_participants={i: SimpleNamespace(identity=i, metadata="") for i in identities}
        )
        agent._publisher = MagicMock()
        return agent

    def _persisted(self, agent) -> list[str]:
        return [c.args[1] for c in agent._publisher.persist_user_utterance.call_args_list]

    def test_four_lines_from_the_two_ears_are_one_line_and_one_dispatch(self) -> None:
        from agent_runtime import voice_dispatch

        agent = self._agent()
        agent._multi_track = _covering(AARON)
        t = 1000.0
        with patch("agent_runtime.voice_dispatch.decide", wraps=voice_dispatch.decide) as decide:
            for piece in FRAGMENTS:
                self.assertFalse(agent._hear(AARON, piece, ear="multi_track", now=t))
                t += 0.3
            # The session ear heard the same speech. This speaker's track is
            # covered, so that copy must not persist or dispatch.
            self.assertFalse(agent._hear(AARON, WHOLE, ear="stt", now=t))
            self.assertEqual(self._persisted(agent), [])
            self.assertEqual(decide.call_count, 0)
            self.assertTrue(agent._flush_heard(now=t + UTTERANCE_SILENCE_GATE_S))
        self.assertEqual(self._persisted(agent), [f"@grok {WHOLE}"])
        self.assertEqual(decide.call_count, 1)
        self.assertTrue(agent._publisher.persist_user_utterance.call_args.kwargs.get("reply"))

    def test_the_longest_line_wins_when_the_session_ear_is_not_covered(self) -> None:
        """Belt: a fragment that is contained in a longer line within the
        window is not its own chat line."""
        agent = self._agent()
        t = 1000.0
        for piece in FRAGMENTS:
            agent._hear(AARON, piece, ear="multi_track", now=t)
            t += 0.3
        self.assertTrue(agent._hear(AARON, WHOLE, ear="stt", now=t))
        self.assertEqual(self._persisted(agent), [f"@grok {WHOLE}"])
        self.assertFalse(agent._flush_heard(now=t + UTTERANCE_SILENCE_GATE_S))
        self.assertEqual(len(self._persisted(agent)), 1)

    def test_the_persona_path_collapses_the_same_way(self) -> None:
        from agent_runtime import voice_dispatch

        agent = self._agent()
        agent._multi_track = _covering(AARON)
        pieces = ("rook", "in one sentence", "what is the point of a rehearsal")
        whole = "rook in one sentence what is the point of a rehearsal"
        t = 1000.0
        with patch("agent_runtime.voice_dispatch.decide", wraps=voice_dispatch.decide) as decide:
            for piece in pieces:
                agent._hear(AARON, piece, ear="multi_track", now=t)
                t += 0.3
            self.assertFalse(agent._hear(AARON, whole, ear="stt", now=t))
            self.assertTrue(agent._flush_heard(now=t + UTTERANCE_SILENCE_GATE_S))
        self.assertEqual(self._persisted(agent), [whole])
        self.assertFalse(agent._publisher.persist_user_utterance.call_args.kwargs.get("reply", False))
        self.assertEqual(decide.call_count, 0)

    def test_a_second_utterance_after_the_gate_is_its_own_line(self) -> None:
        agent = self._agent()
        agent._hear(AARON, WHOLE, ear="multi_track", now=1000.0)
        self.assertTrue(agent._flush_heard(now=1000.0 + UTTERANCE_SILENCE_GATE_S))
        agent._hear(AARON, "and why does that matter live", ear="multi_track", now=1005.0)
        self.assertTrue(agent._flush_heard(now=1005.0 + UTTERANCE_SILENCE_GATE_S))
        persisted = self._persisted(agent)
        self.assertEqual(len(persisted), 2)
        self.assertIn(WHOLE, persisted[0])
        self.assertIn("why does that matter", persisted[1])
        self.assertNotIn(WHOLE, persisted[1])

    def test_two_speakers_are_never_merged(self) -> None:
        agent = self._agent(humans=(AARON, SHAFEN))
        agent._hear(AARON, "grok what time is it", ear="multi_track", now=1000.0)
        agent._hear(SHAFEN, "zen tell me one thing", ear="multi_track", now=1000.2)
        self.assertTrue(agent._flush_heard(now=1000.2 + UTTERANCE_SILENCE_GATE_S))
        persisted = self._persisted(agent)
        self.assertEqual(
            persisted,
            ["@grok grok what time is it", "@zen zen tell me one thing"],
        )

    def test_a_repeated_yes_five_seconds_later_is_kept(self) -> None:
        agent = self._agent(activation="always", humans=(AARON,))
        # No other worker in the call, so always-mode is allowed to persist.
        agent._lk_room = SimpleNamespace(
            remote_participants={AARON: SimpleNamespace(identity=AARON, metadata="")}
        )
        now = {"t": 0.0}
        agent._clock = lambda: now["t"]

        def _final() -> SimpleNamespace:
            return SimpleNamespace(transcript="yes", is_final=True, speaker_id=AARON)

        agent._on_own_stt(_final())
        now["t"] = 1.0
        agent._on_own_stt(_final())
        self.assertEqual(self._persisted(agent), ["yes"])
        now["t"] = 5.0
        agent._on_own_stt(_final())
        self.assertEqual(self._persisted(agent), ["yes", "yes"])

    def test_a_browser_caption_does_not_swallow_the_track_final(self) -> None:
        """The caption packet used to claim the text key before anyone
        persisted, so the per-track final of the same words was dropped."""
        agent = self._agent()
        agent._multi_track = _covering(AARON)
        agent._transcripts = MagicMock()
        agent._on_transcript(
            {
                "isFinal": True,
                "source": "local_mic",
                "participantId": AARON,
                "name": "Aaron",
                "text": WHOLE,
                "segmentId": "seg-1",
            }
        )
        key = f"stt:{WHOLE}"
        self.assertFalse(agent._heard_recently(key))
        self.assertTrue(agent._hear(AARON, WHOLE, ear="multi_track", partial=False))
        self.assertEqual(self._persisted(agent), [f"@grok {WHOLE}"])

    def test_a_covered_speaker_session_line_does_not_dispatch_on_its_own(self) -> None:
        agent = self._agent()
        agent._multi_track = _covering(AARON)
        ev = SimpleNamespace(transcript=WHOLE, is_final=True, speaker_id=AARON)
        agent._on_own_stt(ev)
        agent._publisher.persist_user_utterance.assert_not_called()
