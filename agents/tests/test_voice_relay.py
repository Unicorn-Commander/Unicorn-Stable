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
