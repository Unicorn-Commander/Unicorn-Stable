"""Voice dispatch v1 — the rule engine and the scenarios it exists for.

The scenario tests are written as the show actually runs: Aaron and Shafen in
a call with majik and the-general resident. Each asserts BOTH who answers and
who stays quiet, because "the right agent replied" and "no other agent also
replied" are different guarantees and only the pair is worth anything.
"""

from __future__ import annotations

import os
from unittest import TestCase
from unittest.mock import patch

from agent_runtime.voice_dispatch import (
    STICKY_WINDOW_S,
    Decision,
    RoomFloor,
    decide,
    dispatch_enabled,
    floor_for,
    forget_room,
    spoken_name_match,
)

MAJIK = {"majik"}
GENERAL = {"the-general", "the general"}
AARON = "aaron_1111"
SHAFEN = "shafen_2222"


def _room() -> RoomFloor:
    return RoomFloor()


def _ask(
    state: RoomFloor,
    *,
    me: str = "majik",
    my_names=MAJIK,
    speaker: str = AARON,
    text: str,
    others: dict[str, set[str]] | None = None,
    humans: int = 2,
    now: float = 1000.0,
    speaker_is_agent: bool = False,
    primary: str | None = None,
) -> Decision:
    return decide(
        state=state,
        me=me,
        my_names=my_names,
        speaker=speaker,
        speaker_is_agent=speaker_is_agent,
        text=text,
        other_agent_names=others if others is not None else {"the-general": GENERAL},
        human_count=humans,
        primary_agent=primary,
        now=now,
    )


class NameMatchingTests(TestCase):
    def test_matches_on_word_boundary_case_insensitively(self) -> None:
        self.assertTrue(spoken_name_match("Majik, what's the status", MAJIK))
        self.assertTrue(spoken_name_match("hey majik", MAJIK))
        self.assertTrue(spoken_name_match("THE GENERAL should know", GENERAL))

    def test_does_not_match_inside_another_word(self) -> None:
        # The failure that would make an agent answer to "magikarp".
        self.assertFalse(spoken_name_match("majiks online is the site", MAJIK))
        self.assertFalse(spoken_name_match("remajik", MAJIK))

    def test_empty_text_matches_nothing(self) -> None:
        self.assertFalse(spoken_name_match("", MAJIK))


class ScenarioTests(TestCase):
    """The six DoD scenarios, in the order the spec lists them."""

    def test_1_named_agent_answers_and_the_other_stays_quiet(self) -> None:
        state = _room()
        mine = _ask(state, text="Majik, what's the status?")
        self.assertTrue(mine.respond)
        self.assertEqual(mine.rule, "addressed_by_name")

        theirs = _ask(
            state,
            me="the-general",
            my_names=GENERAL,
            text="Majik, what's the status?",
            others={"majik": MAJIK},
        )
        self.assertFalse(theirs.respond)
        self.assertEqual(theirs.rule, "addressed_other_agent")
        self.assertEqual(theirs.addressed, "majik")

    def test_2_unnamed_follow_up_from_the_same_speaker_sticks(self) -> None:
        state = _room()
        _ask(state, text="Majik, what's the status?", now=1000.0)
        state.release_floor("majik")  # the first reply finished

        follow = _ask(state, text="and what about the audio?", now=1005.0)
        self.assertTrue(follow.respond)
        self.assertEqual(follow.rule, "sticky_follow_up")

    def test_2b_stickiness_lapses(self) -> None:
        state = _room()
        _ask(state, text="Majik, status?", now=1000.0)
        state.release_floor("majik")
        late = _ask(
            state, text="and the audio?", now=1000.0 + STICKY_WINDOW_S + 1
        )
        self.assertFalse(late.respond)
        self.assertEqual(late.rule, "addressed_to_nobody")

    def test_2c_stickiness_is_per_speaker_not_per_room(self) -> None:
        """Aaron addressing Majik must not make Shafen's next sentence Majik's.

        This is the whole reason the claim is keyed to the speaker — room-wide
        stickiness would swallow the human-to-human layer.
        """
        state = _room()
        _ask(state, speaker=AARON, text="Majik, status?", now=1000.0)
        state.release_floor("majik")
        other_human = _ask(
            state, speaker=SHAFEN, text="I think we should ship it", now=1002.0
        )
        self.assertFalse(other_human.respond)
        self.assertEqual(other_human.rule, "addressed_to_nobody")

    def test_3_humans_talking_to_each_other_dispatch_nobody(self) -> None:
        state = _room()
        for agent, names, others in (
            ("majik", MAJIK, {"the-general": GENERAL}),
            ("the-general", GENERAL, {"majik": MAJIK}),
        ):
            d = _ask(
                state,
                me=agent,
                my_names=names,
                text="so Shafen, I think we should ship it tonight",
                others=others,
            )
            self.assertFalse(d.respond, agent)
            self.assertEqual(d.rule, "addressed_to_nobody")

    def test_4_floor_mutex_stops_a_second_agent_talking_over(self) -> None:
        state = _room()
        first = _ask(state, text="Majik, status?")
        self.assertTrue(first.respond)  # majik holds the floor, still replying

        second = _ask(
            state,
            me="the-general",
            my_names=GENERAL,
            text="the General, thoughts?",
            others={"majik": MAJIK},
        )
        self.assertFalse(second.respond)
        self.assertEqual(second.rule, "floor_busy")

        # ...and once Majik finishes, the General may take the floor.
        state.release_floor("majik")
        retry = _ask(
            state,
            me="the-general",
            my_names=GENERAL,
            text="the General, thoughts?",
            others={"majik": MAJIK},
        )
        self.assertTrue(retry.respond)

    def test_4b_an_abandoned_floor_lease_never_mutes_the_room_forever(self) -> None:
        state = _room()
        _ask(state, text="Majik, status?", now=1000.0)  # majik takes the floor
        # Majik's worker dies without releasing. Two minutes later:
        recovered = _ask(
            state,
            me="the-general",
            my_names=GENERAL,
            text="the General, thoughts?",
            others={"majik": MAJIK},
            now=1000.0 + 121,
        )
        self.assertTrue(recovered.respond)

    def test_5_agent_speech_never_dispatches_another_agent(self) -> None:
        state = _room()
        d = _ask(
            state,
            speaker="agent-the-general",
            speaker_is_agent=True,
            text="Majik, do you agree?",  # even naming us
        )
        self.assertFalse(d.respond)
        self.assertEqual(d.rule, "agent_speech_ignored")

    def test_6_kill_switch_restores_prior_behaviour(self) -> None:
        with patch.dict(os.environ, {"VOICE_DISPATCH_ENABLED": "0"}):
            self.assertFalse(dispatch_enabled())
        with patch.dict(os.environ, {"VOICE_DISPATCH_ENABLED": "off"}):
            self.assertFalse(dispatch_enabled())
        with patch.dict(os.environ, {"VOICE_DISPATCH_ENABLED": "1"}):
            self.assertTrue(dispatch_enabled())
        env = dict(os.environ)
        env.pop("VOICE_DISPATCH_ENABLED", None)
        with patch.dict(os.environ, env, clear=True):
            self.assertTrue(dispatch_enabled())  # unset ⇒ ON


class SoloHumanTests(TestCase):
    def test_one_human_one_agent_answers_unaddressed_speech(self) -> None:
        """Aaron alone recording with one agent: it is a DM, so it answers."""
        state = _room()
        d = _ask(state, text="okay so where are we on the deploy", others={}, humans=1)
        self.assertTrue(d.respond)
        self.assertEqual(d.rule, "solo_human_sole_agent")

    def test_a_second_human_turns_addressing_back_on(self) -> None:
        state = _room()
        d = _ask(state, text="okay so where are we", others={}, humans=2)
        self.assertFalse(d.respond)
        self.assertEqual(d.rule, "addressed_to_nobody")

    def test_solo_human_but_two_agents_still_requires_a_name(self) -> None:
        """One human, two agents: unaddressed speech would pile on."""
        state = _room()
        d = _ask(state, text="where are we on the deploy", humans=1)
        self.assertFalse(d.respond)
        self.assertEqual(d.rule, "addressed_to_nobody")


class EdgeTests(TestCase):
    def test_empty_utterance_is_dropped(self) -> None:
        self.assertEqual(_ask(_room(), text="   ").rule, "empty_utterance")

    def test_room_state_is_shared_per_room_and_forgettable(self) -> None:
        a = floor_for("stable-room-1")
        self.assertIs(a, floor_for("stable-room-1"))
        self.assertIsNot(a, floor_for("stable-room-2"))
        forget_room("stable-room-1")
        self.assertIsNot(a, floor_for("stable-room-1"))
        forget_room("stable-room-1")
        forget_room("stable-room-2")

    def test_re_addressing_repoints_stickiness(self) -> None:
        state = _room()
        _ask(state, text="Majik, status?", now=1000.0)
        state.release_floor("majik")
        # Same speaker now names the other agent — Majik loses the claim.
        mine = _ask(state, text="the General, what do you think?", now=1002.0)
        self.assertFalse(mine.respond)
        self.assertEqual(mine.rule, "addressed_other_agent")
        follow = _ask(state, text="and after that?", now=1004.0)
        self.assertFalse(follow.respond)
        self.assertEqual(follow.rule, "sticky_other_agent")


class AddressPositionTests(TestCase):
    """A name must be USED to address someone, not merely occur in a sentence.

    The case that forced this: the agent id `the-general` occurs verbatim
    inside "that is the general idea", so matching on presence alone would
    dispatch an agent into a sentence that was not about it — the nobody class
    failing in the most ordinary English imaginable.
    """

    def test_a_name_merely_mentioned_does_not_address(self) -> None:
        self.assertFalse(
            spoken_name_match("that is the general idea, roughly", GENERAL)
        )
        self.assertFalse(spoken_name_match("we should ask majik about it", MAJIK))

    def test_the_real_address_forms_all_match(self) -> None:
        for phrase in (
            "Majik, what's the status?",
            "hey majik can you pause it",
            "okay majik, go",
            "what do you think, majik?",
            "so majik — the deploy",
        ):
            self.assertTrue(spoken_name_match(phrase, MAJIK), phrase)
        for phrase in ("the General, thoughts?", "THE GENERAL should know"):
            self.assertTrue(spoken_name_match(phrase, GENERAL), phrase)

    def test_bare_word_without_the_article_still_does_not_address(self) -> None:
        """KNOWN LIMITATION, pinned: `the-general` does not answer to "General".

        Stripping the article would make the needle the bare word "general".
        Position-awareness would still let "General, thoughts?" through — but
        so would "general, that was rough", and the classifier tier is the
        right place to weigh that, not a substring rule.
        """
        self.assertFalse(spoken_name_match("General, thoughts?", GENERAL))


class CoHostTests(TestCase):
    """One human, several agents: the designated co-host answers unaddressed
    speech and the specialists wait to be named — the E03 show format.

    Without a designated agent this case has no good answer: every agent would
    consider itself addressed and the floor mutex would hand the turn to
    whichever worker won the race, which is arbitrary on a recorded show.
    """

    def test_cohost_answers_unaddressed_speech_when_alone_with_aaron(self) -> None:
        state = _room()
        d = _ask(
            state,
            me="majik",
            my_names=MAJIK,
            text="okay so where are we on the deploy",
            humans=1,
            primary="majik",
        )
        self.assertTrue(d.respond)
        self.assertEqual(d.rule, "solo_human_cohost")

    def test_the_other_agent_stays_quiet_for_the_same_utterance(self) -> None:
        state = _room()
        d = _ask(
            state,
            me="the-general",
            my_names=GENERAL,
            others={"majik": MAJIK},
            text="okay so where are we on the deploy",
            humans=1,
            primary="majik",
        )
        self.assertFalse(d.respond)
        self.assertEqual(d.rule, "addressed_to_nobody")

    def test_a_specialist_still_answers_to_its_name(self) -> None:
        state = _room()
        d = _ask(
            state,
            me="the-general",
            my_names=GENERAL,
            others={"majik": MAJIK},
            text="the General, thoughts?",
            humans=1,
            primary="majik",
        )
        self.assertTrue(d.respond)
        self.assertEqual(d.rule, "addressed_by_name")

    def test_a_second_human_silences_the_cohost_too(self) -> None:
        """Two humans talking is the nobody class, co-host included — that is
        the whole reason the nobody class exists."""
        state = _room()
        d = _ask(
            state,
            me="majik",
            my_names=MAJIK,
            text="so Shafen, I think we should ship it",
            humans=2,
            primary="majik",
        )
        self.assertFalse(d.respond)
        self.assertEqual(d.rule, "addressed_to_nobody")

    def test_no_cohost_designated_keeps_everyone_quiet(self) -> None:
        state = _room()
        d = _ask(
            state,
            me="majik",
            my_names=MAJIK,
            text="where are we on the deploy",
            humans=1,
            primary=None,
        )
        self.assertFalse(d.respond)
        self.assertEqual(d.rule, "addressed_to_nobody")

    def test_sole_agent_needs_no_designation(self) -> None:
        state = _room()
        d = _ask(
            state,
            me="majik",
            my_names=MAJIK,
            others={},
            text="where are we on the deploy",
            humans=1,
            primary=None,
        )
        self.assertTrue(d.respond)
        self.assertEqual(d.rule, "solo_human_sole_agent")


class PrimaryAgentResolutionTests(TestCase):
    def test_explicit_key_wins_over_the_last_invited_scalar(self) -> None:
        from types import SimpleNamespace

        from agent_runtime.voice_transcripts import primary_agent_id

        room = SimpleNamespace(
            metadata='{"voice_primary_agent_id": "majik",'
            ' "brigade_agent_id": "the-general"}'
        )
        self.assertEqual(primary_agent_id(room), "majik")

    def test_falls_back_to_the_scalar(self) -> None:
        from types import SimpleNamespace

        from agent_runtime.voice_transcripts import primary_agent_id

        self.assertEqual(
            primary_agent_id(SimpleNamespace(metadata='{"brigade_agent_id": "majik"}')),
            "majik",
        )

    def test_missing_or_malformed_metadata_is_no_cohost_not_a_crash(self) -> None:
        from types import SimpleNamespace

        from agent_runtime.voice_transcripts import primary_agent_id

        for meta in ("", "not json", "[]", '{"voice_primary_agent_id": ""}', None):
            self.assertIsNone(primary_agent_id(SimpleNamespace(metadata=meta)), meta)


class VoicePresetTests(TestCase):
    """Voice assignments that must hold for the Build In Public room.

    Two agents sharing a voice is invisible in a preset table and obvious the
    moment they both speak on camera, so the constraint is asserted rather
    than remembered.
    """

    def test_rook_is_am_echo_under_both_of_its_ids(self) -> None:
        from plugins.tts import KOKORO_VOICE_PRESETS

        self.assertEqual(KOKORO_VOICE_PRESETS["claude-code"], "am_echo")
        self.assertEqual(KOKORO_VOICE_PRESETS["rook"], "am_echo")

    def test_the_e03_room_has_three_distinct_voices(self) -> None:
        from plugins.tts import KOKORO_VOICE_PRESETS

        room = ["claude-code", "majik", "the-general"]
        voices = [KOKORO_VOICE_PRESETS[a] for a in room]
        self.assertEqual(len(set(voices)), len(room), voices)

    def test_no_agent_still_holds_rooks_voice(self) -> None:
        from plugins.tts import KOKORO_VOICE_PRESETS

        others = {
            agent: voice
            for agent, voice in KOKORO_VOICE_PRESETS.items()
            if voice == "am_echo" and agent not in ("claude-code", "rook")
        }
        self.assertEqual(others, {})

    def test_every_preset_resolves_to_a_voice_orator_actually_serves(self) -> None:
        """The 18 voices the Kokoro deployment loads, verified 2026-08-28.

        bm_daniel is in the table and NOT in that list, which is why the
        fallback map exists — resolution, not the raw table, is what must be
        served.
        """
        from plugins.tts import _resolve_kokoro_voice, KOKORO_VOICE_PRESETS

        served = {
            "af", "af_alloy", "af_bella", "af_heart", "af_nicole", "af_nova",
            "af_river", "af_sarah", "af_sky", "am_adam", "am_echo",
            "am_michael", "am_onyx", "am_puck", "bf_emma", "bf_isabella",
            "bm_george", "bm_lewis",
        }
        for agent in KOKORO_VOICE_PRESETS:
            self.assertIn(_resolve_kokoro_voice(agent, None), served, agent)
