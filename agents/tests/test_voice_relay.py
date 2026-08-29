"""Voice relay — what it says, and (more importantly) what it refuses to say.

The relay has no brain, so its whole correctness surface is: which packets it
reacts to, and how it turns written chat into spoken words.
"""

from __future__ import annotations

from unittest import TestCase

from voice_relay.agent import (
    DEFAULT_RELAY_PERSONA,
    DEFAULT_SOURCE_USERNAME,
    MAX_SPOKEN_CHARS,
    relay_config_from_metadata,
    should_speak,
    speakable,
)

ROOK = "agent-claude-code"


def _packet(content: str, username: str = ROOK, **message_extra) -> dict:
    message = {
        "id": "11111111-2222-3333-4444-555555555555",
        "content": content,
        "is_deleted": False,
        "sender": {"username": username, "participant_type": "agent"},
    }
    message.update(message_extra)
    return {"type": "new_message", "message": message}


class SpeakableTests(TestCase):
    def test_plain_text_survives_unchanged(self) -> None:
        self.assertEqual(speakable("The deploy is green."), "The deploy is green.")

    def test_code_fence_becomes_a_spoken_marker_not_silence(self) -> None:
        """Dropping code silently makes 'said nothing' and 'pasted 40 lines'
        sound identical to the listener."""
        out = speakable("Here it is:\n```python\nprint('hi')\n```\ndone")
        self.assertIn("code block", out)
        self.assertNotIn("```", out)
        self.assertNotIn("print", out)

    def test_markdown_furniture_is_stripped(self) -> None:
        out = speakable("## Status\n- **all** green\n- `pytest` passed")
        for junk in ("#", "**", "`", "- "):
            self.assertNotIn(junk, out)
        self.assertIn("all green", out)
        self.assertIn("pytest passed", out)

    def test_links_keep_their_words_and_lose_the_url(self) -> None:
        out = speakable("see [the runbook](https://example.com/a/b) for more")
        self.assertIn("the runbook", out)
        self.assertNotIn("example.com", out)

    def test_bare_url_is_not_spelled_out_character_by_character(self) -> None:
        out = speakable("it is at https://stable.magicunicorn.dev/rooms/1")
        self.assertNotIn("magicunicorn", out)
        self.assertIn("(link)", out)

    def test_long_message_is_truncated_and_says_so(self) -> None:
        text = ("This is a full sentence about the deploy. " * 60).strip()
        out = speakable(text)
        self.assertLessEqual(len(out), MAX_SPOKEN_CHARS + 40)
        self.assertIn("the rest is in the chat", out)

    def test_truncation_prefers_a_sentence_boundary(self) -> None:
        body = "Sentence one is here. " * 50
        out = speakable(body)
        head = out.split(" …the rest")[0]
        self.assertTrue(head.endswith("."), head[-40:])

    def test_empty_and_whitespace_produce_nothing(self) -> None:
        self.assertEqual(speakable(""), "")
        self.assertEqual(speakable("   \n  "), "")


class ShouldSpeakTests(TestCase):
    def test_message_from_the_source_is_spoken(self) -> None:
        self.assertEqual(should_speak(_packet("ready"), ROOK), "ready")

    def test_message_from_anyone_else_is_ignored(self) -> None:
        """Including other agents — otherwise Majik answering would come out
        of Rook's mouth as well as his own."""
        self.assertIsNone(should_speak(_packet("hi", username="aaron"), ROOK))
        self.assertIsNone(should_speak(_packet("hi", username="agent-majik"), ROOK))

    def test_deleted_message_is_never_read_aloud(self) -> None:
        self.assertIsNone(should_speak(_packet("oops", is_deleted=True), ROOK))

    def test_other_packet_types_are_ignored(self) -> None:
        for other in ("transcript", "call_occupancy", "room_revoked"):
            self.assertIsNone(should_speak({"type": other, "message": {}}, ROOK))

    def test_malformed_packets_do_not_raise(self) -> None:
        for junk in (None, "string", 42, [], {}, {"type": "new_message"},
                     {"type": "new_message", "message": {"sender": None}}):
            self.assertIsNone(should_speak(junk, ROOK))

    def test_message_that_is_only_markup_says_nothing(self) -> None:
        self.assertIsNone(should_speak(_packet("**  **"), ROOK))


class RelayConfigTests(TestCase):
    def test_defaults_when_metadata_is_absent_or_broken(self) -> None:
        for meta in ("", "not json", "[]", None, {}, 7):
            self.assertEqual(
                relay_config_from_metadata(meta),
                (DEFAULT_SOURCE_USERNAME, DEFAULT_RELAY_PERSONA),
                meta,
            )

    def test_reads_both_keys_from_a_json_string(self) -> None:
        meta = '{"voice_relay_source": "agent-someone", "voice_relay_agent_id": "atlas"}'
        self.assertEqual(relay_config_from_metadata(meta), ("agent-someone", "atlas"))

    def test_accepts_an_already_parsed_dict(self) -> None:
        self.assertEqual(
            relay_config_from_metadata({"voice_relay_source": "agent-x"}),
            ("agent-x", DEFAULT_RELAY_PERSONA),
        )

    def test_blank_values_fall_back_rather_than_binding_to_nothing(self) -> None:
        meta = {"voice_relay_source": "   ", "voice_relay_agent_id": ""}
        self.assertEqual(
            relay_config_from_metadata(meta),
            (DEFAULT_SOURCE_USERNAME, DEFAULT_RELAY_PERSONA),
        )


class VoiceBindingTests(TestCase):
    def test_the_relay_persona_resolves_to_rooks_voice(self) -> None:
        """The relay speaks as Rook, so it must land on Rook's voice — not the
        table's generic default."""
        from plugins.tts import _resolve_kokoro_voice

        self.assertEqual(_resolve_kokoro_voice(DEFAULT_RELAY_PERSONA, None), "am_echo")


class SoleAgentTests(TestCase):
    """The ears only open when nothing else owns the human's words.

    A Brigade voice worker persists the same utterances itself, so two writers
    would double every line the person says — and a doubled question gets
    answered twice.
    """

    @staticmethod
    def _room(identities):
        from types import SimpleNamespace

        return SimpleNamespace(
            remote_participants={
                i: SimpleNamespace(identity=i) for i in identities
            }
        )

    def test_alone_with_the_human_the_ears_open(self) -> None:
        from voice_relay.agent import sole_agent_in_call

        room = self._room(["aaron_1111"])
        self.assertTrue(sole_agent_in_call(room, "agent-claude-code"))

    def test_another_agent_present_closes_the_ears(self) -> None:
        from voice_relay.agent import sole_agent_in_call

        room = self._room(["aaron_1111", "agent-majik"])
        self.assertFalse(sole_agent_in_call(room, "agent-claude-code"))

    def test_our_own_identity_does_not_count_against_us(self) -> None:
        from voice_relay.agent import sole_agent_in_call

        room = self._room(["aaron_1111", "agent-claude-code"])
        self.assertTrue(sole_agent_in_call(room, "agent-claude-code"))

    def test_a_broken_roster_fails_closed(self) -> None:
        """Unable to tell who is here ⇒ do not write. A duplicated question is
        worse than a missed one, because the human sees it answered twice."""
        from types import SimpleNamespace

        from voice_relay.agent import sole_agent_in_call

        broken = SimpleNamespace(remote_participants=None)
        self.assertFalse(sole_agent_in_call(broken, "agent-claude-code"))


class TranscriptIntakeTests(TestCase):
    """What the relay accepts as a human's spoken line."""

    def test_agent_speech_and_interim_frames_are_not_heard(self) -> None:
        from agent_runtime.voice_transcripts import classify_transcript

        interim = {"isFinal": False, "source": "local_mic", "text": "hel"}
        self.assertEqual(classify_transcript(interim)[0], "interim")

        agent_line = {
            "isFinal": True, "source": "agent", "text": "I am Majik",
            "participantId": "agent-majik",
        }
        self.assertEqual(classify_transcript(agent_line)[0], "agent_speaker")

    def test_a_committed_human_line_is_heard(self) -> None:
        from agent_runtime.voice_transcripts import classify_transcript

        verdict, norm = classify_transcript({
            "isFinal": True, "source": "local_mic", "text": "where are we?",
            "participantId": "aaron_1111", "name": "Aaron", "segmentId": "s1",
        })
        self.assertEqual(verdict, "final")
        self.assertEqual(norm["text"], "where are we?")
        self.assertEqual(norm["participant_id"], "aaron_1111")


class RoomHandleTests(TestCase):
    """The relay keeps its own room handle.

    The base class stores the room NAME and id, not the object. Reaching for a
    `self._room` that never existed made every ears drain throw — invisibly,
    because the loop swallows and logs. Only a live call surfaced it, so the
    attribute is pinned here.
    """

    def test_the_agent_declares_a_room_handle_up_front(self) -> None:
        from voice_relay.agent import VoiceRelayAgent

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        self.assertIsNone(agent._lk_room)

    def test_the_ears_never_reach_for_an_attribute_the_base_lacks(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._ears_loop)
        self.assertIn("self._lk_room", source)
        self.assertNotIn("self._room,", source)


class PersisterWiringTests(TestCase):
    """The relay must use the class that can actually write a human turn.

    `transcript_publisher` exports two publishers; only VoiceHistoryPersister
    has persist_user_utterance. Choosing by filename shipped an AttributeError
    that the ears loop caught and logged, so the feature was silently dead.
    """

    def test_it_binds_the_persister_that_owns_the_method(self) -> None:
        from agent_runtime.transcript_publisher import (
            TranscriptPublisher,
            VoiceHistoryPersister,
        )

        self.assertTrue(hasattr(VoiceHistoryPersister, "persist_user_utterance"))
        self.assertFalse(hasattr(TranscriptPublisher, "persist_user_utterance"))

    def test_the_ears_call_a_method_that_exists(self) -> None:
        import inspect

        from agent_runtime.transcript_publisher import VoiceHistoryPersister
        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._ears_loop)
        self.assertIn("persist_user_utterance", source)
        self.assertIn("VoiceHistoryPersister", inspect.getsource(VoiceRelayAgent.build_pipeline))
        # The call shape must match the real signature.
        sig = inspect.signature(VoiceHistoryPersister.persist_user_utterance)
        self.assertEqual(
            [p for p in sig.parameters if p != "self"], ["speaker_identity", "text"]
        )


class PlayoutTimeoutTests(TestCase):
    """Waiting for playout must be bounded.

    The wait serialises speech so two lines never overlap in one voice. It is
    not a guarantee of delivery: a handle that never resolves would hold the
    queue forever and silence every line after it — worse than one overlap.
    """

    def test_the_wait_is_bounded(self) -> None:
        import inspect

        from voice_relay.agent import PLAYOUT_TIMEOUT_S, VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._say)
        self.assertIn("wait_for", source)
        self.assertIn("playout_budget", source)
        self.assertGreater(PLAYOUT_TIMEOUT_S, 0)

    def test_a_timeout_still_counts_the_line_as_spoken(self) -> None:
        """Giving up on the WAIT is not giving up on the audio — the line was
        already handed to the session, so the queue must move on."""
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._say)
        timeout_at = source.index("voice_relay_playout_wait_elapsed")
        spoke_at = source.index("voice_relay_spoke")
        self.assertLess(timeout_at, spoke_at)


class OwnSttTests(TestCase):
    """The relay must not depend on browser captions to hear.

    Stable disables browser captions whenever the caller picks a specific
    microphone — Web Speech cannot follow a chosen input, so rather than
    secretly record the OS default it publishes nothing. That is everyone
    running a real rig, so a caption-only relay is deaf for exactly the people
    most likely to use it.
    """

    def test_it_wires_its_own_stt_and_a_vad(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent.build_pipeline)
        self.assertIn("get_stt_plugin", source)
        self.assertIn("silero", source)
        # And listens to the session's own finals, not only room data.
        self.assertIn("user_input_transcribed", source)

    def test_missing_stt_is_survivable_not_fatal(self) -> None:
        """No ears must still leave a working mouth."""
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent.build_pipeline)
        self.assertIn("relay_stt_unavailable", source)

    def test_the_two_ears_do_not_write_the_same_line_twice(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        own = inspect.getsource(VoiceRelayAgent._on_own_stt)
        browser = inspect.getsource(VoiceRelayAgent._on_transcript)
        self.assertIn("_heard_segments", own)
        self.assertIn("_heard_segments", browser)
        # Both key on the same normalized text, so whichever ear is first wins.
        self.assertIn('f"stt:', own)
        self.assertIn('f"stt:', browser)


class PlayoutBudgetTests(TestCase):
    """The wait is paced by how long the line takes to say.

    The playout handle does not resolve on this deployment — a 22-character
    reply held the queue to the ceiling — so a fixed timeout serialises speech
    at one line per timeout, which is not a conversation.
    """

    def test_a_short_line_waits_seconds_not_a_minute(self) -> None:
        from voice_relay.agent import playout_budget

        self.assertLess(playout_budget("Loud and clear, Aaron."), 10)

    def test_a_long_line_gets_proportionally_longer(self) -> None:
        from voice_relay.agent import playout_budget

        short = playout_budget("yes")
        long = playout_budget("word " * 100)
        self.assertGreater(long, short)

    def test_it_never_exceeds_the_hard_ceiling(self) -> None:
        from voice_relay.agent import PLAYOUT_TIMEOUT_S, playout_budget

        self.assertLessEqual(playout_budget("x" * 100000), PLAYOUT_TIMEOUT_S)

    def test_empty_text_still_yields_a_positive_wait(self) -> None:
        from voice_relay.agent import playout_budget

        self.assertGreater(playout_budget(""), 0)


class SpeakerAttributionTests(TestCase):
    """A heard line needs an attributable speaker or it is dropped silently.

    resolve_human() falls back to the session's linked participant when the STT
    reports no speaker_id — the normal case for a non-diarizing engine. Built
    without that getter, the relay heard every word and wrote nothing, which is
    exactly how it failed in a live call.
    """

    def test_the_persister_is_given_a_linked_participant_getter(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent.build_pipeline)
        self.assertIn("linked_participant_getter", source)
        self.assertIn("room_io", source)

    def test_the_getter_is_tolerant_of_a_session_without_room_io(self) -> None:
        """Reaching through a missing room_io must not raise into the STT
        callback — no attribution is a dropped line, not a dead relay."""
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent.build_pipeline)
        self.assertIn('getattr(session, "room_io", None)', source)
        self.assertIn('getattr(room_io, "linked_participant", None)', source)


class HumanIdentityTests(TestCase):
    """The backend reads a participant UUID off `username_<uuid>` and 400s on
    anything else. The post is fire-and-forget, so a bad shape rejects every
    line in total silence — which is how a live call had Rook hearing every
    word and writing none of them."""

    AARON = "aaron_c0cf018d-f9d4-4638-a43b-23914024aad4"

    def test_a_real_human_identity_is_accepted(self) -> None:
        from voice_relay.agent import human_identity

        self.assertEqual(human_identity(self.AARON), self.AARON)

    def test_an_agent_identity_is_refused(self) -> None:
        from voice_relay.agent import human_identity

        for identity in ("agent-claude-code", "agent-majik", "agent-relay"):
            self.assertIsNone(human_identity(identity), identity)

    def test_shapes_the_backend_would_reject_are_refused_here(self) -> None:
        from voice_relay.agent import human_identity

        for junk in ("", None, "   ", "aaron", "aaron_notauuid", "testhuman"):
            self.assertIsNone(human_identity(junk), junk)

    def test_case_is_tolerated_in_the_uuid(self) -> None:
        from voice_relay.agent import human_identity

        upper = "aaron_C0CF018D-F9D4-4638-A43B-23914024AAD4"
        self.assertEqual(human_identity(upper), upper)


class AttributionFallbackTests(TestCase):
    """Ambiguity must yield nothing rather than a guess — putting Shafen's
    sentence in Aaron's mouth is worse than dropping it."""

    def test_it_prefers_the_stt_speaker_then_linked_then_a_sole_human(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._speaker_identity)
        self.assertIn("speaker_id", source)
        self.assertIn("linked_participant", source)
        self.assertIn("len(humans) == 1", source)

    def test_an_unattributed_line_is_logged_not_silently_dropped(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._on_own_stt)
        self.assertIn("voice_relay_heard_but_unattributed", source)


class TranscriptVersusChatTests(TestCase):
    """Speech goes to the live transcript; only what is said TO the agent
    becomes a chat message.

    Persisting every spoken sentence turned a private call into a wall of chat
    nobody asked for — and it was visible to the other person in the room.
    """

    def test_everything_heard_is_published_as_a_caption(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._on_own_stt)
        caption_at = source.index("_captions")
        gate_at = source.index("_is_for_us")
        # Captions first, unconditionally; the activation rule gates only chat.
        self.assertLess(caption_at, gate_at)

    def test_only_an_addressed_line_is_persisted(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._on_own_stt)
        gate_at = source.index("_is_for_us")
        persist_at = source.index("persist_user_utterance")
        self.assertLess(gate_at, persist_at)

    def test_addressing_uses_position_not_mere_presence(self) -> None:
        from agent_runtime.voice_dispatch import spoken_name_match

        names = {"rook"}
        self.assertTrue(spoken_name_match("rook, what is the status", names))
        self.assertTrue(spoken_name_match("hey rook can you check", names))
        self.assertTrue(spoken_name_match("what do you think, rook?", names))
        # Talking ABOUT it must not put the line in chat.
        self.assertFalse(spoken_name_match("i asked rook about it yesterday", names))

    def test_the_relay_publishes_captions_itself(self) -> None:
        """Browser captions are off whenever a mic is selected, so without
        this the transcript panel is empty on any real rig."""
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent.build_pipeline)
        self.assertIn("TranscriptPublisher", source)


class ActivationModeTests(TestCase):
    """How a room decides a spoken line is for the agent."""

    def test_unknown_or_missing_falls_back_to_addressing_by_name(self) -> None:
        from voice_relay.agent import DEFAULT_ACTIVATION, activation_from_metadata

        for meta in ("", None, {}, "not json", {"voice_relay_activation": "banana"}):
            self.assertEqual(activation_from_metadata(meta), DEFAULT_ACTIVATION, meta)
        self.assertEqual(DEFAULT_ACTIVATION, "name")

    def test_each_supported_mode_is_read(self) -> None:
        from voice_relay.agent import ACTIVATION_MODES, activation_from_metadata

        for mode in ACTIVATION_MODES:
            self.assertEqual(
                activation_from_metadata({"voice_relay_activation": mode}), mode
            )

    def _agent(self, mode: str, gate: bool = False):
        from voice_relay.agent import VoiceRelayAgent

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        agent._activation = mode
        agent._gate_open = gate
        agent._my_names = {"rook"}
        return agent

    def test_name_mode_needs_the_name_in_an_address_position(self) -> None:
        agent = self._agent("name")
        self.assertTrue(agent._is_for_us("rook, what is the status"))
        self.assertFalse(agent._is_for_us("i asked rook about it yesterday"))
        self.assertFalse(agent._is_for_us("what do you think about the deploy"))

    def test_always_mode_takes_everything(self) -> None:
        agent = self._agent("always")
        self.assertTrue(agent._is_for_us("what do you think about the deploy"))

    def test_off_mode_never_writes_to_chat(self) -> None:
        agent = self._agent("off")
        self.assertFalse(agent._is_for_us("rook, are you there"))

    def test_ptt_mode_follows_the_gate_and_ignores_the_name(self) -> None:
        """A held pedal cannot false-trigger the way a spoken name can, which
        is the entire reason a live show would choose it."""
        closed = self._agent("ptt", gate=False)
        self.assertFalse(closed._is_for_us("rook, are you there"))
        open_gate = self._agent("ptt", gate=True)
        self.assertTrue(open_gate._is_for_us("no name spoken at all"))

    def test_the_gate_is_driven_by_a_room_data_frame(self) -> None:
        import inspect

        from voice_relay.agent import VoiceRelayAgent

        source = inspect.getsource(VoiceRelayAgent._on_data)
        self.assertIn("talk_gate", source)
        self.assertIn("_gate_open", source)
