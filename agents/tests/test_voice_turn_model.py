"""Voice turn model — the four scenarios in the north-star spec §5.

1. Two humans on one shared mic, talking to each other → no agent reply.
2. A named agent wins.
3. An unnamed follow-up from the same speaker sticks.
4. The floor mutex holds across two FloorStore clients.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase

from agent_runtime.floor_store import InMemoryFloorStore, RedisFloorStore
from agent_runtime.voice_dispatch import (
    RoomFloor,
    decide,
    set_decision_recorder,
)
from agent_runtime.voice_transcripts import any_shared_mic, call_roster, primary_agent_id

MAJIK = {"majik"}
GENERAL = {"the-general", "the general"}
AARON = "aaron_11111111-1111-1111-1111-111111111111"


def _ask(**kwargs):
    params = dict(
        me="majik",
        my_names=MAJIK,
        speaker=AARON,
        speaker_is_agent=False,
        other_agent_names={"the-general": GENERAL},
        human_count=2,
        now=1000.0,
        room="show",
    )
    params.update(kwargs)
    if "others" in params:
        params["other_agent_names"] = params.pop("others")
    if params.get("state", "missing") is None and "store" in params:
        params.pop("state")
    elif "state" not in params and "store" not in params:
        params["state"] = RoomFloor()
    return decide(**params)


class SpecSection5Tests(TestCase):
    def test_1_shared_mic_humans_get_no_agent_reply(self) -> None:
        """One device, human_count still 1, but the shared-mic flag holds.

        The solo-human exception is what used to answer this. It must not.
        """
        state = RoomFloor()
        recorded: list[dict] = []
        set_decision_recorder(recorded.append)
        try:
            for agent, names, others in (
                ("majik", MAJIK, {"the-general": GENERAL}),
                ("the-general", GENERAL, {"majik": MAJIK}),
            ):
                decision = _ask(
                    state=state,
                    me=agent,
                    my_names=names,
                    text="so what do you think, should we ship it tonight",
                    others=others,
                    human_count=1,
                    shared_mic=True,
                    primary_agent=agent,
                )
                self.assertFalse(decision.respond, agent)
                self.assertEqual(decision.rule, "addressed_to_nobody")
        finally:
            set_decision_recorder(None)
        self.assertGreaterEqual(len(recorded), 2)
        self.assertTrue(all(row["shared_mic"] is True for row in recorded))
        self.assertTrue(all(row["human_count"] == 1 for row in recorded))
        self.assertTrue(all(row["winner"] is None for row in recorded))
        self.assertNotIn("text", recorded[0])
        self.assertEqual(len(recorded[0]["text_hash"]), 16)

    def test_1b_roster_counts_a_shared_mic_as_two_humans(self) -> None:
        human = SimpleNamespace(
            identity=AARON,
            name="Aaron",
            metadata='{"shared_mic": true}',
        )
        room = SimpleNamespace(remote_participants={"h": human})
        _others, humans = call_roster(room, "agent-majik")
        self.assertGreaterEqual(humans, 2)
        self.assertTrue(any_shared_mic(room))

    def test_1c_a_single_human_without_the_flag_is_still_one(self) -> None:
        human = SimpleNamespace(identity=AARON, name="Aaron", metadata="{}")
        room = SimpleNamespace(remote_participants={"h": human})
        _others, humans = call_roster(room, "agent-majik")
        self.assertEqual(humans, 1)
        self.assertFalse(any_shared_mic(room))

    def test_2_named_agent_wins_and_the_other_stays_quiet(self) -> None:
        state = RoomFloor()
        mine = _ask(state=state, text="Majik, what's the status?")
        self.assertTrue(mine.respond)
        self.assertEqual(mine.rule, "addressed_by_name")
        theirs = _ask(
            state=state,
            me="the-general",
            my_names=GENERAL,
            text="Majik, what's the status?",
            others={"majik": MAJIK},
        )
        self.assertFalse(theirs.respond)
        self.assertEqual(theirs.rule, "addressed_other_agent")
        self.assertEqual(theirs.addressed, "majik")

    def test_2b_a_name_still_wins_on_a_shared_mic(self) -> None:
        decision = _ask(
            text="Majik, what's the status?",
            human_count=1,
            shared_mic=True,
        )
        self.assertTrue(decision.respond)
        self.assertEqual(decision.rule, "addressed_by_name")

    def test_3_sticky_follow_up(self) -> None:
        state = RoomFloor()
        _ask(state=state, text="Majik, what's the status?", now=1000.0)
        state.release_floor("majik")
        follow = _ask(state=state, text="and what about the audio?", now=1005.0)
        self.assertTrue(follow.respond)
        self.assertEqual(follow.rule, "sticky_follow_up")

    def test_4_floor_mutex_across_two_floor_store_clients(self) -> None:
        backing: dict = {}
        left = InMemoryFloorStore(backing)
        right = InMemoryFloorStore(backing)
        first = _ask(
            store=left,
            room_key="show",
            text="Majik, status?",
            state=None,
        )
        second = _ask(
            store=right,
            room_key="show",
            state=None,
            me="the-general",
            my_names=GENERAL,
            text="the General, thoughts?",
            others={"majik": MAJIK},
        )
        self.assertTrue(first.respond)
        self.assertFalse(second.respond)
        self.assertEqual(second.rule, "floor_busy")
        left.release_floor("show", "majik")
        retry = _ask(
            store=right,
            room_key="show",
            state=None,
            me="the-general",
            my_names=GENERAL,
            text="the General, thoughts?",
            others={"majik": MAJIK},
        )
        self.assertTrue(retry.respond)

    def test_explicit_primary_is_the_only_cohost(self) -> None:
        self.assertIsNone(
            primary_agent_id(
                SimpleNamespace(name="r", metadata='{"brigade_agent_id": "majik"}')
            )
        )
        self.assertEqual(
            primary_agent_id(
                SimpleNamespace(
                    name="r",
                    metadata='{"voice_primary_agent_id": "majik", "brigade_agent_id": "x"}',
                )
            ),
            "majik",
        )


class RedisFloorClientTests(TestCase):
    def test_two_redis_clients_share_one_lease_and_one_sticky_claim(self) -> None:
        class FakeRedis:
            def __init__(self) -> None:
                self.store: dict[str, str] = {}

            def set(self, key, value, nx=False, ex=None):
                if nx and key in self.store:
                    return None
                self.store[key] = value
                return True

            def get(self, key):
                return self.store.get(key)

            def expire(self, key, seconds):
                return key in self.store

            def delete(self, key):
                self.store.pop(key, None)
                return 1

            def eval(self, script, nkeys, key, agent):
                if self.store.get(key) == agent:
                    self.store.pop(key, None)
                    return 1
                return 0

        client = FakeRedis()
        a = RedisFloorStore(client=client)
        b = RedisFloorStore(client=client)
        self.assertTrue(a.take_floor("room", "majik", now=1))
        self.assertFalse(b.take_floor("room", "the-general", now=1))
        self.assertEqual(b.floor_holder("room", now=1), "majik")
        a.release_floor("room", "majik")
        self.assertTrue(b.take_floor("room", "the-general", now=2))
        a.claim("room", "aaron", "majik", now=1)
        self.assertEqual(b.sticky_agent("room", "aaron", now=1), "majik")


class SpeakerHintTests(TestCase):
    def test_fallback_names_the_room_and_a_speaker_number(self) -> None:
        from agent_runtime.diarization import set_diarization_hook, speaker_hint

        set_diarization_hook(None)
        self.assertEqual(speaker_hint("Aaron"), "Aaron's room · speaker 1")
        self.assertEqual(speaker_hint("Aaron", ordinal=2), "Aaron's room · speaker 2")

    def test_hook_label_wins_over_the_fallback(self) -> None:
        from agent_runtime.diarization import set_diarization_hook, speaker_hint

        class Hook:
            def identify(self, *, participant_identity, participant_name, text):
                return "Shafen"

        set_diarization_hook(Hook())
        try:
            self.assertEqual(speaker_hint("Aaron"), "Shafen")
        finally:
            set_diarization_hook(None)


class MultiTrackTests(TestCase):
    def test_captioner_caps_at_six_and_keeps_track_identity(self) -> None:
        from agent_runtime.multi_track_stt import (
            HumanAudioTrack,
            MultiTrackController,
            select_tracks,
        )

        tracks = [
            HumanAudioTrack(f"human_{i}", f"H{i}", f"TR_{i:02d}") for i in range(8)
        ]
        chosen = select_tracks(tracks, cap=6)
        self.assertEqual(len(chosen), 6)
        self.assertEqual(chosen[0].track_sid, "TR_00")
        opened: list[str] = []

        def opener(track: HumanAudioTrack):
            opened.append(track.participant_identity)
            return SimpleNamespace(aclose=lambda: None)

        controller = MultiTrackController(on_final=lambda t, text: None, opener=opener)
        controller.reconcile(tracks)
        self.assertEqual(len(controller.active_sids), 6)
        self.assertEqual(opened, [t.participant_identity for t in chosen])
        controller.reconcile(tracks[:2])
        self.assertEqual(controller.active_sids, {"TR_00", "TR_01"})

    def test_only_the_elected_captioner_subscribes(self) -> None:
        from agent_runtime.multi_track_stt import attach_multi_track_stt

        human = SimpleNamespace(
            identity=AARON,
            name="Aaron",
            track_publications={
                "p": SimpleNamespace(sid="TR_a", source="microphone", kind="audio")
            },
        )
        room = SimpleNamespace(
            remote_participants={
                AARON: human,
                "agent-zzz": SimpleNamespace(
                    identity="agent-zzz", name="Zed", attributes={}, track_publications={}
                ),
            }
        )
        room.remote_participants["agent-aaa"] = SimpleNamespace(
            identity="agent-aaa", name="Aaa", attributes={}, track_publications={}
        )
        room.on = lambda *a, **k: None
        missed = attach_multi_track_stt(room, "agent-mmm", lambda t, text: None)
        self.assertIsNone(missed)
        attached = attach_multi_track_stt(
            room, "agent-aaa", lambda t, text: None, opener=lambda t: SimpleNamespace()
        )
        self.assertIsNotNone(attached)
        assert attached is not None
        self.assertIn("TR_a", attached.active_sids)


class SpokenLengthAndAckTests(TestCase):
    def test_zero_is_unlimited_and_does_not_say_the_rest_is_in_chat(self) -> None:
        from voice_relay.agent import speakable

        text = "This is a full sentence about the deploy. " * 80
        out = speakable(text, limit=0)
        self.assertNotIn("the rest is in the chat", out)
        self.assertGreater(len(out), 900)

    def test_channel_default_still_truncates(self) -> None:
        from voice_relay.agent import MAX_SPOKEN_CHARS, speakable

        text = ("This is a full sentence about the deploy. " * 60).strip()
        out = speakable(text)
        self.assertLessEqual(len(out), MAX_SPOKEN_CHARS + 40)
        self.assertIn("the rest is in the chat", out)

    def test_gear_on_it_is_not_spoken_but_a_real_reply_is(self) -> None:
        from agent_runtime.spoken_text import is_unvoiced_ack
        from voice_relay.agent import should_speak

        self.assertTrue(is_unvoiced_ack("⚙️ On it"))
        self.assertTrue(is_unvoiced_ack("⚙️ _Using a tool…_"))
        self.assertFalse(
            is_unvoiced_ack(
                "On it. The commander instance is green across all five subdomains."
            )
        )
        packet = {
            "type": "new_message",
            "message": {
                "content": "⚙️ On it",
                "sender": {"username": "agent-claude-code"},
            },
        }
        self.assertIsNone(should_speak(packet, "agent-claude-code"))

    def test_metadata_zero_overrides_the_default(self) -> None:
        from voice_relay.agent import max_spoken_chars_from_metadata

        self.assertEqual(max_spoken_chars_from_metadata({}), 900)
        self.assertEqual(
            max_spoken_chars_from_metadata({"voice_relay_max_spoken_chars": 0}),
            0,
        )
        self.assertEqual(
            max_spoken_chars_from_metadata({"voice_relay_max_spoken_chars": "400"}),
            400,
        )


class BargeInTests(IsolatedAsyncioTestCase):
    async def test_a_human_final_drops_the_chunks_after_the_boundary(self) -> None:
        from agent_runtime.barge_in import BargeIn

        barge = BargeIn()
        spoken: list[str] = []

        class Handle:
            def __init__(self) -> None:
                self.interrupted = False

            def interrupt(self) -> None:
                self.interrupted = True

            async def wait_for_playout(self) -> None:
                return None

        def say(text: str):
            spoken.append(text)
            handle = Handle()
            if len(spoken) == 1:
                self.assertTrue(barge.on_human_final("excuse me"))
            return handle

        count = await barge.say_chunks(say, ["one", "two", "three"])
        self.assertEqual(spoken, ["one"])
        self.assertEqual(count, 1)
        self.assertEqual(barge.dropped, ["two", "three"])

    async def test_an_empty_final_does_not_barge(self) -> None:
        from agent_runtime.barge_in import BargeIn

        barge = BargeIn()
        barge.speaking = True
        self.assertFalse(barge.on_human_final("   "))
        self.assertFalse(barge.barge)

    async def test_ack_is_not_passed_to_say(self) -> None:
        from agent_runtime.barge_in import BargeIn, install_chunked_say

        barge = BargeIn()
        spoken: list[str] = []
        session = SimpleNamespace()

        def say(text: str, *args, **kwargs):
            spoken.append(text)
            return SimpleNamespace(interrupt=lambda: None, wait_for_playout=None)

        session.say = say
        install_chunked_say(session, barge, limit_of=lambda: 0)
        session.say("⚙️ On it")
        self.assertEqual(spoken, [])
        session.say("hello there")
        await asyncio.sleep(0)
        self.assertEqual(spoken, ["hello there"])
