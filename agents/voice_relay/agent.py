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

EARS (added 2026-08-28). The relay carries the human's SPOKEN words back into
the room as their own message, so the brain on the Mac can answer them: speak
→ your line lands in the room → the runner sees it and Rook replies → the
relay says the reply aloud.

It listens TWO ways, and needs only one of them to work:

  * ITS OWN STT, over the human's audio track. This is the reliable ear.
  * The browser's ``transcript`` data packets, when they happen to be there.

WHAT IT DOES WITH WHAT IT HEARS. Everything goes to the LIVE TRANSCRIPT, which
is ephemeral and is where speech belongs — and which the relay has to publish
itself, because Stable disables browser captions whenever a specific mic is
selected, leaving the transcript panel empty on any real rig. Only a line
ADDRESSED TO THE AGENT becomes a chat message. Persisting every spoken
sentence turned a private conversation into a wall of chat nobody asked for.

The browser path alone was not enough, and the reason is worth writing down:
Stable deliberately DISABLES browser captions whenever the caller picks a
specific microphone (VoiceProvider: "Web Speech opens a second, browser-owned
microphone and exposes no deviceId constraint") — rather than secretly
recording the OS default. Anyone who has chosen an input, which is everyone
running a real rig, therefore publishes no captions at all, and a relay that
depended on them was deaf exactly for the people most likely to use it. Its
own STT has no such dependency, and also works in browsers with no Web Speech
API at all.

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
from agent_runtime.transcript_publisher import (
    TranscriptPublisher,
    VoiceHistoryPersister,
)
from agent_runtime.voice_dispatch import spoken_name_match
from agent_runtime.voice_transcripts import (
    TranscriptAggregator,
    classify_transcript,
    is_agent_identity,
    mention_needles,
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

#: Hard ceiling on waiting for one line's playout, whatever its length.
PLAYOUT_TIMEOUT_S = 45.0

#: Characters of speech per second, measured against Kokoro output. Used to
#: estimate how long a line takes to say.
SPEECH_CHARS_PER_SECOND = 13.0

#: Slack added to the estimate before giving up on the playout signal.
PLAYOUT_GRACE_S = 3.0


def playout_budget(text: str) -> float:
    """How long to wait for one line to finish playing.

    MEASURED, not guessed at 45 s: the playout handle on this deployment does
    not resolve — a 22-character reply sat until the ceiling — so waiting on it
    alone serialises speech at one line per timeout, which is not a
    conversation. Estimating from length gives the queue a truthful pace: the
    handle is still awaited and still wins when it resolves early, but a line
    that has certainly finished stops holding the floor.
    """
    seconds = len(text or "") / SPEECH_CHARS_PER_SECOND + PLAYOUT_GRACE_S
    return max(PLAYOUT_GRACE_S, min(seconds, PLAYOUT_TIMEOUT_S))

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


_UUID_TAIL = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def human_identity(candidate: Any) -> str | None:
    """A LiveKit identity the backend will accept as a human speaker.

    ``internal/voice-user-message`` reads the participant UUID off the tail of
    ``username_<uuid>`` and 400s on anything else. Handing it an agent identity
    — which is what the generic resolver falls back to when the STT reports no
    speaker_id — rejects every line, silently, because the post is
    fire-and-forget. So the shape is checked HERE, where it can be rejected
    loudly instead.
    """
    identity = str(candidate or "").strip()
    if not identity or is_agent_identity(identity):
        return None
    tail = identity.rsplit("_", 1)[-1]
    return identity if _UUID_TAIL.match(tail.lower()) else None


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
        self._publisher: VoiceHistoryPersister | None = None
        self._captions: TranscriptPublisher | None = None
        self._my_names: set[str] = set()
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
        agent_kwargs: dict[str, Any] = {"instructions": "", "tts": tts_plugin}
        # Its own ears. Wrapped the way the Brigade path wraps them: a
        # non-streaming STT that errors repeatedly can otherwise close the
        # whole AgentSession, which would take the MOUTH down with it.
        try:
            from plugins.stt import get_stt_plugin

            stt_plugin = get_stt_plugin()
            try:
                from agent_runtime.resilient_stt import NeverFatalSTT

                if not stt_plugin.capabilities.streaming:
                    stt_plugin = NeverFatalSTT(stt_plugin)
            except Exception:
                logger.debug("relay_stt_resilience_unavailable", exc_info=True)
            agent_kwargs["stt"] = stt_plugin
            try:
                from livekit.plugins import silero

                agent_kwargs["vad"] = silero.VAD.load()
            except Exception:
                logger.warning("relay_vad_unavailable", exc_info=True)
        except Exception:
            # No ears is survivable — the relay still speaks, and the browser
            # caption path still feeds it when captions are running.
            logger.warning("relay_stt_unavailable", exc_info=True)

        agent = Agent(**agent_kwargs)
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
        # VoiceHistoryPersister, not TranscriptPublisher: the two live in the
        # same module and only the former can write a human's turn back to the
        # room. Picking the class by filename is how the first attempt shipped
        # an AttributeError that the loop swallowed.
        def _linked_participant() -> Any:
            """The human this session is listening to.

            resolve_human() falls back to this when the STT gives no
            speaker_id, which is the normal case for a non-diarizing engine.
            Without it a heard line has no attributable speaker and is dropped
            on the floor — the relay hears you and writes nothing, which is
            exactly how it failed live in #aaron-shafen-claudes.
            """
            room_io = getattr(session, "room_io", None)
            return getattr(room_io, "linked_participant", None)

        # Live captions. The browser normally publishes these, but Stable turns
        # its captions OFF whenever the caller selects a specific microphone,
        # so on a real rig the transcript panel is empty. The relay is already
        # transcribing that audio, so it fills the gap.
        self._captions = TranscriptPublisher(
            room=ctx.room,
            agent_identity=self._identity or self._source_username,
            agent_name=self._relay_persona,
            linked_participant_getter=_linked_participant,
        )
        self._my_names = mention_needles(self._relay_persona, None) | {
            (self._relay_persona or "").replace("-", " ").lower()
        }
        self._publisher = VoiceHistoryPersister(
            room=ctx.room,
            livekit_room_name=ctx.room.name,
            brigade_agent_id=self._relay_persona,
            linked_participant_getter=_linked_participant,
        )
        self._ears_task = asyncio.create_task(
            self._ears_loop(), name=f"voice-relay-ears:{self._relay_persona}"
        )
        # Our own STT's finals. VoiceHistoryPersister.on_user_transcript is
        # built for exactly this event and resolves the speaker itself.
        try:
            session.on("user_input_transcribed", self._on_own_stt)
        except Exception:
            logger.warning("relay_stt_listener_failed", exc_info=True)
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

    def _on_own_stt(self, ev: Any) -> None:
        """A final from the relay's OWN STT. Sync; must never raise."""
        try:
            if self._publisher is None:
                return
            if not sole_agent_in_call(self._lk_room, self._identity):
                return
            text = (getattr(ev, "transcript", "") or "").strip()
            if not bool(getattr(ev, "is_final", False)) or not text:
                return
            # Dedupe against the browser-caption path: whichever ear reports an
            # utterance first wins, so a person running captions AND our STT
            # does not get every sentence written to the room twice.
            key = f"stt:{text.lower()}"
            if key in self._heard_segments:
                return
            self._heard_segments.add(key)
            speaker = self._speaker_identity(ev)
            if speaker is None:
                logger.warning(
                    "voice_relay_heard_but_unattributed",
                    chars=len(text),
                    preview=text[:60],
                    note="no human identity for this utterance; dropped",
                )
                return

            # EVERYTHING heard goes to the LIVE TRANSCRIPT. Ephemeral, which is
            # what a transcript is.
            if self._captions is not None:
                try:
                    self._captions.on_user_transcript(ev)
                except Exception:
                    logger.debug("voice_relay_caption_publish_failed", exc_info=True)

            # ONLY what is ADDRESSED TO US becomes a chat message. Writing every
            # spoken sentence into the room turned a private conversation into a
            # wall of chat nobody asked for — speech belongs in the transcript;
            # the chat log is for things said TO the agent.
            addressed = spoken_name_match(text, self._my_names)
            if not addressed:
                logger.debug(
                    "voice_relay_heard_not_addressed", chars=len(text)
                )
                return

            self._publisher.persist_user_utterance(speaker, text)
            logger.info(
                "voice_relay_heard_addressed",
                speaker=speaker,
                chars=len(text),
                preview=text[:80],
            )
        except Exception:
            logger.warning("voice_relay_own_stt_failed", exc_info=True)

    def _speaker_identity(self, ev: Any) -> str | None:
        """Whose voice this was, in the form the backend accepts.

        Tried in order: what the STT said, the participant this session is
        listening to, and — only when there is exactly one — the single human
        in the call. Ambiguity yields None rather than a guess: attributing
        Shafen's sentence to Aaron is worse than dropping it.
        """
        direct = human_identity(getattr(ev, "speaker_id", None))
        if direct:
            return direct
        session = self._session
        room_io = getattr(session, "room_io", None) if session else None
        linked = human_identity(
            getattr(getattr(room_io, "linked_participant", None), "identity", None)
        )
        if linked:
            return linked
        humans: list[str] = []
        try:
            for participant in getattr(self._lk_room, "remote_participants", {}).values():
                candidate = human_identity(getattr(participant, "identity", None))
                if candidate:
                    humans.append(candidate)
        except Exception:
            return None
        return humans[0] if len(humans) == 1 else None

    def _on_transcript(self, payload: dict[str, Any]) -> None:
        """One caption frame from the browser. Sync; never raises."""
        if self._transcripts is None:
            return
        verdict, normalized = classify_transcript(payload)
        if verdict != "final" or not normalized:
            return
        segment = str(normalized.get("segment_id") or "")
        text_key = f"stt:{str(normalized.get('text') or '').strip().lower()}"
        if (segment and segment in self._heard_segments) or text_key in self._heard_segments:
            return  # replay, or our own STT already reported this utterance
        self._heard_segments.add(text_key)
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
                    # BOUNDED. The wait exists to serialise speech, not to
                    # guarantee it: a playout handle that never resolves would
                    # hold the queue forever and every later line would be lost
                    # in silence — a worse failure than one line overlapping.
                    # Observed 69s for a 67-character line in a synthetic call,
                    # so the ceiling is generous but real.
                    budget = playout_budget(text)
                    try:
                        await asyncio.wait_for(out, timeout=budget)
                    except asyncio.TimeoutError:
                        # Expected on this deployment; the audio was handed to
                        # the session long ago. Debug, not warning — a line per
                        # reply at warning level is noise that hides real faults.
                        logger.debug(
                            "voice_relay_playout_wait_elapsed",
                            chars=len(text),
                            seconds=round(budget, 1),
                        )
                break
        logger.info("voice_relay_spoke", chars=len(text))

    async def _shutdown_steps(self) -> None:  # pragma: no cover — lifecycle
        for task in (self._speaker_task, self._ears_task):
            if task is not None and not task.done():
                task.cancel()
        await super()._shutdown_steps()
