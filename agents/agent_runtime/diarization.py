"""Speaker hint for a shared microphone.

Amanuensis v2 (P-00176) will identify voices on one device. Until that hook
is installed, a shared-mic line is labelled with the device owner's name and
a speaker number — "Aaron's room · speaker 1" — so the transcript does not
pretend the second person is the first.
"""

from __future__ import annotations

from typing import Protocol

import structlog

logger = structlog.get_logger(__name__)


class DiarizationHook(Protocol):
    """Amanuensis v2 / voiceprint. Return a label, or None to use the fallback."""

    def identify(
        self,
        *,
        participant_identity: str,
        participant_name: str,
        text: str,
    ) -> str | None: ...


_hook: DiarizationHook | None = None


def set_diarization_hook(hook: DiarizationHook | None) -> None:
    """Install the voiceprint hook. ``None`` restores the room·speaker fallback."""
    global _hook
    _hook = hook


def speaker_hint(
    name: str,
    *,
    ordinal: int | None = None,
    participant_identity: str = "",
    text: str = "",
) -> str:
    """Label for one line from a shared mic.

    The hook wins when it returns a non-empty label. Otherwise the line is
    ``"<name>'s room · speaker N"`` with N defaulting to 1 — we cannot tell
    the voices apart until the hook can.
    """
    hook = _hook
    if hook is not None:
        try:
            label = hook.identify(
                participant_identity=participant_identity,
                participant_name=name,
                text=text,
            )
        except Exception:
            logger.debug("diarization_hook_failed", exc_info=True)
            label = None
        if isinstance(label, str) and label.strip():
            return label.strip()
    who = (name or "").strip() or "This room"
    n = ordinal if isinstance(ordinal, int) and ordinal > 0 else 1
    return f"{who}'s room · speaker {n}"
