"""Barge-in for the Brigade lane.

The relay already stops ``session.say`` when a human talks over it and drops
the chunks after that boundary. This is the same latch for Brigade: a
non-empty human final while the agent is speaking interrupts the handle in
flight, and a chunked ``say`` does not speak what is left.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

import structlog

from agent_runtime.spoken_text import is_unvoiced_ack

logger = structlog.get_logger(__name__)


class _Silent:
    """A speech handle that is already finished. Used when we refuse to speak."""

    def interrupt(self) -> None:
        return None

    async def wait_for_playout(self) -> None:
        return None


class BargeIn:
    """Latch around one agent's spoken turn."""

    def __init__(self) -> None:
        self.speaking = False
        self.barge = False
        self.handle: Any = None
        self.dropped: list[str] = []
        self._task: asyncio.Task[None] | None = None

    def note_state(self, state: str) -> None:
        """AgentSession ``agent_state_changed``. Listening/idle ends the turn."""
        self.speaking = state == "speaking"
        if state in ("listening", "idle"):
            self.barge = False
            self.handle = None

    def note_handle(self, handle: Any) -> None:
        self.handle = handle
        self.speaking = True

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

    def on_human_final(self, text: str) -> bool:
        """Interrupt if we are speaking and the human said something.

        Empty finals (a VAD blip, a blank STT result) do not take the floor.
        Returns True when a turn was actually interrupted.
        """
        if not (text or "").strip():
            return False
        if not self.speaking and self.handle is None:
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
            handle = original(chunks[0], *args, **kwargs)
            barge.note_handle(handle)
            return handle
        barge.speaking = True
        return barge

    session.say = say
