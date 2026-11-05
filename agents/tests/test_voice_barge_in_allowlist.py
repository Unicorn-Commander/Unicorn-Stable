"""Who may interrupt: ``voice_relay_barge_in_from``.

Measured on a Stable call on 2026-10-26: a guest talking over the relay cut
the seat off mid-answer. The room owner wants only HIS microphone to barge.
Everyone else is still heard, captioned and persisted exactly as before; they
just never take the floor.
"""

from __future__ import annotations

import json
import os
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from voice_relay.agent import (
    BARGE_IN_FROM_ENV,
    BARGE_IN_FROM_METADATA_KEY,
    VoiceRelayAgent,
    barge_in_allowed_speakers,
    speaker_may_barge,
    speaker_username,
)

AARON = "aaron_c0cf018d-f9d4-4638-a43b-23914024aad4"
PAUL = "paul_5b1d1c9e-1e0f-4d3a-9c2b-7a6f8e9d0c1b"
#: Addressed to the persona, so the normal path persists it in name mode.
LINE = "rook hold on a second, that is not what I asked"


def _no_env():
    return patch.dict(os.environ, {BARGE_IN_FROM_ENV: ""}, clear=False)


class ParserTests(TestCase):
    def test_absent_key_means_no_allowlist(self) -> None:
        with _no_env():
            self.assertIsNone(barge_in_allowed_speakers({}))
            self.assertIsNone(barge_in_allowed_speakers("", {}))
            self.assertIsNone(barge_in_allowed_speakers("not json"))

    def test_list_comma_string_and_json_string_forms(self) -> None:
        with _no_env():
            for raw in (["aaron"], "aaron", '["aaron"]', " aaron , "):
                self.assertEqual(
                    barge_in_allowed_speakers({BARGE_IN_FROM_METADATA_KEY: raw}),
                    frozenset({"aaron"}),
                    raw,
                )
            self.assertEqual(
                barge_in_allowed_speakers({BARGE_IN_FROM_METADATA_KEY: "aaron, shafen"}),
                frozenset({"aaron", "shafen"}),
            )
            # LiveKit metadata is a JSON string; the key may be nested in it.
            self.assertEqual(
                barge_in_allowed_speakers(
                    json.dumps({BARGE_IN_FROM_METADATA_KEY: ["Aaron"]})
                ),
                frozenset({"aaron"}),
            )

    def test_case_insensitive_and_full_identities_normalise(self) -> None:
        with _no_env():
            self.assertEqual(
                barge_in_allowed_speakers({BARGE_IN_FROM_METADATA_KEY: ["AARON", AARON.upper()]}),
                frozenset({"aaron"}),
            )

    def test_present_but_empty_means_anyone(self) -> None:
        with _no_env():
            for raw in ([], "", "  ,  ", None, 7):
                self.assertIsNone(
                    barge_in_allowed_speakers({BARGE_IN_FROM_METADATA_KEY: raw}), raw
                )

    def test_dispatch_metadata_wins_over_room_metadata(self) -> None:
        with _no_env():
            self.assertEqual(
                barge_in_allowed_speakers(
                    {BARGE_IN_FROM_METADATA_KEY: "shafen"},
                    {BARGE_IN_FROM_METADATA_KEY: "aaron"},
                ),
                frozenset({"shafen"}),
            )
            # A metadata without the key defers to the next one.
            self.assertEqual(
                barge_in_allowed_speakers({}, {BARGE_IN_FROM_METADATA_KEY: "aaron"}),
                frozenset({"aaron"}),
            )

    def test_env_default_applies_only_when_no_metadata_has_the_key(self) -> None:
        with patch.dict(os.environ, {BARGE_IN_FROM_ENV: "Aaron, shafen"}):
            self.assertEqual(barge_in_allowed_speakers({}), frozenset({"aaron", "shafen"}))
            self.assertEqual(barge_in_allowed_speakers("", {}), frozenset({"aaron", "shafen"}))
            self.assertEqual(
                barge_in_allowed_speakers({BARGE_IN_FROM_METADATA_KEY: "paul"}),
                frozenset({"paul"}),
            )
            # A room that says "everyone" overrides the worker default.
            self.assertIsNone(barge_in_allowed_speakers({BARGE_IN_FROM_METADATA_KEY: []}))

    def test_speaker_username_strips_the_uuid_tail(self) -> None:
        self.assertEqual(speaker_username(AARON), "aaron")
        self.assertEqual(speaker_username("Aaron_" + AARON.split("_", 1)[1]), "aaron")
        self.assertEqual(speaker_username("dana_commander_" + AARON.split("_", 1)[1]), "dana_commander")
        self.assertEqual(speaker_username("agent-persephone"), "agent-persephone")
        self.assertEqual(speaker_username("aaron_notauuid"), "aaron_notauuid")
        self.assertEqual(speaker_username(None), "")

    def test_speaker_may_barge(self) -> None:
        self.assertTrue(speaker_may_barge(PAUL, None))
        self.assertTrue(speaker_may_barge(None, None))
        self.assertTrue(speaker_may_barge(AARON, frozenset({"aaron"})))
        self.assertFalse(speaker_may_barge(PAUL, frozenset({"aaron"})))
        self.assertFalse(speaker_may_barge(None, frozenset({"aaron"})))
        self.assertFalse(speaker_may_barge("", frozenset({"aaron"})))


class RelayAllowlistTests(TestCase):
    """The relay, speaking, hears a long non-echo line from a human."""

    def _speaking_agent(self, allowed: frozenset[str] | None):
        hit = {"value": False}

        def interrupt() -> None:
            hit["value"] = True

        agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
        VoiceRelayAgent.__init__(agent)
        agent._identity = "agent-claude-code"
        agent._my_names = {"rook"}
        agent._persona_voice = "am_echo"
        agent._publisher = MagicMock()
        agent._captions = None
        agent._lk_room = SimpleNamespace(
            remote_participants={
                AARON: SimpleNamespace(identity=AARON, metadata=""),
                PAUL: SimpleNamespace(identity=PAUL, metadata=""),
            }
        )
        agent._speaking = True
        agent._barge_in_mode = "auto"
        agent._barge_in_from = allowed
        agent._speech_handle = SimpleNamespace(interrupt=interrupt)
        return agent, hit

    @staticmethod
    def _track(identity: str, name: str):
        return SimpleNamespace(participant_identity=identity, participant_name=name)

    def _persisted(self, agent) -> list[str]:
        return [c.args[1] for c in agent._publisher.persist_user_utterance.call_args_list]

    def test_no_allowlist_the_guest_still_interrupts(self) -> None:
        agent, hit = self._speaking_agent(None)
        agent._on_track_final(self._track(PAUL, "Paul"), LINE)
        self.assertTrue(hit["value"])
        self.assertTrue(agent._barge_in)
        self.assertEqual(self._persisted(agent), [LINE])

    def test_aaron_interrupts_and_the_guest_does_not(self) -> None:
        allowed = frozenset({"aaron"})
        agent, hit = self._speaking_agent(allowed)
        agent._on_track_final(self._track(PAUL, "Paul"), LINE)
        self.assertFalse(hit["value"])
        self.assertFalse(agent._barge_in)
        # His words still land where they always did.
        self.assertEqual(self._persisted(agent), [LINE])

        agent, hit = self._speaking_agent(allowed)
        agent._on_track_final(self._track(AARON, "Aaron"), LINE)
        self.assertTrue(hit["value"])
        self.assertTrue(agent._barge_in)
        self.assertEqual(self._persisted(agent), [LINE])

    def test_the_session_ear_applies_the_same_rule(self) -> None:
        for identity, expect in ((PAUL, False), (AARON, True)):
            agent, hit = self._speaking_agent(frozenset({"aaron"}))
            agent._on_own_stt(
                SimpleNamespace(transcript=LINE, is_final=True, speaker_id=identity)
            )
            self.assertEqual(hit["value"], expect, identity)
            self.assertEqual(self._persisted(agent), [LINE], identity)

    def test_a_disallowed_speaker_is_logged_once_per_utterance(self) -> None:
        agent, hit = self._speaking_agent(frozenset({"aaron"}))
        with patch("voice_relay.agent.logger") as log:
            agent._on_track_final(self._track(PAUL, "Paul"), LINE)
        ignored = [
            c for c in log.debug.call_args_list
            if c.args and c.args[0] == "voice_relay_barge_speaker_ignored"
        ]
        self.assertEqual(len(ignored), 1)
        self.assertEqual(ignored[0].kwargs.get("speaker"), PAUL)
        self.assertFalse(hit["value"])

    def test_off_mode_still_wins_over_the_allowlist(self) -> None:
        agent, hit = self._speaking_agent(frozenset({"aaron"}))
        agent._barge_in_mode = "off"
        agent._on_track_final(self._track(AARON, "Aaron"), LINE)
        self.assertFalse(hit["value"])

    def test_build_reads_the_room_and_a_relay_config_frame_updates_it_live(self) -> None:
        agent, _ = self._speaking_agent(None)
        with _no_env():
            agent._barge_in_from = barge_in_allowed_speakers(
                "", json.dumps({BARGE_IN_FROM_METADATA_KEY: "aaron"})
            )
        self.assertEqual(agent._barge_in_from, frozenset({"aaron"}))

        def frame(payload: dict):
            return SimpleNamespace(data=json.dumps(payload).encode())

        agent._on_data(frame({"type": "relay_config", "barge_in_from": ["Aaron", "shafen"]}))
        self.assertEqual(agent._barge_in_from, frozenset({"aaron", "shafen"}))
        agent._on_data(frame({"type": "relay_config", BARGE_IN_FROM_METADATA_KEY: "paul"}))
        self.assertEqual(agent._barge_in_from, frozenset({"paul"}))
        with _no_env():
            agent._on_data(frame({"type": "relay_config", "barge_in_from": []}))
        self.assertIsNone(agent._barge_in_from)
        # A frame without the key leaves it alone.
        agent._barge_in_from = frozenset({"aaron"})
        agent._on_data(frame({"type": "relay_config", "activation": "always"}))
        self.assertEqual(agent._barge_in_from, frozenset({"aaron"}))


class BrigadeLatchTests(TestCase):
    """The Brigade lane's latch honours the same list."""

    def _barge(self, allowed):
        from agent_runtime.barge_in import BargeIn

        hits = {"value": 0}
        barge = BargeIn(allowed_speakers=allowed)
        barge.speaking = True
        barge.handle = SimpleNamespace(interrupt=lambda: hits.__setitem__("value", hits["value"] + 1))
        return barge, hits

    def test_no_allowlist_anyone_interrupts(self) -> None:
        barge, hits = self._barge(None)
        self.assertTrue(barge.on_human_final("please stop the reply now", speaker=PAUL))
        self.assertTrue(barge.on_human_final("please stop the reply now"))
        self.assertEqual(hits["value"], 2)

    def test_only_listed_speakers_interrupt(self) -> None:
        barge, hits = self._barge(frozenset({"aaron"}))
        self.assertFalse(barge.on_human_final("please stop the reply now", speaker=PAUL))
        self.assertFalse(barge.on_human_final("please stop the reply now"))
        self.assertEqual(hits["value"], 0)
        self.assertTrue(barge.on_human_final("please stop the reply now", speaker=AARON))
        self.assertEqual(hits["value"], 1)

    def test_brigade_passes_the_speaker_at_every_call_site(self) -> None:
        import inspect

        from brigade_backed.agent import BrigadeBackedAgent

        wire = inspect.getsource(BrigadeBackedAgent._wire_session_events)
        self.assertIn("speaker=getattr(ev, \"speaker_id\", None)", wire)
        multi = inspect.getsource(BrigadeBackedAgent._attach_multi_track)
        self.assertIn('speaker=getattr(track, "participant_identity", None)', multi)
        build = inspect.getsource(BrigadeBackedAgent.build_pipeline)
        self.assertIn("allowed_speakers=barge_in_allowed_speakers(", build)
