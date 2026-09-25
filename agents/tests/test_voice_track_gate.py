"""The per-track ear times silence in real seconds and stays the only boundary.

Review 2026-09-25, blockers 2 and 3, majors 4 and 6, minor 7. These drive the
session loop with 10 ms frames and the relay entry production uses for a
finished track line. They fail on 7366bee: the gate was fifty frames (half
a second of 10 ms audio), a dead session stayed "covered", and closing the
track threw the buffer away.
"""

from __future__ import annotations

import array
import asyncio
import inspect
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock

from agent_runtime.multi_track_stt import HumanAudioTrack, LiveTrackSession

AARON = "aaron_c0cf018d-f9d4-4638-a43b-23914024aad4"
SR = 16000
TEN_MS = 160  # 160 samples at 16 kHz


def _pcm(loud: bool, samples: int = TEN_MS, rate: int = SR):
    amp = 3000 if loud else 0
    return SimpleNamespace(
        data=array.array("h", [amp] * samples).tobytes(),
        sample_rate=rate,
        samples_per_channel=samples,
        num_channels=1,
    )


def _repeat(loud: bool, seconds: float, samples: int = TEN_MS, rate: int = SR):
    n = int(round(seconds / (samples / rate)))
    return [_pcm(loud, samples, rate) for _ in range(n)]


class _ScriptSTT:
    def __init__(self, texts=None, *, fail: bool = False, hang: float = 0.0):
        self.texts = list(texts or [])
        self.fail = fail
        self.hang = hang
        self.calls: list[int] = []
        self.started = 0

    async def recognize(self, frames):
        self.started += 1
        self.calls.append(len(frames))
        if self.hang:
            await asyncio.sleep(self.hang)
        if self.fail:
            raise RuntimeError("amanuensis 404")
        n = len(self.calls)
        if self.texts:
            return SimpleNamespace(text=self.texts.pop(0))
        return SimpleNamespace(text=f"grok question number {n}")


def _run(script, *, stt, on_final, on_onset=None, close_at=None, clock=None):
    import livekit.rtc as rtc

    opened: dict = {}
    pos = clock if clock is not None else {"i": -1}

    class FakeStream:
        def __init__(self, *args, **kwargs):
            opened.update(kwargs)

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            for i, frame in enumerate(script):
                pos["i"] = i
                if close_at is not None and i == close_at:
                    sess.aclose()
                    await asyncio.sleep(0)
                yield SimpleNamespace(frame=frame)
                await asyncio.sleep(0)

        async def aclose(self):
            return None

    original = rtc.AudioStream
    rtc.AudioStream = FakeStream
    sess = None
    try:
        kwargs = {}
        if on_onset is not None:
            kwargs["on_onset"] = on_onset
        sess = LiveTrackSession(
            HumanAudioTrack(AARON, "Aaron", "TR_1"),
            object(),
            stt,
            on_final,
            **kwargs,
        )

        async def go():
            sess.start()
            task = sess._task
            if task is None:
                return
            try:
                await task
            except asyncio.CancelledError:
                pass

        asyncio.run(go())
    finally:
        rtc.AudioStream = original
    return opened, pos, sess


def _deliver(agent, track, text: str) -> None:
    """The call production makes when a per-track final is ready."""
    fn = getattr(agent, "_on_track_final", None)
    if callable(fn):
        fn(track, text)
        return
    kwargs = {"ear": "multi_track"}
    if "partial" in inspect.signature(agent._hear).parameters:
        kwargs["partial"] = False
    agent._hear(track.participant_identity, text, **kwargs)


class TrackGateTests(TestCase):
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

    def test_stream_opens_at_20ms_and_a_short_pause_is_one_line(self) -> None:
        agent = self._agent()
        track = HumanAudioTrack(AARON, "Aaron", "TR_1")
        finals: list[tuple[int, str]] = []
        stt = _ScriptSTT()
        script = (
            _repeat(True, 0.4)
            + _repeat(False, 0.6)
            + _repeat(True, 0.4)
            + _repeat(False, 1.5)
        )

        def on_final(_track, text):
            finals.append((len(finals), text))
            _deliver(agent, track, text)

        opened, _pos, _sess = _run(script, stt=stt, on_final=on_final)
        self.assertEqual(opened.get("frame_size_ms"), 20)
        self.assertEqual(len(finals), 1, finals)
        self.assertEqual(len(stt.calls), 1)
        self.assertEqual(len(self._persisted(agent)), 1)
        self.assertIn("grok question number 1", self._persisted(agent)[0])

    def test_a_real_one_second_pause_splits_and_the_wait_is_not_half_a_second(self) -> None:
        finals: list[int] = []
        # 0.4 s speech, 1.2 s quiet, 0.4 s speech, 1.5 s quiet.
        script = (
            _repeat(True, 0.4)
            + _repeat(False, 1.2)
            + _repeat(True, 0.4)
            + _repeat(False, 1.5)
        )
        speech_frames = len(_repeat(True, 0.4))

        def on_final(_track, _text):
            finals.append(0)  # placeholder, index recorded below

        # Record the frame index from the stream by wrapping on_final through pos.
        indexes: list[int] = []

        def on_final_indexed(_track, _text):
            indexes.append(_index["i"])

        _index = {"i": -1}

        import livekit.rtc as rtc

        opened: dict = {}

        class FakeStream:
            def __init__(self, *args, **kwargs):
                opened.update(kwargs)

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                for i, frame in enumerate(script):
                    _index["i"] = i
                    yield SimpleNamespace(frame=frame)
                    await asyncio.sleep(0)

        original = rtc.AudioStream
        rtc.AudioStream = FakeStream
        try:
            sess = LiveTrackSession(
                HumanAudioTrack(AARON, "Aaron", "TR_1"),
                object(),
                _ScriptSTT(),
                on_final_indexed,
            )

            async def go():
                sess.start()
                await sess._task

            asyncio.run(go())
        finally:
            rtc.AudioStream = original

        self.assertEqual(len(indexes), 2, indexes)
        quiet_s = (indexes[0] - (speech_frames - 1)) * (TEN_MS / SR)
        self.assertGreaterEqual(quiet_s, 0.9)
        self.assertLessEqual(quiet_s, 1.15)

    def test_continuous_speech_emits_at_the_fifteen_second_cap(self) -> None:
        indexes: list[int] = []
        script = _repeat(True, 16.0)

        def on_final(_track, _text):
            indexes.append(_index["i"])

        _index = {"i": -1}
        import livekit.rtc as rtc

        class FakeStream:
            def __init__(self, *args, **kwargs):
                pass

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                for i, frame in enumerate(script):
                    _index["i"] = i
                    yield SimpleNamespace(frame=frame)
                    await asyncio.sleep(0)

        original = rtc.AudioStream
        rtc.AudioStream = FakeStream
        try:
            sess = LiveTrackSession(
                HumanAudioTrack(AARON, "Aaron", "TR_1"),
                object(),
                _ScriptSTT(),
                on_final,
            )

            async def go():
                sess.start()
                await sess._task

            asyncio.run(go())
        finally:
            rtc.AudioStream = original

        self.assertGreaterEqual(len(indexes), 2, indexes)
        first_s = (indexes[0] + 1) * (TEN_MS / SR)
        self.assertGreaterEqual(first_s, 14.5)
        self.assertLessEqual(first_s, 15.5)
        self.assertLess(indexes[0], len(script) - 1)

    def test_a_failed_recognizer_uncovers_the_speaker_and_the_session_ear_saves_the_line(self) -> None:
        from agent_runtime.multi_track_stt import MultiTrackController

        agent = self._agent()
        script = _repeat(True, 0.4) + _repeat(False, 1.2)
        stt = _ScriptSTT(fail=True)
        covered_during: list[bool] = []

        class Dead(_ScriptSTT):
            async def recognize(self, frames):
                covered_during.append(agent._speaker_covered(AARON))
                raise RuntimeError("amanuensis 404")

        def opener(track):
            sess = LiveTrackSession(track, object(), Dead(), lambda *_: None)
            sess.start()
            return sess

        import livekit.rtc as rtc

        class FakeStream:
            def __init__(self, *args, **kwargs):
                pass

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                for frame in script:
                    yield SimpleNamespace(frame=frame)
                    await asyncio.sleep(0)

        original = rtc.AudioStream
        rtc.AudioStream = FakeStream
        try:
            controller = MultiTrackController(on_final=lambda *_: None, opener=opener)

            async def go():
                controller.reconcile(
                    [HumanAudioTrack(AARON, "Aaron", "TR_1")]
                )
                # Let the read, the failure, and one reopen attempt finish.
                await asyncio.sleep(0.3)

            asyncio.run(go())
        finally:
            rtc.AudioStream = original

        agent._multi_track = controller
        self.assertFalse(agent._speaker_covered(AARON))
        agent._on_own_stt(
            SimpleNamespace(
                transcript="grok what time is it", is_final=True, speaker_id=AARON
            )
        )
        self.assertEqual(
            self._persisted(agent),
            ["@grok grok what time is it"],
        )

    def test_a_stream_that_never_opens_does_not_cover_the_speaker(self) -> None:
        from agent_runtime.multi_track_stt import MultiTrackController

        agent = self._agent()

        def opener(track):
            sess = LiveTrackSession(track, object(), _ScriptSTT(), lambda *_: None)
            sess.start()
            return sess

        import livekit.rtc as rtc

        class Boom:
            def __init__(self, *args, **kwargs):
                raise RuntimeError("stream closed")

        original = rtc.AudioStream
        rtc.AudioStream = Boom
        try:
            controller = MultiTrackController(on_final=lambda *_: None, opener=opener)

            async def go():
                controller.reconcile([HumanAudioTrack(AARON, "Aaron", "TR_1")])
                await asyncio.sleep(0.2)

            asyncio.run(go())
        finally:
            rtc.AudioStream = original

        agent._multi_track = controller
        self.assertFalse(agent._speaker_covered(AARON))
        agent._on_own_stt(
            SimpleNamespace(
                transcript="grok what time is it", is_final=True, speaker_id=AARON
            )
        )
        self.assertEqual(self._persisted(agent), ["@grok grok what time is it"])

    def test_closing_just_after_speech_emits_the_buffered_line(self) -> None:
        finals: list[str] = []
        script = _repeat(True, 0.5) + _repeat(False, 2.0)
        # 0.5 s of speech is 50 frames; 0.3 s later is frame index 80.
        close_at = len(_repeat(True, 0.5)) + len(_repeat(False, 0.3))
        _run(
            script,
            stt=_ScriptSTT(texts=["grok goodbye"]),
            on_final=lambda _t, text: finals.append(text),
            close_at=close_at,
        )
        self.assertEqual(finals, ["grok goodbye"])

    def test_a_hanging_recognize_on_close_is_bounded(self) -> None:
        stt = _ScriptSTT(hang=5.0)
        script = _repeat(True, 0.4) + _repeat(False, 2.0)
        close_at = len(_repeat(True, 0.4)) + len(_repeat(False, 0.2))
        import time as _time

        t0 = _time.monotonic()
        _index_holder = {}

        def on_final(_track, text):
            _index_holder["text"] = text

        # Build the session ourselves so the short timeout is in place first.
        import livekit.rtc as rtc

        pos = {"i": -1}

        class FakeStream:
            def __init__(self, *args, **kwargs):
                pass

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                for i, frame in enumerate(script):
                    pos["i"] = i
                    if i == close_at:
                        sess.aclose()
                        await asyncio.sleep(0)
                    yield SimpleNamespace(frame=frame)
                    await asyncio.sleep(0)

        original = rtc.AudioStream
        rtc.AudioStream = FakeStream
        try:
            sess = LiveTrackSession(
                HumanAudioTrack(AARON, "Aaron", "TR_1"),
                object(),
                stt,
                on_final,
            )
            sess._close_timeout = 0.05

            async def go():
                sess.start()
                try:
                    await sess._task
                except asyncio.CancelledError:
                    pass

            asyncio.run(go())
        finally:
            rtc.AudioStream = original
        elapsed = _time.monotonic() - t0
        self.assertGreaterEqual(stt.started, 1)
        self.assertNotIn("text", _index_holder)
        self.assertLess(elapsed, 1.0)

    def test_onset_interrupts_a_speaking_agent_within_about_250ms(self) -> None:
        agent = self._agent()
        agent._speaking = True
        interrupted: list[str] = []
        agent._interrupt_speech = lambda **kw: interrupted.append(kw.get("speaker", ""))
        indexes: list[int] = []
        recognized: list[int] = []
        pos = {"i": -1}
        stt = _ScriptSTT()

        real_recognize = stt.recognize

        async def recognize(frames):
            recognized.append(pos["i"])
            return await real_recognize(frames)

        stt.recognize = recognize

        def on_onset(track):
            indexes.append(pos["i"])
            agent._on_speech_onset(track)

        script = _repeat(True, 0.4)
        try:
            _run(
                script,
                stt=stt,
                on_final=lambda *_: None,
                on_onset=on_onset,
                clock=pos,
            )
        except TypeError:
            self.fail("per-track session does not signal speech onset")
        self.assertTrue(indexes, "no onset")
        onset_s = (indexes[0] + 1) * (TEN_MS / SR)
        self.assertGreaterEqual(onset_s, 0.20)
        self.assertLessEqual(onset_s, 0.30)
        self.assertEqual(interrupted, [AARON])
        if recognized:
            self.assertLess(indexes[0], recognized[0])

    def test_health_is_a_live_task_a_recent_frame_and_a_recognize_that_worked(self) -> None:
        import time as _time

        sess = LiveTrackSession(
            HumanAudioTrack(AARON, "Aaron", "TR_1"),
            object(),
            _ScriptSTT(),
            lambda *_: None,
        )
        sess._task = SimpleNamespace(done=lambda: False)
        sess._last_frame_at = _time.monotonic()
        sess._last_recognize_failed = False
        self.assertTrue(sess.is_healthy())
        sess._last_frame_at = _time.monotonic() - 2.0
        self.assertFalse(sess.is_healthy())
        sess._last_frame_at = _time.monotonic()
        sess._last_recognize_failed = True
        self.assertFalse(sess.is_healthy())
        sess._last_recognize_failed = False
        sess._task = SimpleNamespace(done=lambda: True)
        self.assertFalse(sess.is_healthy())

    def test_a_quiet_mic_still_reaches_chat_through_the_session_ear(self) -> None:
        """Covered, healthy, but the energy gate has produced nothing."""
        agent = self._agent()

        class Healthy:
            track = SimpleNamespace(participant_identity=AARON)

            def is_healthy(self) -> bool:
                return True

        class Controller:
            @property
            def active_sids(self) -> set[str]:
                return {"TR_1"}

            def session_for(self, _sid: str):
                return Healthy()

        agent._multi_track = Controller()
        now = {"t": 1000.0}
        agent._clock = lambda: now["t"]
        agent._on_own_stt(
            SimpleNamespace(
                transcript="grok what time is it", is_final=True, speaker_id=AARON
            )
        )
        self.assertEqual(
            self._persisted(agent),
            ["@grok grok what time is it"],
        )
        # Once the track has produced a line, the session ear stays quiet.
        track = HumanAudioTrack(AARON, "Aaron", "TR_1")
        _deliver(agent, track, "grok what time is it")
        now["t"] = 1001.0
        agent._publisher.persist_user_utterance.reset_mock()
        agent._on_own_stt(
            SimpleNamespace(
                transcript="zen tell me one thing", is_final=True, speaker_id=AARON
            )
        )
        self.assertEqual(self._persisted(agent), [])
