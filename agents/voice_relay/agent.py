"""Voice relay — speaks another participant's TEXT messages into a live call.

WHY THIS EXISTS. Rook is Aaron's Claude Code seat: it runs on his Mac against
his own subscription, reaches Stable over the gateway API, and answers in
text. That is the whole point of it — the brain is Claude Code, with his
memory and his tools, not a model we host. The cost of that design is that
Rook has no audio path, so in a call it is silent and Aaron has to read.

The obvious shortcut — register Rook as a Brigade agent so the existing voice
worker handles it — would make it talk tonight and would not be Rook: the
answers would come from Brigade's model. This worker takes the other road. It
brings no brain at all. It joins the call, watches for messages written by a
named participant, and says them aloud in that participant's voice. The brain
stays on the Mac; only the mouth lives here.

HOW IT WORKS. Every message persisted in a room is already broadcast into the
room's LiveKit session as a data packet (message_service: ``{"type":
"new_message", "message": {..., "sender": {...}}}``). So the relay needs no
polling, no API credential and no database access: it subscribes to the room
it was dispatched into and reacts to packets whose sender matches the source
it was configured with.

CONFIGURATION comes from the room's metadata, read at dispatch:
  * ``voice_relay_source``  — the participant USERNAME whose messages to
    speak (default ``agent-claude-code``, Rook's seat).
  * ``voice_relay_agent_id`` — the persona whose Kokoro voice to use (default
    ``rook`` → ``am_echo`` via KOKORO_VOICE_PRESETS).

EARS (added 2026-08-28). The relay also carries the human's SPOKEN words back
into the room as their own message, so the brain on the Mac can answer them.
The browser already publishes committed captions as ``transcript`` data
messages; the relay groups them and persists each finished utterance through
the same ``internal/voice-user-message`` endpoint the Brigade voice path uses.
That closes the loop with no new machinery: speak → your line lands in the
room → the runner sees it and Rook replies → the relay says the reply aloud.

⚠️ EARS ARE ONLY OPENED WHEN THIS IS THE SOLE AGENT IN THE CALL. A Brigade
voice worker persists the same utterances itself, so a second writer would
double every line the human says. Sole-agent is also exactly the case the
feature is for: one human, one agent, just talk.

WHAT IT DELIBERATELY DOES NOT DO. No LLM, no turn-taking, and it never
generates a word of its own — so it cannot hallucinate, cannot be prompt-
injected into saying something Rook did not write, and cannot pile onto a
conversation. It transports words; it does not author them.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

import structlog

from agent_runtime.base import StableAgent
from agent_runtime.transcript_publisher import TranscriptPublisher
from agent_runtime.voice_transcripts import (
    TranscriptAggregator,
    classify_transcript,
    is_agent_identity,
)

logger = structlog.get_logger(__name__)

#: Rook's seat. The participant username, not the display name — display names
#: are user-editable and would make the binding drift.
DEFAULT_SOURCE_USERNAME = "agent-claude-code"

#: Persona key for the voice preset (KOKORO_VOICE_PRESETS["rook"] == am_echo).
DEFAULT_RELAY_PERSONA = "rook"

#: A spoken line longer than this is truncated. A relay reading a 4000-word
#: report aloud holds the floor for ten minutes with no way to interrupt it,
#: which on a recorded show is worse than saying nothing.
MAX_SPOKEN_CHARS = 900

_CODE_FENCE = re.compile(r"```.*?```", re.S)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.M)
_BULLET = re.compile(r"^\s*[-*+]\s+", re.M)
_EMPHASIS = re.compile(r"(\*\*|__|\*|_)")
_URL = re.compile(r"https?://\S+")
_WS = re.compile(r"\s+")


def speakable(text: str, *, limit: int = MAX_SPOKEN_CHARS) -> str:
    """Turn a chat message into something worth hearing.

    Chat text is written to be READ: fenced code, links, bullets, bold markers.
    Read aloud verbatim it becomes "backtick backtick backtick python" and a
    URL spelled character by character. This strips the writing-for-the-eye
    layer and keeps the words.

    A code block is replaced by a short spoken marker rather than dropped
    silently — "he said nothing" and "he pasted forty lines of Python" are
    different events and the listener should be able to tell them apart.
    """
    if not text:
        return ""
    out = _CODE_FENCE.sub(" (code block) ", text)
    out = _INLINE_CODE.sub(r"\1", out)
    out = _LINK.sub(r"\1", out)
    out = _URL.sub(" (link) ", out)
    out = _HEADING.sub("", out)
    out = _BULLET.sub("", out)
    out = _EMPHASIS.sub("", out)
    out = _WS.sub(" ", out).strip()
    if len(out) > limit:
        # Cut at a sentence boundary when one is near the limit, so the relay
        # stops on a full thought instead of mid-word.
        window = out[:limit]
        cut = max(window.rfind(". "), window.rfind("? "), window.rfind("! "))
        out = (window[: cut + 1] if cut > limit * 0.6 else window).rstrip()
        out += " …the rest is in the chat."
    return out


def relay_config_from_metadata(metadata: Any) -> tuple[str, str]:
    """(source_username, relay_persona) from room/job metadata.

    Accepts the raw JSON string LiveKit carries or an already-parsed dict, and
    falls back to the Rook defaults for anything missing or malformed — a
    relay that refuses to start because a key is absent is a relay that is
    silent on show night for a reason nobody can see.
    """
    data: Any = metadata
    if isinstance(metadata, str):
        try:
            data = json.loads(metadata) if metadata.strip() else {}
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    source = data.get("voice_relay_source")
    persona = data.get("voice_relay_agent_id")
    return (
        source.strip() if isinstance(source, str) and source.strip() else DEFAULT_SOURCE_USERNAME,
        persona.strip() if isinstance(persona, str) and persona.strip() else DEFAULT_RELAY_PERSONA,
    )


def should_speak(payload: Any, source_username: str) -> str | None:
    """The text to speak from one data packet, or None.

    Returns None for everything that is not a fresh, visible, non-empty
    message from the configured source. Deleted messages are skipped: a line
    the author retracted must not still be read aloud.
    """
    if not isinstance(payload, dict):
        return None
    if payload.get("type") != "new_message":
        return None
    message = payload.get("message")
    if not isinstance(message, dict) or message.get("is_deleted"):
        return None
    sender = message.get("sender")
    if not isinstance(sender, dict):
        return None
    if (sender.get("username") or "").strip() != source_username:
        return None
    content = message.get("content")
    if not isinstance(content, str):
        return None
    spoken = speakable(content)
    return spoken or None


def sole_agent_in_call(room: Any, self_identity: str) -> bool:
    """True when no OTHER agent worker is in this call.

    The ears only open in that case. A Brigade voice worker persists the same
    human utterances itself, so a second writer would double every line the
    person says — and a doubled question gets answered twice.
    """
    try:
        remotes = list(getattr(room, "remote_participants", {}).values())
    except Exception:
        return False
    for participant in remotes:
        identity = str(getattr(participant, "identity", "") or "")
        if identity and identity != self_identity and is_agent_identity(identity):
            return False
    return True


class VoiceRelayAgent(StableAgent):
    """Joins a call and speaks one participant's messages. No brain attached."""

    agent_type = "relay"

    @staticmethod
    def _clock() -> float:
        import time as _time

        return _time.monotonic()

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._source_username = DEFAULT_SOURCE_USERNAME
        self._relay_persona = DEFAULT_RELAY_PERSONA
        self._session: Any = None
        self._spoken_ids: set[str] = set()
        self._heard_segments: set[str] = set()
        self._transcripts: TranscriptAggregator | None = None
        self._publisher: TranscriptPublisher | None = None
        self._ears_task: asyncio.Task[None] | None = None
        # The live LiveKit room handle. The base class keeps the room NAME and
        # id, not the object, so the relay holds its own reference — reaching
        # for a `self._room` that never existed is what made the ears throw on
        # every drain until a live call proved it.
        self._lk_room: Any = None
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._speaker_task: asyncio.Task[None] | None = None

    async def build_pipeline(self, ctx: Any) -> Any:
        """A session with a MOUTH ONLY — TTS, no LLM, no STT, no VAD."""
        from livekit.agents import Agent, AgentSession

        from plugins.tts import get_tts_plugin

        room_meta = getattr(ctx.room, "metadata", "") or ""
        job_meta = getattr(getattr(ctx, "job", None), "metadata", "") or ""
        # Job metadata is this dispatch's own truth; room metadata is shared
        # state a later dispatch overwrites — same precedence the registry uses
        # to resolve an agent's persona.
        source, persona = relay_config_from_metadata(job_meta)
        if source == DEFAULT_SOURCE_USERNAME and persona == DEFAULT_RELAY_PERSONA:
            source, persona = relay_config_from_metadata(room_meta)
        self._source_username, self._relay_persona = source, persona

        tts_plugin = get_tts_plugin(personality=self._relay_persona)
        agent = Agent(instructions="", tts=tts_plugin)
        session = AgentSession()
        await session.start(agent=agent, room=ctx.room)
        self._session = session

        ctx.room.on("data_received", self._on_data)
        self._speaker_task = asyncio.create_task(
            self._speak_loop(), name=f"voice-relay-speaker:{self._relay_persona}"
        )
        # Ears: carry the human's spoken words into the room so the brain on
        # the Mac can answer them. Only when nothing else is already doing it.
        self._lk_room = ctx.room
        self._transcripts = TranscriptAggregator()
        self._publisher = TranscriptPublisher(
            room=ctx.room,
            agent_identity=self._identity or self._source_username,
            agent_name=self._relay_persona,
        )
        self._ears_task = asyncio.create_task(
            self._ears_loop(), name=f"voice-relay-ears:{self._relay_persona}"
        )
        logger.info(
            "voice_relay_started",
            room=getattr(ctx.room, "name", ""),
            source=self._source_username,
            persona=self._relay_persona,
        )
        return session

    # ------------------------------------------------------------------ #
    # Inputs
    # ------------------------------------------------------------------ #

    def _on_data(self, packet: Any) -> None:
        """LiveKit data callback. Sync, and must never raise into the SFU loop."""
        try:
            raw = getattr(packet, "data", packet)
            if isinstance(raw, (bytes, bytearray)):
                raw = raw.decode("utf-8", "replace")
            payload = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(payload, dict) and payload.get("type") == "transcript":
                self._on_transcript(payload)
                return
            spoken = should_speak(payload, self._source_username)
            if spoken is None:
                return
            message_id = str((payload.get("message") or {}).get("id") or "")
            # The same message can arrive twice (reconnect replay); saying it
            # twice is the kind of thing an audience notices immediately.
            if message_id and message_id in self._spoken_ids:
                return
            if message_id:
                self._spoken_ids.add(message_id)
            self._queue.put_nowait(spoken)
            logger.info(
                "voice_relay_queued",
                message_id=message_id[:8],
                chars=len(spoken),
                depth=self._queue.qsize(),
            )
        except Exception:
            logger.warning("voice_relay_data_failed", exc_info=True)

    def _on_transcript(self, payload: dict[str, Any]) -> None:
        """One caption frame from the browser. Sync; never raises."""
        if self._transcripts is None:
            return
        verdict, normalized = classify_transcript(payload)
        if verdict != "final" or not normalized:
            return
        segment = str(normalized.get("segment_id") or "")
        if segment and segment in self._heard_segments:
            return  # replayed frame; saying it twice would ask twice
        if segment:
            self._heard_segments.add(segment)
        try:
            self._transcripts.ingest(payload, now=self._clock())
        except Exception:
            logger.debug("voice_relay_transcript_ingest_failed", exc_info=True)

    async def _ears_loop(self) -> None:
        """Drain finished utterances and persist each as the speaker's message."""
        while True:
            try:
                await asyncio.sleep(0.4)
                if self._transcripts is None or self._publisher is None:
                    continue
                due = self._transcripts.pop_due(now=self._clock())
                if not due:
                    continue
                if self._lk_room is None:
                    continue
                if not sole_agent_in_call(self._lk_room, self._identity):
                    # Another agent owns the human's words in this room.
                    logger.info(
                        "voice_relay_ears_stood_down",
                        utterances=len(due),
                        reason="another agent is in the call",
                    )
                    continue
                for utterance in due:
                    self._publisher.persist_user_utterance(
                        utterance.participant_id, utterance.text
                    )
                    logger.info(
                        "voice_relay_heard",
                        speaker=utterance.participant_id,
                        chars=len(utterance.text),
                        preview=utterance.text[:80],
                    )
            except asyncio.CancelledError:
                return
            except Exception:
                logger.warning("voice_relay_ears_failed", exc_info=True)

    async def _speak_loop(self) -> None:
        """Speak queued lines one at a time.

        Serialised deliberately: two overlapping ``say`` calls would talk over
        each other in the same voice, which is unintelligible rather than
        merely untidy.
        """
        while True:
            try:
                text = await self._queue.get()
            except asyncio.CancelledError:
                return
            try:
                await self._say(text)
            except asyncio.CancelledError:
                return
            except Exception:
                logger.error("voice_relay_say_failed", exc_info=True)

    async def _say(self, text: str) -> None:
        session = self._session
        if session is None:
            return
        result = session.say(text)
        # Version-tolerant across livekit-agents 1.x: say() may return a
        # SpeechHandle, an awaitable, or an awaitable resolving to a handle.
        if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
            result = await result
        for waiter_name in ("wait_for_playout", "join"):
            waiter = getattr(result, waiter_name, None)
            if callable(waiter):
                out = waiter()
                if asyncio.iscoroutine(out) or isinstance(out, asyncio.Future):
                    await out
                break
        logger.info("voice_relay_spoke", chars=len(text))

    async def _shutdown_steps(self) -> None:  # pragma: no cover — lifecycle
        for task in (self._speaker_task, self._ears_task):
            if task is not None and not task.done():
                task.cancel()
        await super()._shutdown_steps()
