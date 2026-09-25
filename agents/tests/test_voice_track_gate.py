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


def _pcm(loud: bool, samples: int = TEN_MS, rate: int = SR, *, amp: int | None = None):
    if amp is None:
        amp = 3000 if loud else 0
    return SimpleNamespace(
        data=array.array("h", [amp] * samples).tobytes(),
        sample_rate=rate,
        samples_per_channel=samples,
        num_channels=1,
    )


async def _until(predicate, *, timeout: float = 5.0, what: str = "condition") -> None:
    """Poll inside the running loop until ``predicate()`` holds. No fixed sleeps:
    a slow runner waits longer, a fast one does not wait at all."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() >= deadline:
            raise AssertionError(f"{what} not reached within {timeout} s")
        await asyncio.sleep(0.001)


def _endless_stream(script, *, tail_loud: bool = False):
    """A FakeStream class that plays ``script`` and then quiet frames until
    the session is closed, like a live mic that stays connected."""

    class FakeStream:
        def __init__(self, *args, **kwargs):
            pass

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            for frame in script:
                yield SimpleNamespace(frame=frame)
                await asyncio.sleep(0)
            while True:
                yield SimpleNamespace(frame=_pcm(tail_loud))
                await asyncio.sleep(0)

    return FakeStream


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


def _run(script, *, stt, on_final, close_at=None, clock=None):
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
        sess = LiveTrackSession(
            HumanAudioTrack(AARON, "Aaron", "TR_1"),
            object(),
            stt,
            on_final,
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
        """While the session is still running: no wall-clock wait, and the
        controller is closed before the loop ends (CI flake on c00e3f4)."""
        from agent_runtime.multi_track_stt import MultiTrackController

        agent = self._agent()
        script = _repeat(True, 0.4) + _repeat(False, 1.2)
        covered_during: list[bool] = []
        opened: list[LiveTrackSession] = []

        class Dead(_ScriptSTT):
            async def recognize(self, frames):
                covered_during.append(agent._speaker_covered(AARON))
                raise RuntimeError("amanuensis 404")

        def opener(track):
            sess = LiveTrackSession(track, object(), Dead(), lambda *_: None)
            sess.start()
            opened.append(sess)
            return sess

        import livekit.rtc as rtc

        original = rtc.AudioStream
        rtc.AudioStream = _endless_stream(script)
        results: dict = {}
        try:
            controller = MultiTrackController(on_final=lambda *_: None, opener=opener)
            agent._multi_track = controller

            async def go():
                controller.reconcile([HumanAudioTrack(AARON, "Aaron", "TR_1")])
                await _until(
                    lambda: bool(covered_during) and not agent._speaker_covered(AARON),
                    what="recognize failure uncovering the speaker",
                )
                # The session is alive and reading: it is the failure, not a
                # finished task, that uncovers the speaker.
                results["alive"] = not opened[0]._task.done()
                agent._on_own_stt(
                    SimpleNamespace(
                        transcript="grok what time is it", is_final=True, speaker_id=AARON
                    )
                )
                await controller.aclose()

            asyncio.run(go())
        finally:
            rtc.AudioStream = original

        self.assertTrue(covered_during[0], "healthy before the failure")
        self.assertTrue(results["alive"])
        self.assertEqual(self._persisted(agent), ["@grok grok what time is it"])
        self.assertEqual(len(opened), 1, "a closed controller reopened a session")

    def test_a_stream_that_never_opens_does_not_cover_the_speaker(self) -> None:
        from agent_runtime.multi_track_stt import REOPEN_BUDGET, MultiTrackController

        agent = self._agent()
        opened: list[LiveTrackSession] = []

        def opener(track):
            sess = LiveTrackSession(track, object(), _ScriptSTT(), lambda *_: None)
            sess.start()
            opened.append(sess)
            return sess

        import livekit.rtc as rtc

        class Boom:
            def __init__(self, *args, **kwargs):
                raise RuntimeError("stream closed")

        original = rtc.AudioStream
        rtc.AudioStream = Boom
        try:
            controller = MultiTrackController(on_final=lambda *_: None, opener=opener)
            agent._multi_track = controller

            async def go():
                controller.reconcile([HumanAudioTrack(AARON, "Aaron", "TR_1")])
                await _until(
                    lambda: len(opened) == 1 + REOPEN_BUDGET
                    and all(s._task.done() for s in opened)
                    and not controller.active_sids,
                    what="reopen budget spent",
                )
                self.assertFalse(agent._speaker_covered(AARON))
                agent._on_own_stt(
                    SimpleNamespace(
                        transcript="grok what time is it", is_final=True, speaker_id=AARON
                    )
                )
                await controller.aclose()

            asyncio.run(go())
        finally:
            rtc.AudioStream = original

        self.assertEqual(len(opened), 1 + REOPEN_BUDGET)
        self.assertEqual(self._persisted(agent), ["@grok grok what time is it"])

    def test_failing_tracks_retry_only_their_own_sid_within_a_budget(self) -> None:
        """exp14: six dead streams used to reopen each other (42 opens per
        track event). Each sid now retries itself, three times a minute."""
        from collections import Counter

        from agent_runtime.multi_track_stt import (
            REOPEN_BUDGET,
            REOPEN_WINDOW_S,
            MultiTrackController,
        )

        opens: Counter = Counter()
        sessions: list[LiveTrackSession] = []
        now = {"t": 1000.0}

        def opener(track):
            opens[track.track_sid] += 1
            sess = LiveTrackSession(track, object(), _ScriptSTT(), lambda *_: None)
            sess.start()
            sessions.append(sess)
            return sess

        import livekit.rtc as rtc

        class Ends:
            """A stream that ends at once, like a track that went away. It
            takes the same reopen path as a stream that fails to open, without
            rendering a traceback per attempt (which made this test slow)."""

            def __init__(self, *args, **kwargs):
                pass

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                return
                yield  # pragma: no cover — makes this an async generator

        tracks = [HumanAudioTrack(f"user{i}_x", f"U{i}", f"TR_{i}") for i in range(6)]
        per_sid = 1 + REOPEN_BUDGET
        original = rtc.AudioStream
        rtc.AudioStream = Ends
        try:
            controller = MultiTrackController(
                on_final=lambda *_: None, opener=opener, clock=lambda: now["t"]
            )

            async def settle(expected_total: int) -> None:
                await _until(
                    lambda: sum(opens.values()) == expected_total
                    and all(s._task.done() for s in sessions)
                    and not controller.active_sids,
                    what=f"{expected_total} opens",
                )
                for _ in range(20):  # nothing further is scheduled
                    await asyncio.sleep(0)

            async def go():
                controller.reconcile(tracks)
                await settle(6 * per_sid)
                self.assertEqual(set(opens.values()), {per_sid}, dict(opens))
                # A new minute: one track event opens each sid again, and
                # each gets its own budget back.
                now["t"] += REOPEN_WINDOW_S + 1
                controller.reconcile(tracks)
                await settle(2 * 6 * per_sid)
                await controller.aclose()

            asyncio.run(go())
        finally:
            rtc.AudioStream = original

        self.assertEqual(set(opens.values()), {2 * per_sid}, dict(opens))

    def test_a_cancelled_or_closed_session_never_reopens(self) -> None:
        from agent_runtime.multi_track_stt import MultiTrackController

        opened: list[LiveTrackSession] = []

        def opener(track):
            sess = LiveTrackSession(track, object(), _ScriptSTT(), lambda *_: None)
            sess.start()
            opened.append(sess)
            return sess

        import livekit.rtc as rtc

        track = HumanAudioTrack(AARON, "Aaron", "TR_1")
        original = rtc.AudioStream
        rtc.AudioStream = _endless_stream([])
        try:
            controller = MultiTrackController(on_final=lambda *_: None, opener=opener)

            async def go():
                # 1. Cancelled from outside (the job's loop shutting down).
                controller.reconcile([track])
                await _until(lambda: opened[0]._last_frame_at is not None, what="first frame")
                opened[0]._task.cancel()
                await _until(lambda: opened[0]._task.done(), what="cancelled task done")
                for _ in range(20):
                    await asyncio.sleep(0)
                self.assertEqual(len(opened), 1)
                self.assertTrue(opened[0].closed)
                # 2. Closed because the track left.
                controller.reconcile([track])
                self.assertEqual(len(opened), 2)
                controller.reconcile([])
                await _until(lambda: opened[1]._task.done(), what="closed task done")
                for _ in range(20):
                    await asyncio.sleep(0)
                self.assertEqual(len(opened), 2)
                # 3. The controller itself closed: track events are ignored.
                controller.reconcile([track])
                self.assertEqual(len(opened), 3)
                await controller.aclose()
                self.assertTrue(opened[2]._task.done())
                controller.reconcile([track])
                for _ in range(20):
                    await asyncio.sleep(0)
                self.assertEqual(len(opened), 3)
                self.assertEqual(controller.active_sids, set())

            asyncio.run(go())
        finally:
            rtc.AudioStream = original

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

        closed_at: dict[str, float] = {}
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
                        closed_at["t"] = _time.monotonic()
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
        # Measured from the close, not from the start of the run: a slow
        # runner spends its time reading frames, not in the bounded flush.
        elapsed = _time.monotonic() - closed_at["t"]
        self.assertGreaterEqual(stt.started, 1)
        self.assertNotIn("text", _index_holder)
        self.assertLess(elapsed, 2.0)

    def test_a_noise_bed_or_desk_clicks_never_interrupt_a_speaking_agent(self) -> None:
        """Raw energy is not a barge-in. A steady -36 dBFS bed (music in the
        room) and a burst of desk clicks used to cut the agent at 0.25 s and
        again after every 15 s cap. Per-track barge-in is a recognized line."""
        agent = self._agent()
        agent._speaking = True
        interrupted: list[dict] = []
        agent._interrupt_speech = lambda **kw: interrupted.append(kw)
        clicks: list = []
        for _ in range(14):
            clicks += _repeat(True, 0.02) + _repeat(False, 0.05)
        bed = [_pcm(True, amp=500) for _ in range(len(_repeat(True, 16.0)))]
        script = bed + clicks + _repeat(False, 1.5)
        # The recognizer finds no words in a bed or in clicks.
        stt = _ScriptSTT(texts=[""] * 10)
        track = HumanAudioTrack(AARON, "Aaron", "TR_1")
        _run(script, stt=stt, on_final=lambda _t, text: agent._on_track_final(track, text))
        self.assertGreaterEqual(len(stt.calls), 2, "the cap and the gate both cut")
        self.assertEqual(interrupted, [])
        self.assertEqual(self._persisted(agent), [])
        self.assertNotIn("on_onset", inspect.signature(LiveTrackSession).parameters)
        self.assertFalse(hasattr(agent, "_on_speech_onset"))

    def test_hanging_up_while_the_last_line_is_recognized_still_posts_it(self) -> None:
        """exp11: the gate cut, recognition in flight, then the track closes
        (someone hangs up 1 to 2.5 s after the last word)."""
        finals: list[str] = []
        release = {"event": None}
        stt = _ScriptSTT(texts=["thanks grok that is a wrap"])
        real_recognize = stt.recognize

        async def held_recognize(frames):
            await release["event"].wait()
            return await real_recognize(frames)

        stt.recognize = held_recognize
        import livekit.rtc as rtc

        original = rtc.AudioStream
        rtc.AudioStream = _endless_stream(_repeat(True, 1.0) + _repeat(False, 1.2))
        try:
            sess = LiveTrackSession(
                HumanAudioTrack(AARON, "Aaron", "TR_1"),
                object(),
                stt,
                lambda _t, text: finals.append(text),
            )

            async def go():
                release["event"] = asyncio.Event()
                sess.start()
                await _until(lambda: sess._inflight is not None, what="recognize in flight")
                sess.aclose()
                release["event"].set()
                await asyncio.wait_for(sess._task, timeout=5.0)

            asyncio.run(go())
        finally:
            rtc.AudioStream = original
        self.assertEqual(finals, ["thanks grok that is a wrap"])
        self.assertTrue(sess.closed)

    def test_a_recognize_hanging_in_flight_at_close_is_bounded(self) -> None:
        import time as _time

        finals: list[str] = []
        stt = _ScriptSTT()

        async def never(frames):
            stt.started += 1
            await asyncio.Event().wait()

        stt.recognize = never
        import livekit.rtc as rtc

        original = rtc.AudioStream
        rtc.AudioStream = _endless_stream(_repeat(True, 0.4) + _repeat(False, 1.2))
        try:
            sess = LiveTrackSession(
                HumanAudioTrack(AARON, "Aaron", "TR_1"),
                object(),
                stt,
                lambda _t, text: finals.append(text),
            )
            sess._close_timeout = 0.05

            async def go():
                sess.start()
                await _until(lambda: sess._inflight is not None, what="recognize in flight")
                t0 = _time.monotonic()
                sess.aclose()
                await asyncio.wait_for(sess._task, timeout=5.0)
                return _time.monotonic() - t0

            elapsed = asyncio.run(go())
        finally:
            rtc.AudioStream = original
        self.assertEqual(stt.started, 1)
        self.assertEqual(finals, [])
        self.assertLess(elapsed, 1.0)

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
        """Covered and healthy, but this track's energy gate stayed shut."""
        agent = self._agent()
        gate = {"voiced": False}

        class Healthy:
            track = SimpleNamespace(participant_identity=AARON)

            def is_healthy(self) -> bool:
                return True

            def voiced_within(self, _seconds: float) -> bool:
                return gate["voiced"]

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
        # When the gate did open on the speech, the per-track ear posts it
        # and the session ear stays quiet.
        gate["voiced"] = True
        now["t"] = 1010.0
        agent._publisher.persist_user_utterance.reset_mock()
        agent._on_own_stt(
            SimpleNamespace(
                transcript="zen tell me one thing", is_final=True, speaker_id=AARON
            )
        )
        self.assertEqual(self._persisted(agent), [])

    def test_voiced_within_follows_the_tracks_own_energy_gate(self) -> None:
        """The hold-back rule is keyed on this track's audio, not its finals."""
        clock = {"t": 0.0}

        def ticking():
            return clock["t"]

        import livekit.rtc as rtc

        speech = _repeat(True, 0.4)
        quiet = _repeat(False, 1.5)
        hold = {"event": None, "parked": False}

        class Stream:
            def __init__(self, *args, **kwargs):
                pass

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                for frame in speech:
                    clock["t"] += TEN_MS / SR
                    yield SimpleNamespace(frame=frame)
                    await asyncio.sleep(0)
                # Park mid-utterance so the check below cannot miss it.
                hold["parked"] = True
                await hold["event"].wait()
                for frame in quiet:
                    clock["t"] += TEN_MS / SR
                    yield SimpleNamespace(frame=frame)
                    await asyncio.sleep(0)

        states: dict[str, bool] = {}
        original = rtc.AudioStream
        rtc.AudioStream = Stream
        try:
            sess = LiveTrackSession(
                HumanAudioTrack(AARON, "Aaron", "TR_1"),
                object(),
                _ScriptSTT(),
                lambda *_: None,
                clock=ticking,
            )

            async def go():
                hold["event"] = asyncio.Event()
                sess.start()
                await _until(lambda: hold["parked"], what="speech buffered")
                states["in_speech"] = sess._in_speech and sess.voiced_within(0.0)
                hold["event"].set()
                await asyncio.wait_for(sess._task, timeout=5.0)

            asyncio.run(go())
        finally:
            rtc.AudioStream = original
        self.assertTrue(states["in_speech"])
        last_voiced = sess._last_voiced_at
        self.assertAlmostEqual(last_voiced, 0.40, places=2)
        self.assertTrue(sess.voiced_within(3.0, now=last_voiced + 2.9))
        self.assertFalse(sess.voiced_within(3.0, now=last_voiced + 3.1))
        quiet = LiveTrackSession(
            HumanAudioTrack(AARON, "Aaron", "TR_2"), object(), _ScriptSTT(), lambda *_: None
        )
        self.assertFalse(quiet.voiced_within(3.0, now=1.0))
