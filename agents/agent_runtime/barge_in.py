"""Barge-in for the Brigade lane.

The relay already stops ``session.say`` when a human talks over it and drops
the chunks after that boundary. This is the same latch for Brigade: a
non-empty human final while the agent is speaking interrupts the handle in
flight, and a chunked ``say`` does not speak what is left.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import unicodedata
from collections import deque
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Callable

import structlog

from agent_runtime.spoken_text import is_unvoiced_ack

logger = structlog.get_logger(__name__)


# These are deliberately small, deterministic gates. A one-word recognition
# is commonly a VAD/STT fragment, while a copied phrase from the relay's own
# output is the speaker hearing the room, not a human taking the floor.
DEFAULT_BARGE_IN_MIN_WORDS = 2
DEFAULT_BARGE_IN_MIN_DURATION_S = 0.6
DEFAULT_BARGE_IN_ECHO_WINDOW_S = 8.0
BARGE_IN_ECHO_THRESHOLD = 0.8

_MIN_WORDS_ENV = "VOICE_BARGE_IN_MIN_WORDS"
_MIN_DURATION_ENV = "VOICE_BARGE_IN_MIN_DURATION_MS"
_ECHO_WINDOW_ENV = "VOICE_BARGE_IN_ECHO_WINDOW_SECONDS"
_WORDS = re.compile(r"[^\w\s']+", re.UNICODE)


def _env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if value != value or value == float("inf") or value == float("-inf"):
        return default
    return max(minimum, value)


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(minimum, value)


def normalize_transcript(text: str) -> tuple[str, ...]:
    """Return lower-case STT tokens with punctuation and spacing normalised."""
    cleaned = unicodedata.normalize("NFKC", text or "").lower()
    cleaned = _WORDS.sub(" ", cleaned).replace("_", " ")
    return tuple(part for part in cleaned.split() if part)


def token_set_ratio(left: str | tuple[str, ...], right: str | tuple[str, ...]) -> float:
    """A dependency-free token-set similarity in the range 0.0–1.0.

    The set component tolerates punctuation and repeated words; the sequence
    component catches small STT edits such as ``short`` → ``shrt`` without
    treating one unrelated shared stop word as an echo.
    """
    left_tokens = normalize_transcript(left) if isinstance(left, str) else left
    right_tokens = normalize_transcript(right) if isinstance(right, str) else right
    if not left_tokens or not right_tokens:
        return 0.0
    left_set, right_set = set(left_tokens), set(right_tokens)
    union = left_set | right_set
    jaccard = len(left_set & right_set) / len(union) if union else 0.0
    sequence = SequenceMatcher(
        None, " ".join(left_tokens), " ".join(right_tokens)
    ).ratio()
    return max(jaccard, sequence)


def echo_match_score(
    candidate: str,
    spoken: str | tuple[str, ...],
    *,
    threshold: float = BARGE_IN_ECHO_THRESHOLD,
) -> float | None:
    """Best fuzzy score when ``candidate`` is a phrase in ``spoken``.

    Matching contiguous windows makes the test a suffix/substring check rather
    than a whole-reply comparison. A one-token size cushion handles STT adding
    or dropping a small filler around an otherwise copied phrase.
    """
    candidate_tokens = normalize_transcript(candidate)
    spoken_tokens = normalize_transcript(spoken) if isinstance(spoken, str) else spoken
    if not candidate_tokens or not spoken_tokens:
        return None
    width = len(candidate_tokens)
    best = 0.0
    min_width = max(1, width - 1)
    max_width = min(len(spoken_tokens), width + 2)
    for start in range(len(spoken_tokens)):
        for end in range(start + min_width, min(len(spoken_tokens), start + max_width) + 1):
            score = token_set_ratio(candidate_tokens, spoken_tokens[start:end])
            best = max(best, score)
    return best if best >= threshold else None


def transcript_duration_seconds(event: Any) -> float | None:
    """Read an optional STT speech duration without depending on one SDK type."""
    if event is None:
        return None
    getter = event.get if isinstance(event, dict) else lambda key, default=None: getattr(event, key, default)
    for key in ("speech_duration_s", "duration_s", "speech_duration", "duration"):
        raw = getter(key)
        if raw is None or raw == "":
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value >= 0:
            # SDKs that expose a field named duration usually use seconds. A
            # separate duration_ms spelling is handled below.
            return value
    raw_ms = getter("speech_duration_ms")
    if raw_ms is not None and raw_ms != "":
        try:
            value = float(raw_ms)
        except (TypeError, ValueError):
            return None
        return value / 1000.0 if value >= 0 else None
    return None


def transcript_is_short(
    text: str,
    *,
    duration_s: float | None = None,
    min_words: int | None = None,
    min_duration_s: float | None = None,
) -> bool:
    """Whether a transcript is below the configured barge-in minimum."""
    words = _env_int(_MIN_WORDS_ENV, DEFAULT_BARGE_IN_MIN_WORDS, minimum=0)
    if min_words is not None:
        words = max(0, int(min_words))
    if len(normalize_transcript(text)) < words:
        return True
    duration = _env_float(
        _MIN_DURATION_ENV,
        DEFAULT_BARGE_IN_MIN_DURATION_S * 1000.0,
        minimum=0.0,
    ) / 1000.0
    if min_duration_s is not None:
        duration = max(0.0, float(min_duration_s))
    return duration_s is not None and duration_s < duration


@dataclass(frozen=True)
class BargeInCheck:
    """The deterministic result for one human transcript while speaking."""

    reason: str | None = None
    score: float | None = None


class TranscriptEchoGuard:
    """Keep recent relay speech and classify a possible human interruption."""

    def __init__(
        self,
        *,
        min_words: int | None = None,
        min_duration_s: float | None = None,
        echo_window_s: float | None = None,
        threshold: float = BARGE_IN_ECHO_THRESHOLD,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.min_words = (
            _env_int(_MIN_WORDS_ENV, DEFAULT_BARGE_IN_MIN_WORDS, minimum=0)
            if min_words is None
            else max(0, int(min_words))
        )
        self.min_duration_s = (
            _env_float(
                _MIN_DURATION_ENV,
                DEFAULT_BARGE_IN_MIN_DURATION_S * 1000.0,
                minimum=0.0,
            )
            / 1000.0
            if min_duration_s is None
            else max(0.0, float(min_duration_s))
        )
        self.echo_window_s = (
            _env_float(_ECHO_WINDOW_ENV, DEFAULT_BARGE_IN_ECHO_WINDOW_S, minimum=0.0)
            if echo_window_s is None
            else max(0.0, float(echo_window_s))
        )
        self.threshold = max(0.0, min(1.0, float(threshold)))
        self._clock = clock
        self._spoken: deque[tuple[float, tuple[str, ...]]] = deque()

    def _prune(self, now: float) -> None:
        cutoff = now - self.echo_window_s
        while self._spoken and self._spoken[0][0] < cutoff:
            self._spoken.popleft()

    def note_spoken(self, text: str, *, now: float | None = None) -> None:
        tokens = normalize_transcript(text)
        if not tokens:
            return
        at = self._clock() if now is None else now
        self._prune(at)
        self._spoken.append((at, tokens))

    def recent_spoken_tokens(self, *, now: float | None = None) -> tuple[str, ...]:
        at = self._clock() if now is None else now
        self._prune(at)
        return tuple(token for _, tokens in self._spoken for token in tokens)

    def match_score(self, text: str, *, now: float | None = None) -> float | None:
        return echo_match_score(
            text,
            self.recent_spoken_tokens(now=now),
            threshold=self.threshold,
        )

    def check(
        self,
        text: str,
        *,
        duration_s: float | None = None,
        now: float | None = None,
    ) -> BargeInCheck:
        score = self.match_score(text, now=now)
        if score is not None:
            return BargeInCheck(reason="echo", score=score)
        if transcript_is_short(
            text,
            duration_s=duration_s,
            min_words=self.min_words,
            min_duration_s=self.min_duration_s,
        ):
            return BargeInCheck(reason="short")
        return BargeInCheck()


class _Silent:
    """A speech handle that is already finished. Used when we refuse to speak."""

    def interrupt(self) -> None:
        return None

    async def wait_for_playout(self) -> None:
        return None


class BargeIn:
    """Latch around one agent's spoken turn."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        echo_guard: TranscriptEchoGuard | None = None,
    ) -> None:
        self.speaking = False
        self.barge = False
        self.handle: Any = None
        self.dropped: list[str] = []
        self._task: asyncio.Task[None] | None = None
        self.enabled = bool(enabled)
        self.echo_guard = echo_guard or TranscriptEchoGuard()

    def note_state(self, state: str) -> None:
        """AgentSession ``agent_state_changed``. Listening/idle ends the turn."""
        self.speaking = state == "speaking"
        if state in ("listening", "idle"):
            self.barge = False
            self.handle = None

    def note_handle(self, handle: Any) -> None:
        self.handle = handle
        self.speaking = True

    def note_spoken(self, text: str) -> None:
        """Remember one chunk so a copy from the room cannot take the floor."""
        self.echo_guard.note_spoken(text)

    async def wait_for_playout(self) -> None:
        task = self._task
        if task is not None:
            await task

    def interrupt(self) -> None:
        self.barge = True
        handle = self.handle
        fn = getattr(handle, "interrupt", None)
        if not callable(fn):
            return
        try:
            fn()
        except Exception:
            logger.debug("brigade_barge_interrupt_failed", exc_info=True)

    def on_human_final(self, text: str, *, duration_s: float | None = None) -> bool:
        """Interrupt if we are speaking and the human said something.

        Empty finals (a VAD blip, a blank STT result) do not take the floor.
        Returns True when a turn was actually interrupted.
        """
        if not (text or "").strip():
            return False
        if not self.speaking and self.handle is None:
            return False
        check = self.echo_guard.check(text, duration_s=duration_s)
        if check.reason is not None:
            logger.debug(
                "barge_in_transcript_ignored",
                reason=check.reason,
                score=round(check.score, 3) if check.score is not None else None,
            )
            return False
        if not self.enabled:
            return False
        self.interrupt()
        return True

    async def say_chunks(self, say: Callable[..., Any], chunks: list[str]) -> int:
        """Speak ``chunks`` in order. A barge drops whatever has not started."""
        self.speaking = True
        self.barge = False
        self.dropped = []
        spoken = 0
        try:
            for index, chunk in enumerate(chunks):
                if self.barge:
                    self.dropped.extend(chunks[index:])
                    break
                self.note_spoken(chunk)
                result = say(chunk)
                if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
                    result = await result
                self.handle = result
                spoken += 1
                if self.barge:
                    self.dropped.extend(chunks[index + 1 :])
                    break
                waiter = getattr(result, "wait_for_playout", None) or getattr(
                    result, "join", None
                )
                if callable(waiter):
                    out = waiter()
                    if asyncio.iscoroutine(out) or isinstance(out, asyncio.Future):
                        await out
                if self.barge:
                    self.dropped.extend(chunks[index + 1 :])
                    break
            return spoken
        finally:
            self.speaking = False
            self.handle = None


def plan_spoken(text: str, limit: int) -> list[str] | None:
    """Chunks to say, or None when the line must not be voiced.

    ``limit`` <= 0 means unlimited (no "the rest is in the chat"). A positive
    limit truncates first, then splits on sentence boundaries so a barge can
    land between chunks.
    """
    from voice_relay.agent import chunk_spoken, speakable

    if is_unvoiced_ack(text):
        return None
    spoken = speakable(text, limit=0 if limit <= 0 else limit)
    if not spoken:
        return None
    return chunk_spoken(spoken) or [spoken]


def install_chunked_say(
    session: Any,
    barge: BargeIn,
    *,
    limit_of: Callable[[], int],
) -> None:
    """Wrap ``session.say`` so long replies chunk and acks are silent.

    The wrapper keeps the original call shape: one chunk returns that say's
    handle immediately; several chunks run on the loop and the returned
    object is the barge latch (``interrupt()`` drops the rest).
    """
    original = session.say

    def say(text: str = "", *args: Any, **kwargs: Any) -> Any:
        try:
            limit = int(limit_of() or 0)
        except Exception:
            limit = 0
        chunks = plan_spoken(str(text or ""), limit)
        if not chunks:
            logger.info("voice_ack_not_spoken", chars=len(text or ""))
            return _Silent()
        if len(chunks) == 1:
            barge.note_spoken(chunks[0])
            handle = original(chunks[0], *args, **kwargs)
            barge.note_handle(handle)
            return handle

        async def _run() -> None:
            await barge.say_chunks(lambda chunk: original(chunk, *args, **kwargs), chunks)

        try:
            barge._task = asyncio.get_running_loop().create_task(
                _run(), name="brigade-chunked-say"
            )
        except RuntimeError:
            barge.note_spoken(chunks[0])
            handle = original(chunks[0], *args, **kwargs)
            barge.note_handle(handle)
            return handle
        barge.speaking = True
        return barge

    session.say = say
