"""What the relay and the Brigade lane refuse to say aloud.

Tool-status acks ("⚙️ On it", "⚙️ _Using a tool…_") are chat chrome. Reading
them out holds the floor for a sentence that was never meant to be heard.
A real reply that merely begins with those words is still spoken.
"""

from __future__ import annotations

import re

_EMPHASIS = re.compile(r"(\*\*|__|\*|_)")
_GEAR = "⚙"

# Short status lines the text responder posts while a tool runs. Matched
# after the gear and the markdown italics are stripped.
_STATUS_PREFIXES = (
    "on it",
    "using ",
    "searching ",
    "researching",
    "writing ",
    "updating ",
    "editing ",
    "recalling",
    "asking ",
)


def is_unvoiced_ack(text: str) -> bool:
    """True for a gear-prefixed status ack, not for a real answer."""
    raw = text or ""
    if _GEAR not in raw:
        return False
    bare = _EMPHASIS.sub("", raw)
    bare = bare.replace("⚙️", "").replace(_GEAR, "")
    bare = bare.strip(" \n\t._…")
    if not bare:
        return True
    # A second sentence is a reply that happened to carry the gear, not a chip.
    if any(mark in bare for mark in (". ", "? ", "! ")):
        return False
    low = bare.lower().strip(" .…")
    if len(low) > 80:
        return False
    if low == "on it":
        return True
    return any(low.startswith(prefix) for prefix in _STATUS_PREFIXES if prefix != "on it")
