"""POST /api/v1/tts read-aloud voice resolution.

The per-message speaker button must speak with the Kokoro voice of the agent
that wrote the message, and a sender with no preset must get the configured
read-aloud default — never a 422 (which the web client treats as "Kokoro is
down" and reads with the browser's speechSynthesis) and never one of the four
named crew voices (Aaron, 2026-09-07).

Also pins the server's mirror of ``agents/plugins/tts.py::KOKORO_VOICE_PRESETS``
to the real table, since the server image cannot import the agents package.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.api import tts as tts_api
from app.api.tts import (
    AGENT_VOICES,
    READ_ALOUD_FALLBACK_VOICE,
    RESERVED_SEAT_VOICES,
    TtsRequest,
    read_aloud_default_voice,
    resolve_agent_voice,
    synthesize_speech,
)

_PRESETS_FILE = (
    Path(__file__).resolve().parents[2] / "agents" / "plugins" / "tts.py"
)


def _settings(**overrides) -> SimpleNamespace:
    base = {
        "kokoro_base_url": "http://kokoro.test",
        "tts_default_voice": "af_heart",
        "tts_read_aloud_default_voice": "am_adam",
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def _load_agent_presets() -> dict[str, str]:
    """KOKORO_VOICE_PRESETS from agents/plugins/tts.py, read via ast so the
    server test needs neither livekit nor the agents venv."""
    tree = ast.parse(_PRESETS_FILE.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        names = [t.id for t in targets if isinstance(t, ast.Name)]
        if "KOKORO_VOICE_PRESETS" in names and node.value is not None:
            presets = ast.literal_eval(node.value)
            assert isinstance(presets, dict)
            return presets
    raise AssertionError("KOKORO_VOICE_PRESETS not found in agents/plugins/tts.py")


class ResolveAgentVoiceTests(unittest.TestCase):
    def test_named_crew_seats_resolve_by_id_identity_and_display_name(self) -> None:
        self.assertEqual(resolve_agent_voice("persephone"), "af_heart")
        self.assertEqual(resolve_agent_voice("agent-persephone"), "af_heart")
        self.assertEqual(resolve_agent_voice("Persephone"), "af_heart")
        self.assertEqual(resolve_agent_voice("rook"), "am_echo")
        self.assertEqual(resolve_agent_voice("Rook"), "am_echo")
        self.assertEqual(resolve_agent_voice("agent-claude-code"), "am_echo")
        self.assertEqual(resolve_agent_voice("Claude Code"), "am_echo")
        self.assertEqual(resolve_agent_voice("majik"), "am_puck")
        self.assertEqual(resolve_agent_voice("Majik Mane"), "am_puck")
        self.assertEqual(resolve_agent_voice("agent-majik"), "am_puck")
        self.assertEqual(resolve_agent_voice("the-general"), "am_michael")
        self.assertEqual(resolve_agent_voice("The General"), "am_michael")

    def test_unknown_or_empty_sender_has_no_preset(self) -> None:
        for hint in (None, "", "   ", "ChatGPT", "Gemini", "agent-grok", "Aaron Stransky"):
            self.assertIsNone(resolve_agent_voice(hint), hint)


class ReadAloudDefaultVoiceTests(unittest.TestCase):
    def test_configured_default_is_used(self) -> None:
        self.assertEqual(read_aloud_default_voice(_settings()), "am_adam")
        self.assertEqual(
            read_aloud_default_voice(_settings(tts_read_aloud_default_voice="bm_george")),
            "bm_george",
        )

    def test_reserved_crew_voices_are_refused(self) -> None:
        for reserved in sorted(RESERVED_SEAT_VOICES):
            self.assertEqual(
                read_aloud_default_voice(
                    _settings(tts_read_aloud_default_voice=reserved)
                ),
                READ_ALOUD_FALLBACK_VOICE,
                reserved,
            )
        self.assertEqual(
            read_aloud_default_voice(_settings(tts_read_aloud_default_voice="")),
            READ_ALOUD_FALLBACK_VOICE,
        )

    def test_fallback_is_not_a_crew_voice(self) -> None:
        self.assertNotIn(READ_ALOUD_FALLBACK_VOICE, RESERVED_SEAT_VOICES)
        self.assertEqual(
            RESERVED_SEAT_VOICES,
            {
                AGENT_VOICES["persephone"],
                AGENT_VOICES["rook"],
                AGENT_VOICES["majik"],
                AGENT_VOICES["the-general"],
            },
        )


class SynthesizeSpeechRouteTests(IsolatedAsyncioTestCase):
    async def _voice_for(self, body: TtsRequest, settings=None) -> str:
        synth = AsyncMock(return_value=(b"mp3", "audio/mpeg"))
        with patch.object(tts_api, "_synthesize_resilient", synth):
            await synthesize_speech(
                body, {"participant_id": "p1"}, settings or _settings(), None
            )
        synth.assert_awaited_once()
        return synth.await_args.args[2]

    async def test_read_aloud_speaks_the_sender_agents_voice(self) -> None:
        cases = [
            ({"agent": "persephone"}, "af_heart"),
            ({"sender_name": "Persephone"}, "af_heart"),
            ({"agent": "rook"}, "am_echo"),
            ({"sender_name": "Majik Mane"}, "am_puck"),
            ({"agent": "the-general", "sender_name": "The General"}, "am_michael"),
            # brigade id wins over the display name when both are present
            ({"agent": "majik", "sender_name": "Whatever"}, "am_puck"),
            # an unknown brigade id falls through to the display name
            ({"agent": "qwen-35b", "sender_name": "Rook"}, "am_echo"),
        ]
        for extra, expected in cases:
            body = TtsRequest(text="hello there", read_aloud=True, **extra)
            self.assertEqual(await self._voice_for(body), expected, extra)

    async def test_read_aloud_unknown_sender_gets_the_default_not_422(self) -> None:
        for extra in (
            {},  # human sender: no hints at all
            {"sender_name": "ChatGPT"},
            {"agent": "gemini", "sender_name": "Gemini"},
        ):
            body = TtsRequest(text="hello there", read_aloud=True, **extra)
            self.assertEqual(await self._voice_for(body), "am_adam", extra)

    async def test_read_aloud_never_defaults_to_a_crew_voice(self) -> None:
        body = TtsRequest(text="hello there", read_aloud=True, sender_name="ChatGPT")
        for reserved in sorted(RESERVED_SEAT_VOICES):
            voice = await self._voice_for(
                body, _settings(tts_read_aloud_default_voice=reserved)
            )
            self.assertNotIn(voice, RESERVED_SEAT_VOICES, reserved)
        # ...and the suite default (af_heart) is not consulted for read-aloud.
        voice = await self._voice_for(body, _settings(tts_default_voice="af_heart"))
        self.assertEqual(voice, "am_adam")

    async def test_explicit_voice_still_wins(self) -> None:
        body = TtsRequest(text="hi", read_aloud=True, voice="bf_emma", agent="rook")
        self.assertEqual(await self._voice_for(body), "bf_emma")

    async def test_strict_callers_keep_the_422_on_unknown_agent(self) -> None:
        body = TtsRequest(text="hello there", agent="no-such-agent")
        with self.assertRaises(HTTPException) as ctx:
            await self._voice_for(body)
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_no_hints_without_read_aloud_keeps_suite_default(self) -> None:
        body = TtsRequest(text="hello there")
        self.assertEqual(await self._voice_for(body), "af_heart")


class MirrorMatchesAgentPresetsTests(unittest.TestCase):
    def test_server_mirror_matches_kokoro_voice_presets(self) -> None:
        if not _PRESETS_FILE.exists():
            self.skipTest("agents/plugins/tts.py not present (server-only checkout)")
        presets = _load_agent_presets()
        presets.pop("default", None)
        self.assertEqual(AGENT_VOICES, presets)
