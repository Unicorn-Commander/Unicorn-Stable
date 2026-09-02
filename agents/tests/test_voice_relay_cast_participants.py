"""One participant per cast member (voice_relay_multi) and a face per
participant (voice_relay_video).

The contract these lock down:

  * both flags default OFF, and with both off the relay's ``_say`` path is
    exactly the pre-existing one — the session voice for Rook, ``say(audio=)``
    for the cast — with no cast connections and no puppet;
  * the flags are read from job metadata when it speaks to them, else the
    room's, in every spelling LiveKit metadata can carry;
  * the cast is every sender in ``voice_relay_voices`` EXCEPT the host;
  * a line from a sender with a ready cast member leaves THAT member's mouth
    and is captioned as that participant; a member that produced nothing
    falls back to the old path rather than to silence;
  * ``relay_config`` frames toggle the flags live; a ``voices`` change
    re-reconciles the cast;
  * cast puppets are invisible to the captioner election and the sole-agent
    rule (they are mouths, not colleagues).
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock

from agent_runtime.voice_transcripts import elected_user_captioner, is_cast_puppet
from voice_relay.agent import (
    DEFAULT_SOURCE_USERNAME,
    SpokenLine,
    VoiceRelayAgent,
    flags_present,
    relay_flags_from_metadata,
    sole_agent_in_call,
)
from voice_relay.cast import cast_identities, mint_cast_token

ROOK = DEFAULT_SOURCE_USERNAME
CAST = {"agent-grok": "am_onyx", "agent-flow": "bm_lewis"}


def _agent(**overrides) -> VoiceRelayAgent:
    agent = VoiceRelayAgent.__new__(VoiceRelayAgent)
    VoiceRelayAgent.__init__(agent)
    agent._identity = ROOK
    agent._join_identity = ROOK
    agent._my_names = {"rook"}
    agent._persona_voice = "am_echo"
    for key, value in overrides.items():
        setattr(agent, key, value)
    return agent


class _FakeSession:
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


def _tts(frames):
    return SimpleNamespace(synthesize=lambda text: _FakeStream(frames))


class _FakeMember:
    def __init__(self, ready=True, speaks=True) -> None:
        self.ready = ready
        self.spoken: list[list] = []
        self._speaks = speaks
        self.voice = "am_onyx"
        self.video_enabled = True

    async def speak(self, frames, *, budget_s=45.0):
        self.spoken.append(list(frames))
        return self._speaks

    async def close(self):
        self.ready = False


class FlagDefaultsTests(TestCase):
    def test_both_flags_default_off(self) -> None:
        for meta in ("", None, {}, "not json", "[]", 7, {"voice_relay_source": ROOK}):
            self.assertEqual(relay_flags_from_metadata(meta), {"video": False, "multi": False})
            self.assertFalse(flags_present(meta))

    def test_every_spelling_livekit_metadata_can_carry(self) -> None:
        for value in (True, "true", "TRUE", "1", "yes", "on", 1):
            flags = relay_flags_from_metadata({"voice_relay_video": value})
            self.assertTrue(flags["video"], value)
            self.assertFalse(flags["multi"])
        for value in (False, "false", "0", "", "no", "off", None, 0, "junk"):
            self.assertFalse(relay_flags_from_metadata({"voice_relay_multi": value})["multi"], value)

    def test_json_string_form(self) -> None:
        flags = relay_flags_from_metadata(json.dumps({"voice_relay_video": "true", "voice_relay_multi": True}))
        self.assertEqual(flags, {"video": True, "multi": True})
        self.assertTrue(flags_present('{"voice_relay_multi": false}'))

    def test_a_fresh_agent_has_no_cast_and_no_face(self) -> None:
        agent = _agent()
        self.assertFalse(agent._video)
        self.assertFalse(agent._multi)
        self.assertEqual(agent._cast, {})
        self.assertIsNone(agent._puppet)


class CastSelectionTests(TestCase):
    def test_cast_is_every_sender_but_the_host(self) -> None:
        voices = {ROOK: "am_echo", **CAST}
        self.assertEqual(cast_identities(voices, ROOK), ["agent-grok", "agent-flow"])

    def test_legacy_single_source_has_no_cast(self) -> None:
        self.assertEqual(cast_identities({ROOK: "am_echo"}, ROOK), [])

    def test_agent_wants_no_cast_unless_multi(self) -> None:
        agent = _agent(_voices={ROOK: "am_echo", **CAST})
        self.assertEqual(agent._cast_wanted(), [])
        agent._multi = True
        self.assertEqual(agent._cast_wanted(), ["agent-grok", "agent-flow"])

    def test_cast_token_names_the_sender_and_marks_it_a_puppet(self) -> None:
        import base64

        jwt = mint_cast_token(
            api_key="k",
            api_secret="s" * 32,
            room_name="stable-room",
            identity="agent-grok",
            display_name="Grok",
            host_identity=ROOK,
        )
        payload = jwt.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        self.assertEqual(claims["sub"], "agent-grok")
        self.assertEqual(claims["name"], "Grok")
        self.assertEqual(claims["attributes"], {"stable.cast": "1", "stable.cast_of": ROOK})
        video = claims["video"]
        self.assertEqual(video["room"], "stable-room")
        self.assertTrue(video["canPublish"])
        self.assertFalse(video.get("hidden", False))
        self.assertFalse(video.get("canSubscribe", False))
        self.assertEqual(claims.get("kind"), "agent")


class LiveConfigTests(TestCase):
    @staticmethod
    def _frame(payload: dict) -> SimpleNamespace:
        return SimpleNamespace(data=json.dumps(payload).encode())

    def test_video_and_multi_toggle_live_and_reconcile(self) -> None:
        agent = _agent()
        agent._schedule_visuals = MagicMock()
        agent._on_data(self._frame({"type": "relay_config", "video": True}))
        self.assertTrue(agent._video)
        self.assertFalse(agent._multi)
        agent._on_data(self._frame({"type": "relay_config", "multi": "true", "video": False}))
        self.assertFalse(agent._video)
        self.assertTrue(agent._multi)
        self.assertEqual(agent._schedule_visuals.call_count, 2)

    def test_a_voices_change_reconciles_the_cast(self) -> None:
        agent = _agent()
        agent._schedule_visuals = MagicMock()
        agent._on_data(self._frame({"type": "relay_config", "voices": CAST}))
        agent._schedule_visuals.assert_called_once()
        self.assertEqual(set(agent._voices), {ROOK, *CAST})

    def test_an_activation_only_frame_touches_no_flags(self) -> None:
        agent = _agent()
        agent._schedule_visuals = MagicMock()
        agent._on_data(self._frame({"type": "relay_config", "activation": "ptt"}))
        self.assertEqual(agent._activation, "ptt")
        agent._schedule_visuals.assert_not_called()
        self.assertFalse(agent._video)


class SayRoutingTests(IsolatedAsyncioTestCase):
    async def test_flags_off_is_the_pre_existing_path(self) -> None:
        """No cast → the cast voice rides the session's say(audio=) exactly as
        before this change."""
        agent = _agent(_session=_FakeSession(), _voices={ROOK: "am_echo", **CAST})
        agent._voice_tts["am_onyx"] = _tts(["f1", "f2"])
        await agent._say(SpokenLine("am_onyx", "hi", "agent-grok", "Grok"))
        await asyncio.sleep(0)
        self.assertEqual(len(agent._session.calls), 1)
        text, frames = agent._session.calls[0]
        self.assertEqual(text, "hi")
        self.assertEqual(frames, ["f1", "f2"])

    async def test_a_cast_line_leaves_the_members_mouth_not_the_relays(self) -> None:
        member = _FakeMember()
        captions = SimpleNamespace(publish_agent_final=MagicMock())
        agent = _agent(_session=_FakeSession(), _captions=captions, _cast={"agent-grok": member})
        agent._voice_tts["am_onyx"] = _tts(["f1", "f2"])
        await agent._say(SpokenLine("am_onyx", "hello there", "agent-grok", "Grok"))
        self.assertEqual(member.spoken, [["f1", "f2"]])
        self.assertEqual(agent._session.calls, [])
        captions.publish_agent_final.assert_called_once_with(
            "hello there", name="Grok", participant_id="agent-grok"
        )

    async def test_the_hosts_own_line_never_goes_through_a_member(self) -> None:
        member = _FakeMember()
        agent = _agent(_session=_FakeSession(), _cast={"agent-grok": member})
        await agent._say(SpokenLine("am_echo", "rook here", ROOK, "Rook"))
        self.assertEqual(member.spoken, [])
        self.assertEqual(agent._session.calls, [("rook here", None)])

    async def test_a_member_that_produced_nothing_falls_back_to_the_relay(self) -> None:
        member = _FakeMember(speaks=False)
        agent = _agent(_session=_FakeSession(), _cast={"agent-grok": member})
        agent._voice_tts["am_onyx"] = _tts(["f1"])
        await agent._say(SpokenLine("am_onyx", "hi", "agent-grok", "Grok"))
        await asyncio.sleep(0)
        self.assertEqual(len(member.spoken), 1)
        self.assertEqual(len(agent._session.calls), 1)  # the old path spoke it

    async def test_a_member_still_connecting_is_skipped(self) -> None:
        member = _FakeMember(ready=False)
        agent = _agent(_session=_FakeSession(), _cast={"agent-grok": member})
        agent._voice_tts["am_onyx"] = _tts(["f1"])
        await agent._say(SpokenLine("am_onyx", "hi", "agent-grok", "Grok"))
        await asyncio.sleep(0)
        self.assertEqual(member.spoken, [])
        self.assertEqual(len(agent._session.calls), 1)


class ReconcileTests(IsolatedAsyncioTestCase):
    async def test_multi_off_closes_members_and_joins_nobody(self) -> None:
        member = _FakeMember()
        agent = _agent(_cast={"agent-grok": member}, _lk_room=SimpleNamespace(remote_participants={}))
        await agent._reconcile_cast()
        self.assertEqual(agent._cast, {})
        self.assertFalse(member.ready)

    async def test_an_identity_already_in_the_room_is_never_evicted(self) -> None:
        """A real Grok worker in the call keeps its name; the cast stands down."""
        joined: list[str] = []

        class _Member:
            def __init__(self, **kw):
                joined.append(kw["identity"])
                self.identity = kw["identity"]
                self.ready = True
                self.video_enabled = kw["video"]
                self.voice = kw["voice"]

            async def connect(self):
                return True

        import voice_relay.agent as mod

        original = mod.CastMember
        mod.CastMember = _Member
        try:
            room = SimpleNamespace(
                name="stable-room",
                remote_participants={"p1": SimpleNamespace(identity="agent-grok")},
            )
            agent = _agent(
                _multi=True,
                _voices={ROOK: "am_echo", **CAST},
                _lk_room=room,
                _manifest={},
            )
            await agent._reconcile_cast()
        finally:
            mod.CastMember = original
        self.assertEqual(joined, ["agent-flow"])
        self.assertEqual(set(agent._cast), {"agent-flow"})
        self.assertFalse(agent._cast["agent-flow"].video_enabled)

    async def test_video_off_stops_the_face(self) -> None:
        puppet = SimpleNamespace(stop=AsyncMock())
        agent = _agent(_puppet=puppet, _video=False, _lk_room=SimpleNamespace())
        await agent._reconcile_own_face()
        puppet.stop.assert_awaited_once()
        self.assertIsNone(agent._puppet)


class PuppetsAreNotColleaguesTests(TestCase):
    @staticmethod
    def _p(identity: str, cast: bool = False) -> SimpleNamespace:
        return SimpleNamespace(
            identity=identity,
            attributes={"stable.cast": "1", "stable.cast_of": ROOK} if cast else {},
        )

    def test_is_cast_puppet_reads_the_attribute(self) -> None:
        self.assertTrue(is_cast_puppet(self._p("agent-grok", cast=True)))
        self.assertFalse(is_cast_puppet(self._p("agent-grok")))
        self.assertFalse(is_cast_puppet(None))

    def test_the_captioner_election_ignores_puppets(self) -> None:
        """agent-claude-code sorts AFTER agent-flow/agent-grok; without the
        skip the relay would elect a puppet that never captions and go quiet."""
        room = SimpleNamespace(
            remote_participants={
                "a": self._p("agent-flow", cast=True),
                "b": self._p("agent-grok", cast=True),
                "h": self._p("aaron_1234"),
            }
        )
        self.assertTrue(elected_user_captioner(room, ROOK))
        room.remote_participants["c"] = self._p("agent-brigade-majik")
        self.assertFalse(elected_user_captioner(room, ROOK))  # a real colleague wins

    def test_sole_agent_rule_ignores_puppets(self) -> None:
        room = SimpleNamespace(
            remote_participants={"a": self._p("agent-grok", cast=True)}
        )
        self.assertTrue(sole_agent_in_call(room, ROOK))
        room.remote_participants["b"] = self._p("agent-majik")
        self.assertFalse(sole_agent_in_call(room, ROOK))
