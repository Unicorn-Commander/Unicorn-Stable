"""Mention emails must not be an injection vector.

Until 2026-08-12 every interpolated value went into the HTML raw. Display names
and room labels are user-set and `quote` is raw message text, so anyone able to
post in a room could inject markup into an email sent FROM a trusted internal
address TO other members. Mail clients strip <script>; they do not strip links,
which is what makes this phishing rather than cosmetics.

Run: python -m unittest -q tests/test_mention_email_escaping.py
"""

from __future__ import annotations

import unittest

from app.api.messages import render_mention_email_html

# A payload that is dangerous in an email specifically: a plausible button
# pointing somewhere else entirely.
PHISH = '<a href="https://evil.example/reset">Reset your password</a>'


def render(**over: str) -> str:
    base = dict(
        recipient_name="Aaron",
        sender_name="Someone",
        mention_phrase="you",
        room_label="General",
        quote="hello",
        link="https://stable.magicunicorn.dev/?room=abc",
    )
    base.update(over)
    return render_mention_email_html(**base)  # type: ignore[arg-type]


class TestMentionEmailEscaping(unittest.TestCase):
    def test_message_text_cannot_inject_markup(self):
        html = render(quote=PHISH)
        self.assertNotIn(PHISH, html)
        self.assertNotIn("<a href=\"https://evil.example/reset\"", html)
        self.assertIn("&lt;a href=", html)

    def test_every_user_controlled_field_is_escaped(self):
        for field in ("recipient_name", "sender_name", "room_label", "quote"):
            with self.subTest(field=field):
                html = render(**{field: "<b>x</b>"})
                self.assertNotIn("<b>x</b>", html)
                self.assertIn("&lt;b&gt;x&lt;/b&gt;", html)

    def test_attribute_breakout_via_quotes_is_escaped(self):
        # A display name closing the href attribute would otherwise let the
        # attacker add their own attributes to the anchor.
        html = render(sender_name='" onmouseover="alert(1)')
        self.assertNotIn('" onmouseover="', html)

    def test_the_real_link_still_works(self):
        link = "https://stable.magicunicorn.dev/?room=abc-123"
        html = render(link=link)
        # escape(quote=True) turns & into &amp; but must not mangle the path.
        self.assertIn("stable.magicunicorn.dev", html)
        self.assertIn("room=abc-123", html)

    def test_ordinary_content_is_still_readable(self):
        html = render(quote="hey, can you look at the deploy?", sender_name="Shafen")
        self.assertIn("hey, can you look at the deploy?", html)
        self.assertIn("Shafen", html)
        self.assertIn("Open Stable", html)


if __name__ == "__main__":
    unittest.main()
