"""A healthy per-track ear owns its speaker's lines; other ears are held back.

Review round 2 (2026-09-24), blocker A: the 2.5 s pass-through keyed on the
per-track ear's FINALS. The session ear's final lands about 0.45 s before the
per-track final of the same utterance (0.55 s VAD silence against a 1.0 s
gate), so it always saw the previous utterance's final and passed through:
one word of difference between the two ears made two lines and two
dispatches, and a VAD split after the name brought back the measured
three-line failure. The rule is now keyed on the track's own AUDIO: a
session-ear line or a browser caption is held back while that track's energy
gate opened on recent speech, and lands only when the gate stayed shut (a
quiet mic).
"""

from __future__ import annotations

import array
import asyncio
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from agent_runtime.multi_track_stt import HumanAudioTrack, LiveTrackSession

AARON = "aaron_c0cf018d-f9d4-4638-a43b-23914024aad4"
TRACK = HumanAudioTrack(AARON, "Aaron", "TR_1")
W1 = "grok in one sentence what's the point of a rehearsal"
W2 = "grok in one sentence what is the point of a rehearsal"
ROOK_WHOLE = "rook in one sentence what is the point of a rehearsal"
REST = "in one sentence what is the point of a rehearsal"


class _Session:
    """A healthy per-track session whose energy gate did or did not open."""

    def __init__(self, voiced: bool) -> None:
        self.track = SimpleNamespace(participant_identity=AARON)
        self.voiced = voiced

    def is_healthy(self) -> bool:
        return True

    def voiced_within(self, _seconds: float) -> bool:
        return self.voiced


class _Controller:
    def __init__(self, session) -> None:
        self.session = session

    @property
    def active_sids(self) -> set[str]:
        return {"TR_1"}

    def session_for(self, _sid: str):
        return self.session


def _final(text: str) -> SimpleNamespace:
    return SimpleNamespace(transcript=text, is_final=True, speaker_id=AARON)


class SessionEarHoldTests(TestCase):
    def setUp(self) -> None:
        from agent_runtime.floor_store import InMemoryFloorStore, configure_floor_store

        configure_floor_store(InMemoryFloorStore())

    def tearDown(self) -> None:
        from agent_runtime.floor_store import configure_floor_store

        configure_floor_store()

    def _agent(self, *, activation: str = "name", voiced: bool = True):
        from voice_relay.agent import VoiceRelayAgent

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        agent._activation = activation
        agent._window_seconds = 75
        agent._my_names = {"rook"}
        agent._identity = "agent-claude-code"
        agent._relay_persona = "rook"
        agent._room_name = "stable-rehearsal"
        agent._primary_agent = None
        names = {"agent-grok": "Grok", "agent-majik": "Majik Mane", "agent-zen": "Zen"}
        agent._cast = {k: SimpleNamespace(display_name=v) for k, v in sorted(names.items())}
        identities = [AARON, *agent._cast]
        agent._lk_room = SimpleNamespace(
            remote_participants={i: SimpleNamespace(identity=i, metadata="") for i in identities}
        )
        agent._publisher = MagicMock()
        agent._multi_track = _Controller(_Session(voiced))
        self.now = {"t": 100.0}
        agent._clock = lambda: self.now["t"]
        return agent

    def _persisted(self, agent) -> list[str]:
        return [c.args[1] for c in agent._publisher.persist_user_utterance.call_args_list]

    def _play(self, agent, steps) -> int:
        """(time, ear, text) in arrival order. Returns cast dispatch decisions."""
        from agent_runtime import voice_dispatch

        with patch("agent_runtime.voice_dispatch.decide", wraps=voice_dispatch.decide) as decide:
            for at, ear, text in steps:
                self.now["t"] = at
                if ear == "stt":
                    agent._on_own_stt(_final(text))
                else:
                    agent._on_track_final(TRACK, text)
        return decide.call_count

    def test_one_word_of_difference_between_the_ears_is_still_one_line(self) -> None:
        """exp10 A: the session ear's line lands first and differs by a word."""
        agent = self._agent()
        decisions = self._play(agent, [(100.0, "stt", W1), (100.5, "track", W2)])
        self.assertEqual(self._persisted(agent), [f"@grok {W2}"])
        self.assertEqual(decisions, 1)

    def test_a_vad_split_after_the_name_is_still_one_line(self) -> None:
        """exp10 B: the session ear splits at a 0.7 s beat after "grok"."""
        agent = self._agent()
        decisions = self._play(
            agent,
            [(100.0, "stt", "grok"), (101.6, "stt", REST), (102.1, "track", W2)],
        )
        self.assertEqual(self._persisted(agent), [f"@grok {W2}"])
        self.assertEqual(decisions, 1)

    def test_the_persona_path_in_name_mode_is_one_line(self) -> None:
        """exp13, name mode: used to post "rook" and then the whole line."""
        agent = self._agent(activation="name")
        decisions = self._play(
            agent,
            [(100.0, "stt", "rook"), (101.6, "stt", REST), (102.1, "track", ROOK_WHOLE)],
        )
        self.assertEqual(self._persisted(agent), [ROOK_WHOLE])
        self.assertEqual(decisions, 0)  # the persona's own line; no cast decision

    def test_the_persona_path_in_window_mode_is_one_line(self) -> None:
        """exp13, window mode: used to post three turns."""
        agent = self._agent(activation="window")
        decisions = self._play(
            agent,
            [(100.0, "stt", "rook"), (101.6, "stt", REST), (102.1, "track", ROOK_WHOLE)],
        )
        self.assertEqual(self._persisted(agent), [ROOK_WHOLE])
        self.assertEqual(decisions, 0)

    def test_a_quiet_mic_lands_through_the_session_ear_once(self) -> None:
        agent = self._agent(voiced=False)
        decisions = self._play(agent, [(100.0, "stt", W2)])
        self.assertEqual(self._persisted(agent), [f"@grok {W2}"])
        self.assertEqual(decisions, 1)

    def test_the_linked_participant_still_barges_in_while_held_back(self) -> None:
        agent = self._agent()
        agent._speaking = True
        cut: list[str] = []
        agent._interrupt_speech = lambda **kw: cut.append(kw.get("speaker", ""))
        self._play(agent, [(100.0, "stt", W1)])
        self.assertEqual(cut, [AARON])
        self.assertEqual(self._persisted(agent), [])

    def _caption(self, agent, text: str, segment: str) -> None:
        agent._on_transcript(
            {
                "isFinal": True,
                "source": "local_mic",
                "participantId": AARON,
                "name": "Aaron",
                "text": text,
                "segmentId": segment,
            }
        )

    def test_a_caption_is_held_back_while_the_track_heard_the_speech(self) -> None:
        agent = self._agent(voiced=True)
        agent._transcripts = MagicMock()
        self._caption(agent, W1, "seg-1")
        agent._transcripts.ingest.assert_not_called()

    def test_a_caption_lands_when_the_tracks_gate_stayed_shut(self) -> None:
        """Round 2 left captions dropped for any covered speaker, so a quiet
        non-linked mic had no fallback at all."""
        agent = self._agent(voiced=False)
        agent._transcripts = MagicMock()
        self._caption(agent, W1, "seg-1")
        agent._transcripts.ingest.assert_called_once()


def _pcm(amp: int):
    return SimpleNamespace(
        data=array.array("h", [amp] * 160).tobytes(),
        sample_rate=16000,
        samples_per_channel=160,
        num_channels=1,
    )


class RealSessionOrderTests(TestCase):
    """The same rule against a real LiveTrackSession mid-utterance: the
    session ear's final arrives while the track is still inside its one
    second gate."""

    def setUp(self) -> None:
        from agent_runtime.floor_store import InMemoryFloorStore, configure_floor_store

        configure_floor_store(InMemoryFloorStore())

    def tearDown(self) -> None:
        from agent_runtime.floor_store import configure_floor_store

        configure_floor_store()

    def test_the_session_ear_line_that_arrives_first_is_not_a_second_line(self) -> None:
        from agent_runtime import voice_dispatch
        from voice_relay.agent import VoiceRelayAgent

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        agent._activation = "name"
        agent._my_names = {"rook"}
        agent._identity = "agent-claude-code"
        agent._relay_persona = "rook"
        agent._room_name = "stable-rehearsal"
        agent._primary_agent = None
        agent._cast = {"agent-grok": SimpleNamespace(display_name="Grok")}
        agent._lk_room = SimpleNamespace(
            remote_participants={
                i: SimpleNamespace(identity=i, metadata="") for i in (AARON, "agent-grok")
            }
        )
        agent._publisher = MagicMock()

        speech = [_pcm(3000)] * 150
        quiet_before_vad = [_pcm(0)] * 60  # the session ear's VAD fires about here
        gate = {"event": None}

        class Stream:
            def __init__(self, *args, **kwargs):
                pass

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                for frame in speech + quiet_before_vad:
                    yield SimpleNamespace(frame=frame)
                    await asyncio.sleep(0)
                await gate["event"].wait()
                while True:
                    yield SimpleNamespace(frame=_pcm(0))
                    await asyncio.sleep(0)

        class STT:
            async def recognize(self, frames):
                return SimpleNamespace(text=W2)

        import livekit.rtc as rtc

        original = rtc.AudioStream
        rtc.AudioStream = Stream
        decisions: list[int] = []
        try:
            sess = LiveTrackSession(TRACK, object(), STT(), agent._on_track_final)
            agent._multi_track = _Controller(sess)

            async def wait_for(predicate, what):
                loop = asyncio.get_running_loop()
                deadline = loop.time() + 5.0
                while not predicate():
                    if loop.time() >= deadline:
                        raise AssertionError(what)
                    await asyncio.sleep(0.001)

            async def go():
                gate["event"] = asyncio.Event()
                with patch(
                    "agent_runtime.voice_dispatch.decide", wraps=voice_dispatch.decide
                ) as decide:
                    sess.start()
                    await wait_for(
                        lambda: sess._in_speech and sess._quiet_s >= 0.55, "inside the gate"
                    )
                    self.assertTrue(agent._speaker_covered(AARON))
                    agent._on_own_stt(_final(W1))  # lands first, differs by a word
                    self.assertEqual(agent._publisher.persist_user_utterance.call_count, 0)
                    gate["event"].set()
                    await wait_for(
                        lambda: agent._publisher.persist_user_utterance.call_count >= 1,
                        "per-track final",
                    )
                    decisions.append(decide.call_count)
                sess.aclose()
                await asyncio.wait_for(sess._task, timeout=5.0)

            asyncio.run(go())
        finally:
            rtc.AudioStream = original
        persisted = [c.args[1] for c in agent._publisher.persist_user_utterance.call_args_list]
        self.assertEqual(persisted, [f"@grok {W2}"])
        self.assertEqual(decisions, [1])
