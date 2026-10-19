"""Voice cast + pedal target — one relay, many voices, and a pedal that names
who it is talking to.

E04 (2026-09-01). Before this, a relay spoke for ONE sender in ONE voice, and a
held pedal could only address the relay's own persona. Now the room's
``voice_relay_voices`` map gives every named sender its own Kokoro voice, and
a ``talk_gate`` frame's ``target`` sends the heard line to a named agent.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import MagicMock

from voice_relay.agent import (
    DEFAULT_SOURCE_USERNAME,
    SpokenLine,
    VoiceRelayAgent,
    gate_target,
    relay_voices_from_metadata,
    should_speak,
    should_speak_as,
)

ROOK = DEFAULT_SOURCE_USERNAME
CAST = {"agent-grok": "am_onyx", "agent-flow": "bm_lewis"}


def _packet(content: str, username: str = ROOK, **sender_extra) -> dict:
    sender = {"username": username, "participant_type": "agent"}
    sender.update(sender_extra)
    return {
        "type": "new_message",
        "message": {
            "id": "11111111-2222-3333-4444-555555555555",
            "content": content,
            "is_deleted": False,
            "sender": sender,
        },
    }


def _agent(**overrides) -> VoiceRelayAgent:
    agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
    VoiceRelayAgent.__init__(agent)
    agent._identity = ROOK
    agent._my_names = {"rook"}
    agent._persona_voice = "am_echo"
    for key, value in overrides.items():
        setattr(agent, key, value)
    return agent


class VoicesParserTests(TestCase):
    def test_absent_key_is_exactly_the_legacy_single_source(self) -> None:
        """No key → the one source in the persona's voice. Nothing else."""
        for meta in ("", None, {}, "not json", "[]", 7, {"voice_relay_source": ROOK}):
            self.assertEqual(
                relay_voices_from_metadata(meta, ROOK, "rook"), {ROOK: "am_echo"}, meta
            )

    def test_reads_a_json_object(self) -> None:
        got = relay_voices_from_metadata({"voice_relay_voices": CAST}, ROOK, "rook")
        self.assertEqual(got, {ROOK: "am_echo", **CAST})

    def test_reads_the_json_encoded_string_livekit_carries(self) -> None:
        """LiveKit metadata is a string; the server serialises the dict. Both
        the whole-metadata string and a string-valued key must work."""
        whole = json.dumps({"voice_relay_source": ROOK, "voice_relay_voices": CAST})
        self.assertEqual(
            relay_voices_from_metadata(whole, ROOK, "rook"), {ROOK: "am_echo", **CAST}
        )
        nested = {"voice_relay_voices": json.dumps(CAST)}
        self.assertEqual(
            relay_voices_from_metadata(nested, ROOK, "rook"), {ROOK: "am_echo", **CAST}
        )

    def test_unknown_voice_falls_back_to_the_persona_voice_not_silence(self) -> None:
        meta = {"voice_relay_voices": {"agent-grok": "am_zaphod", "agent-flow": ""}}
        got = relay_voices_from_metadata(meta, ROOK, "rook")
        self.assertEqual(got["agent-grok"], "am_echo")
        self.assertEqual(got["agent-flow"], "am_echo")

    def test_preset_alias_resolves_to_a_served_voice(self) -> None:
        """bm_daniel has been on the box since 2026-10-19 (it used to fall back
        to bm_lewis); the same fallback map the presets use still applies here,
        it is just empty now."""
        meta = {"voice_relay_voices": {"agent-holmes": "bm_daniel"}}
        got = relay_voices_from_metadata(meta, ROOK, "rook")
        self.assertEqual(got["agent-holmes"], "bm_daniel")

    def test_the_source_may_be_recast_by_the_map(self) -> None:
        meta = {"voice_relay_voices": {ROOK: "am_adam"}}
        self.assertEqual(relay_voices_from_metadata(meta, ROOK, "rook"), {ROOK: "am_adam"})

    def test_junk_shapes_never_raise(self) -> None:
        for junk in (
            {"voice_relay_voices": "not json"},
            {"voice_relay_voices": ["am_echo"]},
            {"voice_relay_voices": 42},
            {"voice_relay_voices": {"": "am_echo", 7: "am_puck"}},
        ):
            self.assertEqual(
                relay_voices_from_metadata(junk, ROOK, "rook"), {ROOK: "am_echo"}, junk
            )

    def test_the_persona_voice_follows_the_persona(self) -> None:
        got = relay_voices_from_metadata({}, "agent-majik", "majik")
        self.assertEqual(got, {"agent-majik": "am_puck"})


class ShouldSpeakAsTests(TestCase):
    VOICES = {ROOK: "am_echo", **CAST}

    def test_every_sender_in_the_cast_is_spoken_in_its_own_voice(self) -> None:
        self.assertEqual(
            should_speak_as(_packet("ready"), self.VOICES),
            SpokenLine("am_echo", "ready", ROOK, "Claude Code"),
        )
        line = should_speak_as(_packet("hi", username="agent-grok"), self.VOICES)
        self.assertEqual((line.voice, line.text, line.sender), ("am_onyx", "hi", "agent-grok"))

    def test_the_caption_name_prefers_the_senders_display_name(self) -> None:
        line = should_speak_as(
            _packet("hi", username="agent-grok", display_name="Grok"), self.VOICES
        )
        self.assertEqual(line.name, "Grok")

    def test_anyone_outside_the_cast_is_ignored(self) -> None:
        self.assertIsNone(should_speak_as(_packet("hi", username="aaron"), self.VOICES))
        self.assertIsNone(should_speak_as(_packet("hi", username="agent-majik"), self.VOICES))

    def test_same_refusals_as_the_single_source_form(self) -> None:
        deleted = _packet("oops")
        deleted["message"]["is_deleted"] = True
        self.assertIsNone(should_speak_as(deleted, self.VOICES))
        self.assertIsNone(should_speak_as(_packet("**  **"), self.VOICES))
        for junk in (None, "s", 42, [], {}, {"type": "new_message"}):
            self.assertIsNone(should_speak_as(junk, self.VOICES))

    def test_legacy_should_speak_is_unchanged(self) -> None:
        self.assertEqual(should_speak(_packet("ready"), ROOK), "ready")
        self.assertIsNone(should_speak(_packet("hi", username="agent-grok"), ROOK))


class OnDataCastTests(TestCase):
    @staticmethod
    def _frame(payload: dict) -> SimpleNamespace:
        return SimpleNamespace(data=json.dumps(payload).encode())

    def test_a_relay_built_without_a_map_still_speaks_its_source(self) -> None:
        agent = _agent()
        agent._on_data(self._frame(_packet("ready")))
        self.assertEqual(agent._queue.get_nowait().voice, "am_echo")
        agent._on_data(self._frame(_packet("hi", username="agent-grok")))
        self.assertTrue(agent._queue.empty())

    def test_cast_members_are_queued_with_their_voice(self) -> None:
        agent = _agent(_voices={ROOK: "am_echo", **CAST})
        agent._on_data(self._frame(_packet("hi", username="agent-flow")))
        line = agent._queue.get_nowait()
        self.assertEqual((line.voice, line.sender), ("bm_lewis", "agent-flow"))

    def test_a_relay_config_frame_recasts_live(self) -> None:
        agent = _agent(_activation="name")
        agent._on_data(
            self._frame({"type": "relay_config", "activation": "ptt", "voices": CAST})
        )
        self.assertEqual(agent._activation, "ptt")
        self.assertEqual(agent._voices, {ROOK: "am_echo", **CAST})
        # An empty map clears the cast back to the single source.
        agent._on_data(self._frame({"type": "relay_config", "activation": "ptt", "voices": {}}))
        self.assertEqual(agent._voices, {ROOK: "am_echo"})


def _audio_pub(*, muted: bool = True) -> SimpleNamespace:
    from livekit import rtc

    track = SimpleNamespace(muted=muted, unmute=MagicMock())
    return SimpleNamespace(kind=rtc.TrackKind.KIND_AUDIO, muted=muted, track=track)


def _video_pub(*, muted: bool = True) -> SimpleNamespace:
    from livekit import rtc

    track = SimpleNamespace(muted=muted, unmute=MagicMock())
    return SimpleNamespace(kind=rtc.TrackKind.KIND_VIDEO, muted=muted, track=track)


def _room_with(publications: dict) -> SimpleNamespace:
    participant = SimpleNamespace(track_publications=publications)
    return SimpleNamespace(local_participant=participant)


class UnmuteOwnAudioTests(TestCase):
    """The self-unmute LiveKit forces onto the target: no server path exists
    (``MuteRoomTrackRequest(muted=False)`` is refused — see
    server/app/api/moderation.py), so the relay must do this to itself."""

    def test_unmutes_a_muted_audio_publication(self) -> None:
        pub = _audio_pub(muted=True)
        agent = _agent(_lk_room=_room_with({"TR_mic": pub}))
        self.assertTrue(agent._unmute_own_audio(reason="control"))
        pub.track.unmute.assert_called_once()

    def test_already_unmuted_is_a_noop(self) -> None:
        pub = _audio_pub(muted=False)
        agent = _agent(_lk_room=_room_with({"TR_mic": pub}))
        self.assertFalse(agent._unmute_own_audio(reason="control"))
        pub.track.unmute.assert_not_called()

    def test_video_publication_is_never_touched(self) -> None:
        """A mic mute must not accidentally unmute a stage/face video track."""
        pub = _video_pub(muted=True)
        agent = _agent(_lk_room=_room_with({"TR_stage": pub}))
        self.assertFalse(agent._unmute_own_audio(reason="control"))
        pub.track.unmute.assert_not_called()

    def test_no_room_yet_is_a_noop_not_a_crash(self) -> None:
        agent = _agent(_lk_room=None)
        self.assertFalse(agent._unmute_own_audio(reason="control"))

    def test_a_track_that_refuses_to_unmute_does_not_raise(self) -> None:
        pub = _audio_pub(muted=True)
        pub.track.unmute.side_effect = RuntimeError("ffi gone")
        agent = _agent(_lk_room=_room_with({"TR_mic": pub}))
        self.assertFalse(agent._unmute_own_audio(reason="control"))


class OnDataUnmuteControlTests(TestCase):
    @staticmethod
    def _frame(payload: dict) -> SimpleNamespace:
        return SimpleNamespace(data=json.dumps(payload).encode())

    def test_unmute_action_unmutes_the_track(self) -> None:
        pub = _audio_pub(muted=True)
        agent = _agent(_lk_room=_room_with({"TR_mic": pub}))
        agent._on_data(
            self._frame({"type": "voice_relay_control", "action": "unmute"})
        )
        pub.track.unmute.assert_called_once()

    def test_unknown_action_does_not_raise_or_touch_the_track(self) -> None:
        pub = _audio_pub(muted=True)
        agent = _agent(_lk_room=_room_with({"TR_mic": pub}))
        agent._on_data(
            self._frame({"type": "voice_relay_control", "action": "mute"})
        )
        pub.track.unmute.assert_not_called()

    def test_a_moderation_mute_then_the_control_packet_recovers(self) -> None:
        """End-to-end shape of the recipe: mute leaves the track muted (this
        relay never mutes itself), the control packet is what undoes it."""
        pub = _audio_pub(muted=True)
        agent = _agent(_lk_room=_room_with({"TR_mic": pub}))
        self.assertTrue(pub.track.muted)
        agent._on_data(
            self._frame({"type": "voice_relay_control", "action": "unmute"})
        )
        pub.track.unmute.assert_called_once()


class GateTargetTests(TestCase):
    def test_a_named_agent_is_the_target(self) -> None:
        self.assertEqual(gate_target("agent-grok", "rook", ROOK), "agent-grok")
        self.assertEqual(gate_target("  agent-flow ", "rook", ROOK), "agent-flow")

    def test_the_relay_itself_collapses_to_none(self) -> None:
        for me in ("rook", "Rook", "agent-rook", ROOK, "claude-code"):
            self.assertIsNone(gate_target(me, "rook", ROOK), me)

    def test_junk_is_none(self) -> None:
        for junk in (None, "", "   ", 7, "a", "x" * 65, "grok bot", "@agent-grok"):
            self.assertIsNone(gate_target(junk, "rook", ROOK), junk)


class GateTargetPersistTests(TestCase):
    AARON = "aaron_1111-c0cf018d-f9d4-4638-a43b-23914024aad4"

    @staticmethod
    def _frame(payload: dict) -> SimpleNamespace:
        return SimpleNamespace(data=json.dumps(payload).encode())

    def _ptt_agent(self) -> VoiceRelayAgent:
        return _agent(
            _activation="ptt",
            _publisher=MagicMock(),
            _lk_room=SimpleNamespace(remote_participants={}),
        )

    def test_a_targeted_pedal_persists_the_line_as_a_mention(self) -> None:
        agent = self._ptt_agent()
        agent._on_data(
            self._frame({"type": "talk_gate", "open": True, "by": "pedal", "target": "agent-grok"})
        )
        self.assertTrue(agent._maybe_persist(self.AARON, "what do you think", ear="stt"))
        agent._publisher.persist_user_utterance.assert_called_once_with(
            self.AARON, "@agent-grok what do you think"
        )

    def test_an_untargeted_pedal_is_the_old_behaviour(self) -> None:
        agent = self._ptt_agent()
        agent._on_data(self._frame({"type": "talk_gate", "open": True, "by": "pedal"}))
        agent._maybe_persist(self.AARON, "status?", ear="captions")
        agent._publisher.persist_user_utterance.assert_called_once_with(self.AARON, "status?")

    def test_targeting_the_persona_is_the_old_behaviour_too(self) -> None:
        agent = self._ptt_agent()
        agent._on_data(
            self._frame({"type": "talk_gate", "open": True, "by": "pedal", "target": "rook"})
        )
        self.assertIsNone(agent._gate_target)
        agent._maybe_persist(self.AARON, "status?", ear="stt")
        agent._publisher.persist_user_utterance.assert_called_once_with(self.AARON, "status?")

    def test_the_target_dies_with_the_release(self) -> None:
        """A stale target would send the NEXT press to whoever was named last."""
        agent = self._ptt_agent()
        agent._on_data(
            self._frame({"type": "talk_gate", "open": True, "by": "pedal", "target": "agent-grok"})
        )
        agent._on_data(self._frame({"type": "talk_gate", "open": False, "by": "pedal"}))
        self.assertIsNone(agent._gate_target)
        self.assertFalse(agent._gate_open)
        agent._on_data(self._frame({"type": "talk_gate", "open": True, "by": "pedal"}))
        agent._maybe_persist(self.AARON, "hello", ear="stt")
        agent._publisher.persist_user_utterance.assert_called_once_with(self.AARON, "hello")

    def test_the_conversation_window_is_not_touched_by_a_targeted_line(self) -> None:
        agent = self._ptt_agent()
        agent._gate_open, agent._gate_target = True, "agent-grok"
        agent._maybe_persist(self.AARON, "hello", ear="stt")
        self.assertEqual(agent._window_until, 0.0)


class _FakeSession:
    """Records say() calls; drains any supplied audio so the frames are checked."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list | None]] = []

    def say(self, text, *, audio=None):
        frames = None
        if audio is not None:
            frames = []

            async def _drain():
                async for f in audio:
                    frames.append(f)

            asyncio.ensure_future(_drain())
        self.calls.append((text, frames))
        return SimpleNamespace()


class _FakeStream:
    def __init__(self, frames):
        self._frames = list(frames)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._frames:
            raise StopAsyncIteration
        return SimpleNamespace(frame=self._frames.pop(0))


class UnmuteBeforeSpeakTests(IsolatedAsyncioTestCase):
    """A queued line must not be lost into a muted track — see
    ``VoiceRelayAgent._say``'s defensive unmute."""

    async def test_a_muted_track_is_unmuted_before_the_line_is_said(self) -> None:
        pub = _audio_pub(muted=True)
        agent = _agent(_session=_FakeSession(), _lk_room=_room_with({"TR_mic": pub}))
        await agent._say(SpokenLine("am_echo", "hello", ROOK, "Rook"))
        pub.track.unmute.assert_called_once()
        self.assertEqual(agent._session.calls, [("hello", None)])

    async def test_an_already_unmuted_track_is_left_alone(self) -> None:
        pub = _audio_pub(muted=False)
        agent = _agent(_session=_FakeSession(), _lk_room=_room_with({"TR_mic": pub}))
        await agent._say(SpokenLine("am_echo", "hello", ROOK, "Rook"))
        pub.track.unmute.assert_not_called()


class PerVoiceSayTests(IsolatedAsyncioTestCase):
    async def test_the_persona_voice_uses_the_session_tts_untouched(self) -> None:
        agent = _agent(_session=_FakeSession())
        await agent._say(SpokenLine("am_echo", "hello", ROOK, "Rook"))
        self.assertEqual(agent._session.calls, [("hello", None)])
        self.assertEqual(agent._voice_tts, {})

    async def test_another_voice_is_synthesised_and_fed_as_audio(self) -> None:
        agent = _agent(_session=_FakeSession(), _captions=MagicMock())
        plugin = MagicMock()
        plugin.synthesize.return_value = _FakeStream(["f1", "f2"])
        agent._voice_tts["am_onyx"] = plugin
        await agent._say(SpokenLine("am_onyx", "hi there", "agent-grok", "Grok"))
        await asyncio.sleep(0)
        text, frames = agent._session.calls[0]
        self.assertEqual(text, "hi there")
        self.assertEqual(frames, ["f1", "f2"])
        plugin.synthesize.assert_called_once_with("hi there")
        # The caption names the sender, not the relay.
        agent._captions.publish_agent_final.assert_called_once_with(
            "hi there", name="Grok", participant_id="agent-grok"
        )

    async def test_a_voice_that_yields_nothing_falls_back_to_the_session_voice(self) -> None:
        """Never silent: a failed synthesis is said in the persona's voice."""
        agent = _agent(_session=_FakeSession())
        plugin = MagicMock()
        plugin.synthesize.side_effect = RuntimeError("kokoro down")
        agent._voice_tts["bm_lewis"] = plugin
        await agent._say(SpokenLine("bm_lewis", "still here", "agent-flow", "Flow"))
        self.assertEqual(agent._session.calls, [("still here", None)])

    async def test_a_plain_string_line_still_works(self) -> None:
        """The queue used to carry bare strings; a straggler must not crash the loop."""
        agent = _agent(_session=_FakeSession())
        await agent._say("legacy")
        self.assertEqual(agent._session.calls, [("legacy", None)])

    async def test_per_voice_plugins_are_built_once_with_that_voice(self) -> None:
        from unittest.mock import patch

        agent = _agent()
        with patch("plugins.tts.get_tts_plugin") as build:
            build.return_value = object()
            first = agent._tts_for_voice("am_onyx")
            second = agent._tts_for_voice("am_onyx")
        self.assertIs(first, second)
        build.assert_called_once_with(personality="rook", voice_id="am_onyx")


class ServedVoiceTests(TestCase):
    def test_known_voice_matches_the_measured_served_list(self) -> None:
        from plugins.tts import KOKORO_SERVED_VOICES, known_kokoro_voice

        self.assertEqual(known_kokoro_voice("am_onyx"), "am_onyx")
        self.assertEqual(known_kokoro_voice(" AM_ECHO "), "am_echo")
        self.assertIsNone(known_kokoro_voice("am_zaphod"))
        self.assertIsNone(known_kokoro_voice(None))
        self.assertIn("am_echo", KOKORO_SERVED_VOICES)

    def test_every_room_voice_in_the_show_is_served(self) -> None:
        """Rook, Majik and The General must all resolve to a served id."""
        from plugins.tts import _resolve_kokoro_voice, known_kokoro_voice

        for persona in ("rook", "majik", "the-general"):
            self.assertIsNotNone(known_kokoro_voice(_resolve_kokoro_voice(persona, None)))


class ChunkedSayTests(IsolatedAsyncioTestCase):
    """A long line becomes several say() calls; a human taking the floor
    between chunks drops the rest (2026-09-13 barge-in)."""

    async def test_a_long_persona_line_is_said_in_chunks(self) -> None:
        from voice_relay.agent import SPOKEN_CHUNK_CHARS, chunk_spoken

        agent = _agent(_session=_FakeSession())
        text = " ".join(f"Sentence {i} carries a handful of words." for i in range(25))
        await agent._say(SpokenLine("am_echo", text, ROOK, "Rook"))
        said = [t for t, _ in agent._session.calls]
        self.assertEqual(said, chunk_spoken(text))
        self.assertGreater(len(said), 1)
        self.assertTrue(all(len(t) <= SPOKEN_CHUNK_CHARS for t in said))
        self.assertFalse(agent._speaking)

    async def test_barge_in_drops_the_remaining_chunks(self) -> None:
        agent = _agent(_session=_FakeSession())
        real_say = agent._session.say

        def say_then_interrupt(text, **kw):
            handle = real_say(text, **kw)
            # The human speaks during the first chunk.
            agent._interrupt_speech(speaker="aaron_1", chars=12)
            return handle

        agent._session.say = say_then_interrupt
        text = " ".join(f"Sentence {i} carries a handful of words." for i in range(25))
        await agent._say(SpokenLine("am_echo", text, ROOK, "Rook"))
        self.assertEqual(len(agent._session.calls), 1)
        self.assertFalse(agent._speaking)
        self.assertFalse(agent._barge_in)
        self.assertIsNone(agent._speech_handle)

    async def test_interrupt_calls_the_live_handle(self) -> None:
        agent = _agent(_session=_FakeSession())
        handle = SimpleNamespace(interrupt=lambda: setattr(handle, "hit", True))
        agent._speech_handle = handle
        agent._speaking = True
        agent._interrupt_speech(speaker="aaron_1", chars=5)
        self.assertTrue(getattr(handle, "hit", False))
        self.assertTrue(agent._barge_in)


class EchoBargeInTests(TestCase):
    """Speaker feedback is not a human taking the relay's floor."""

    AARON = "aaron_1111-c0cf018d-f9d4-4638-a43b-23914024aad4"

    def _speaking_agent(self, *, mode: str = "auto"):
        hit = {"value": False}

        def interrupt() -> None:
            hit["value"] = True

        agent = _agent(
            _publisher=MagicMock(),
            _captions=None,
            _lk_room=SimpleNamespace(
                remote_participants={
                    self.AARON: SimpleNamespace(identity=self.AARON),
                }
            ),
        )
        agent._speaking = True
        agent._barge_in_mode = mode
        agent._speech_handle = SimpleNamespace(interrupt=interrupt)
        return agent, hit

    def test_exact_echo_is_dropped_before_it_is_persisted(self) -> None:
        agent, hit = self._speaking_agent()
        agent._remember_spoken("Got it, here's stable and short.")

        agent._on_track_final(
            SimpleNamespace(
                participant_identity=self.AARON,
                participant_name="Aaron",
            ),
            "got it here's stable and short",
        )

        agent._publisher.persist_user_utterance.assert_not_called()
        self.assertFalse(hit["value"])
        self.assertFalse(agent._barge_in)

    def test_echo_after_playout_is_still_not_persisted(self) -> None:
        agent, hit = self._speaking_agent()
        agent._remember_spoken("Got it, here's stable and short.")
        agent._speaking = False

        agent._on_track_final(
            SimpleNamespace(
                participant_identity=self.AARON,
                participant_name="Aaron",
            ),
            "got it here's stable and short",
        )

        agent._publisher.persist_user_utterance.assert_not_called()
        self.assertFalse(hit["value"])

    def test_stt_drifted_echo_is_dropped(self) -> None:
        agent, hit = self._speaking_agent()
        agent._remember_spoken("Got it, here's stable and short.")

        check = agent._barge_check(
            "got it here's stable and shrt",
            speaker=self.AARON,
        )

        self.assertEqual(check.reason, "echo")
        self.assertGreaterEqual(check.score or 0.0, 0.8)
        self.assertFalse(hit["value"])

    def test_short_four_echo_is_not_a_barge_or_persisted_line(self) -> None:
        agent, hit = self._speaking_agent()
        agent._remember_spoken("The answer is four things.")

        agent._on_track_final(
            SimpleNamespace(participant_identity=self.AARON, participant_name="Aaron"),
            "four",
        )

        agent._publisher.persist_user_utterance.assert_not_called()
        self.assertFalse(hit["value"])

    def test_long_nonmatching_speech_still_cuts_the_reply(self) -> None:
        agent, hit = self._speaking_agent()

        agent._on_track_final(
            SimpleNamespace(participant_identity=self.AARON, participant_name="Aaron"),
            "please stop talking about that now",
        )

        self.assertTrue(hit["value"])
        self.assertTrue(agent._barge_in)

    def test_off_mode_never_cuts_a_long_nonmatching_line(self) -> None:
        agent, hit = self._speaking_agent(mode="off")

        agent._on_track_final(
            SimpleNamespace(participant_identity=self.AARON, participant_name="Aaron"),
            "please stop talking about that now",
        )

        self.assertFalse(hit["value"])
        self.assertFalse(agent._barge_in)
