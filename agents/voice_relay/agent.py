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
  * ``voice_relay_voices`` — OPTIONAL, added 2026-09-01 for E04: a JSON
    object (or its JSON-encoded string, since LiveKit metadata is a string)
    mapping sender USERNAME → Kokoro voice id, e.g.
    ``{"agent-grok": "am_onyx", "agent-flow": "bm_lewis"}``. One relay then
    speaks for every sender in the map, each in its own voice, on top of the
    legacy single source above (which keeps the persona's voice). A voice id
    Kokoro does not serve is logged and falls back to the persona voice —
    never to silence. Absent, nothing changes.
  * ``voice_relay_video`` — OPTIONAL, added 2026-09-02, default off: publish
    a rendered puppet as this participant's CAMERA track (and each cast
    member's, below) so the agent shows up in the grid, on
    ``/broadcast/{room}/{identity}`` and in OBS like a human on a webcam.
    See agent_runtime/puppet_video.py.
  * ``voice_relay_multi`` — OPTIONAL, added 2026-09-02, default off: every
    OTHER sender in ``voice_relay_voices`` becomes its OWN participant
    (identity = the sender's username), hosted by this relay process, with
    its own audio track — so Grok's words leave Grok's tile, not Rook's.
    See voice_relay/cast.py. With both flags off, nothing below changes.

THE TALK GATE can name a TARGET (``talk_gate`` frame, ``target`` field, added
2026-09-01). A held pedal then addresses that agent rather than the relay's
own persona: the heard line is persisted as ``@<target> <text>`` so the named
gateway agent's poller sees a mention. No target, or the persona itself, is
the old behaviour.

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
from typing import Any, NamedTuple

import structlog

from agent_runtime.base import StableAgent
from agent_runtime.puppet_video import (
    PuppetVideo,
    build_spec,
    load_manifest,
    tap_audio_output,
)
from agent_runtime.transcript_publisher import (
    TranscriptPublisher,
    VoiceHistoryPersister,
)
from agent_runtime.voice_dispatch import (
    fuzzy_spoken_name_match,
    log_name_near_miss,
    spoken_name_match,
)
from agent_runtime.voice_transcripts import (
    TranscriptAggregator,
    classify_transcript,
    elected_user_captioner,
    is_agent_identity,
    is_cast_puppet,
    mention_needles,
)
from voice_relay.cast import CastMember, cast_identities

logger = structlog.get_logger(__name__)

#: Rook's seat. The participant username, not the display name — display names
#: are user-editable and would make the binding drift.
DEFAULT_SOURCE_USERNAME = "agent-claude-code"

#: Persona key for the voice preset (KOKORO_VOICE_PRESETS["rook"] == am_echo).
DEFAULT_RELAY_PERSONA = "rook"

#: How a spoken line is judged to be FOR the agent.
#:
#:   name   — address it by name ("Rook, …"). The safe default in any room
#:            with more than one person in it.
#:   window — a named line opens a sliding conversation window; follow-ups
#:            inside it need no wakeword, and side talk after it closes is
#:            ignored. This is the natural back-and-forth mode. The pedal
#:            is not required.
#:   always — every utterance is for the agent. Right for a room that is just
#:            you and it; wrong the moment someone else joins.
#:   ptt    — only while an external talk gate is held (a foot pedal, a stream
#:            deck, a phone button). Deterministic, which is what a live show
#:            wants: a spoken name can false-trigger on camera, a held pedal
#:            cannot.
#:   off    — never write to chat. Transcript only.
ACTIVATION_MODES = ("name", "window", "always", "ptt", "off")
DEFAULT_ACTIVATION = "name"

#: Sliding conversation window for ``window`` mode. 75s sits in the 60–90s
#: range Aaron asked for on 2026-08-30: long enough for a follow-up after a
#: reply, short enough that two humans talking after the window closes stay
#: off the agent's plate. Overridable per room via
#: ``voice_relay_window_seconds``.
DEFAULT_WINDOW_SECONDS = 75
MIN_WINDOW_SECONDS = 15
MAX_WINDOW_SECONDS = 300

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


def activation_from_metadata(metadata: Any) -> str:
    """How this room decides a spoken line is for the agent.

    Unknown or missing values fall back to ``name``: the conservative choice,
    because the failure mode of guessing wrong the other way is an agent that
    barges into a human conversation.
    """
    data: Any = metadata
    if isinstance(metadata, str):
        try:
            data = json.loads(metadata) if metadata.strip() else {}
        except Exception:
            data = {}
    if not isinstance(data, dict):
        return DEFAULT_ACTIVATION
    mode = data.get("voice_relay_activation")
    mode = mode.strip().lower() if isinstance(mode, str) else ""
    return mode if mode in ACTIVATION_MODES else DEFAULT_ACTIVATION


def clamp_window_seconds(value: Any) -> int:
    """Keep a window length inside the live range; junk becomes the default."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return DEFAULT_WINDOW_SECONDS
    return max(MIN_WINDOW_SECONDS, min(MAX_WINDOW_SECONDS, n))


def window_seconds_from_metadata(metadata: Any) -> int:
    """Per-room window length, or the 75s default."""
    data: Any = metadata
    if isinstance(metadata, str):
        try:
            data = json.loads(metadata) if metadata.strip() else {}
        except Exception:
            data = {}
    if not isinstance(data, dict):
        return DEFAULT_WINDOW_SECONDS
    raw = data.get("voice_relay_window_seconds")
    if raw is None or raw == "":
        return DEFAULT_WINDOW_SECONDS
    return clamp_window_seconds(raw)


#: Spoken-name aliases a persona ALWAYS answers to, on top of the room's
#: ``voice_relay_aliases``. Whisper's spellings of a name are not the name:
#: it ate a leading "Rook," twice on 2026-08-30, and a four-syllable Greek
#: name gets every vowel it can think of.
BUILTIN_ALIASES: dict[str, frozenset[str]] = {
    "rook": frozenset({"rookie"}),
    "claude-code": frozenset({"rookie"}),
    # Persephone — Aaron's main assistant seat (2026-09-03). The wake word is
    # "persephone" / "hey persephone"; these are the transcript forms seen or
    # expected from whisper for the same sound.
    "persephone": frozenset({
        "persephoné", "persefone", "persephony", "persephanie", "persephonie",
        "persephonee", "persaphone", "persephone's",
    }),
}


def aliases_from_metadata(metadata: Any, persona: str) -> set[str]:
    """Extra wakeword aliases. Rook always accepts 'rookie'; Persephone her
    whisper misspellings (BUILTIN_ALIASES)."""
    data: Any = metadata
    if isinstance(metadata, str):
        try:
            data = json.loads(metadata) if metadata.strip() else {}
        except Exception:
            data = {}
    out: set[str] = set(BUILTIN_ALIASES.get((persona or "").strip().lower(), ()))
    if not isinstance(data, dict):
        return out
    raw = data.get("voice_relay_aliases")
    if isinstance(raw, str):
        out.update(p.strip().lower() for p in raw.split(",") if p.strip())
    elif isinstance(raw, (list, tuple)):
        for item in raw:
            if isinstance(item, str) and item.strip():
                out.add(item.strip().lower())
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


def preset_voice(persona: str) -> str:
    """The Kokoro voice a persona speaks with — the table the session TTS reads."""
    from plugins.tts import _resolve_kokoro_voice

    return _resolve_kokoro_voice((persona or "").strip() or DEFAULT_RELAY_PERSONA, None)


def _metadata_dict(metadata: Any) -> dict[str, Any]:
    data: Any = metadata
    if isinstance(metadata, str):
        try:
            data = json.loads(metadata) if metadata.strip() else {}
        except Exception:
            data = {}
    return data if isinstance(data, dict) else {}


def relay_voices_from_metadata(
    metadata: Any, source_username: str, persona: str
) -> dict[str, str]:
    """sender username → Kokoro voice id, for every sender this relay speaks for.

    The legacy single source is always present, in the persona's voice, so a
    room with no ``voice_relay_voices`` key behaves exactly as before. The map
    may be a JSON object or its JSON-encoded string — LiveKit metadata is a
    string, and the server serialises the DB dict on the way in.

    A voice id the deployed Kokoro does not serve is REPLACED by the persona
    voice and logged (``voice_relay_voice_unknown``). The alternative — keep
    the id and let synthesis fail — is a sender who is silent on camera for a
    reason nobody in the room can see.
    """
    from plugins.tts import known_kokoro_voice

    fallback = preset_voice(persona)
    voices: dict[str, str] = {source_username: fallback}
    raw = _metadata_dict(metadata).get("voice_relay_voices")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip() else {}
        except Exception:
            logger.warning("voice_relay_voices_invalid", preview=raw[:80])
            raw = {}
    if raw is None:
        return voices
    if not isinstance(raw, dict):
        logger.warning("voice_relay_voices_invalid", got=type(raw).__name__)
        return voices
    for key, value in raw.items():
        sender = key.strip() if isinstance(key, str) else ""
        if not sender:
            continue
        voice = known_kokoro_voice(value)
        if voice is None:
            logger.warning(
                "voice_relay_voice_unknown",
                sender=sender,
                voice=str(value)[:32],
                fallback=fallback,
            )
            voice = fallback
        voices[sender] = voice
    return voices


_TRUE_WORDS = frozenset({"1", "true", "yes", "on"})


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in _TRUE_WORDS


RELAY_FLAG_KEYS = ("voice_relay_video", "voice_relay_multi")


def relay_flags_from_metadata(metadata: Any) -> dict[str, bool]:
    """``{"video": bool, "multi": bool}`` from room/job metadata. Both default
    OFF: a room that has not asked for faces gets exactly the relay it had."""
    data = _metadata_dict(metadata)
    return {
        "video": _truthy(data.get("voice_relay_video")),
        "multi": _truthy(data.get("voice_relay_multi")),
    }


def flags_present(metadata: Any) -> bool:
    """Does this metadata SAY anything about the flags? (Job metadata that is
    silent must not override a room that opted in.)"""
    data = _metadata_dict(metadata)
    return any(k in data for k in RELAY_FLAG_KEYS)


class SpokenLine(NamedTuple):
    """One line to say: which voice, what words, and whose they are."""

    voice: str
    text: str
    sender: str
    name: str


def sender_display_name(sender: dict[str, Any]) -> str:
    """The name a caption for this sender's words should carry."""
    name = sender.get("display_name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    username = str(sender.get("username") or "").strip()
    bare = username[6:] if username.startswith("agent-") else username
    return bare.replace("-", " ").replace("_", " ").title() or "Agent"


def _fresh_message(payload: Any) -> tuple[str, dict[str, Any]] | None:
    """(sender_username, message) for a fresh, visible message packet, else None."""
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
    return (sender.get("username") or "").strip(), message


def should_speak(payload: Any, source_username: str) -> str | None:
    """The text to speak from one data packet, or None.

    Returns None for everything that is not a fresh, visible, non-empty
    message from the configured source. Deleted messages are skipped: a line
    the author retracted must not still be read aloud.
    """
    fresh = _fresh_message(payload)
    if fresh is None:
        return None
    username, message = fresh
    if username != source_username:
        return None
    content = message.get("content")
    if not isinstance(content, str):
        return None
    spoken = speakable(content)
    return spoken or None


def should_speak_as(payload: Any, voices: dict[str, str]) -> SpokenLine | None:
    """The (voice, text, sender, name) to say for one packet, or None.

    Multi-sender form of ``should_speak``: any sender in ``voices`` is spoken,
    in that sender's voice. Same refusals — wrong packet type, deleted,
    unknown sender, nothing left once markup is stripped.
    """
    fresh = _fresh_message(payload)
    if fresh is None:
        return None
    username, message = fresh
    if not username or username not in voices:
        return None
    content = message.get("content")
    if not isinstance(content, str):
        return None
    spoken = speakable(content)
    if not spoken:
        return None
    sender = message.get("sender") if isinstance(message.get("sender"), dict) else {}
    return SpokenLine(
        voice=voices[username],
        text=spoken,
        sender=username,
        name=sender_display_name(sender),
    )


_TARGET_SHAPE = re.compile(r"^[A-Za-z0-9_.\-]{2,64}$")


def gate_target(raw: Any, persona: str, source_username: str) -> str | None:
    """The agent a held pedal addresses, or None for the relay's own persona.

    Anything that names the relay itself (its persona, its seat username, or
    either with/without the ``agent-`` prefix) collapses to None, so the old
    behaviour is exactly what an explicit "talk to Rook" produces. Junk that
    could not be a username is None too — a mention token is going into a
    persisted message, and it must be a mention the poller can resolve.
    """
    if not isinstance(raw, str):
        return None
    target = raw.strip()
    if not target or not _TARGET_SHAPE.match(target):
        return None
    persona = (persona or "").strip().lower()
    source = (source_username or "").strip().lower()
    bare_source = source[6:] if source.startswith("agent-") else source
    self_names = {persona, f"agent-{persona}", source, bare_source} - {""}
    return None if target.lower() in self_names else target


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


#: Utterances made ONLY of these carry no content worth a full agent turn.
#: Anything containing a single non-filler word ("yes", "no", "stop") passes.
_FILLER_TOKENS = frozenset(
    {
        "um", "uh", "mm", "hmm", "mhm", "hm", "ah", "er", "uhh", "umm",
        "like", "so", "well", "okay", "ok", "yeah", "right", "you", "know",
    }
)

_WORDS = re.compile(r"[a-z']+")


def filler_only(text: str) -> bool:
    """True when the utterance is nothing but conversational filler."""
    tokens = _WORDS.findall((text or "").lower())
    return bool(tokens) and all(t in _FILLER_TOKENS for t in tokens)


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
            # A cast puppet this relay hosts is a mouth, not another worker.
            if is_cast_puppet(participant):
                continue
            return False
    return True


async def _replay(frames: list[Any]) -> Any:
    """Hand pre-synthesised frames to ``say(audio=...)`` as the stream it wants."""
    for frame in frames:
        yield frame



def _unblock_audio_output(session: Any) -> None:
    """Let the mouth speak into a room nobody has (visibly) subscribed to yet.

    RoomIO's audio output gates its FIRST frame on the track publication's
    ``wait_for_subscription()``: ``capture_frame`` awaits an internal
    ``_subscribed_fut`` that resolves only when a visible participant
    subscribes to the relay's track. A relay's rooms routinely have no such
    subscriber — a measuring harness joins hidden, a browser subscribes late
    or selectively — and then the first ``say()`` wedges on frame one forever
    while the published track free-runs Opus-DTX comfort noise. That is the
    -107 dBFS "speech" of E03 night: every layer logged success and the wire
    carried silence.

    Measured 2026-09-01 in stable-build-in-public-e04: same room, same line,
    same voice went from peak 2/32767 (digital silence, playout never
    resolving) to peak 17586/32767 with 2910 ms voiced once this future was
    resolved up front. A broadcast relay must speak regardless of subscriber
    accounting, so resolve the gate at session start.

    Walks the output chain (a transcription synchronizer may wrap RoomIO's
    output). On a library version without the attribute this is a no-op and
    stock behavior remains.
    """
    out = getattr(getattr(session, "output", None), "audio", None)
    seen: set[int] = set()
    while out is not None and id(out) not in seen:
        seen.add(id(out))
        fut = getattr(out, "_subscribed_fut", None)
        if fut is not None:
            try:
                if not fut.done():
                    fut.set_result(None)
                    logger.info("voice_relay_audio_ungated")
            except Exception:
                logger.warning("voice_relay_audio_ungate_failed", exc_info=True)
            return
        out = getattr(out, "next_in_chain", None)
    logger.warning("voice_relay_audio_gate_not_found")


class VoiceRelayAgent(StableAgent):
    """Joins a call and speaks the cast's messages. No brain attached."""

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
        self._activation = DEFAULT_ACTIVATION
        #: Sliding conversation window (window mode). Monotonic deadline;
        #: 0 means closed. Each addressed line and each spoken reply slides it.
        self._window_until = 0.0
        self._window_seconds = DEFAULT_WINDOW_SECONDS
        self._name_aliases: set[str] = set()
        #: External talk gate (ptt mode): open while the pedal is held.
        self._gate_open = False
        #: Who the held pedal addresses, when not the relay's own persona.
        #: Set with each open frame, cleared with each close.
        self._gate_target: str | None = None
        #: sender username → Kokoro voice id. Empty until build_pipeline reads
        #: the room; ``_speaking_for()`` then substitutes the legacy single
        #: source so a relay built by hand in a test still has a map.
        self._voices: dict[str, str] = {}
        #: The persona's own voice — the one the session TTS was built with.
        self._persona_voice: str = ""
        #: Lazily-built TTS plugins for the OTHER voices, keyed by voice id.
        self._voice_tts: dict[str, Any] = {}
        self._ears_task: asyncio.Task[None] | None = None
        # The live LiveKit room handle. The base class keeps the room NAME and
        # id, not the object, so the relay holds its own reference — reaching
        # for a `self._room` that never existed is what made the ears throw on
        # every drain until a live call proved it.
        self._lk_room: Any = None
        #: Our identity AS THE ROSTER SEES IT (the job-accept identity, e.g.
        #: agent-claude-code) — the base class derives its own suffixed form
        #: for logging, and an election computed over mismatched names would
        #: quietly pick nobody.
        self._join_identity: str = ""
        self._queue: asyncio.Queue[SpokenLine] = asyncio.Queue()
        self._speaker_task: asyncio.Task[None] | None = None
        #: Faces + cast (2026-09-02). Both OFF unless the room says otherwise.
        self._video = False
        self._multi = False
        #: This participant's own face, when ``_video``.
        self._puppet: PuppetVideo | None = None
        #: sender username → hosted participant, when ``_multi``.
        self._cast: dict[str, CastMember] = {}
        self._visuals_task: asyncio.Task[None] | None = None
        self._manifest: dict[str, Any] | None = None

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
        # Job metadata is this dispatch's own truth; room metadata is the
        # room's standing setting. Same precedence as source/persona above.
        job_activation = activation_from_metadata(job_meta)
        self._activation = (
            job_activation
            if job_activation != DEFAULT_ACTIVATION
            else activation_from_metadata(room_meta)
        )
        job_window = window_seconds_from_metadata(job_meta)
        self._window_seconds = (
            job_window
            if job_window != DEFAULT_WINDOW_SECONDS
            else window_seconds_from_metadata(room_meta)
        )
        self._name_aliases = aliases_from_metadata(job_meta, self._relay_persona)
        if not self._name_aliases:
            self._name_aliases = aliases_from_metadata(room_meta, self._relay_persona)
        # The cast. Job metadata carries the key when the dispatch had it (the
        # webhook passes the room's setting through); the room copy is the
        # standing setting for a relay dispatched before the room was wired.
        self._persona_voice = preset_voice(persona)
        voices_meta = (
            job_meta
            if "voice_relay_voices" in _metadata_dict(job_meta)
            else room_meta
        )
        self._voices = relay_voices_from_metadata(voices_meta, source, persona)
        # Faces and cast. Same precedence: the dispatch's own metadata wins
        # when it speaks to the question, the room's standing setting otherwise.
        flags = relay_flags_from_metadata(
            job_meta if flags_present(job_meta) else room_meta
        )
        self._video, self._multi = flags["video"], flags["multi"]

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
        # Without this the first say() can block forever on a room with no
        # visible subscriber, and the track carries only comfort-noise silence.
        _unblock_audio_output(session)
        self._session = session

        ctx.room.on("data_received", self._on_data)
        self._speaker_task = asyncio.create_task(
            self._speak_loop(), name=f"voice-relay-speaker:{self._relay_persona}"
        )
        # Ears: carry the human's spoken words into the room so the brain on
        # the Mac can answer them. Only when nothing else is already doing it.
        self._lk_room = ctx.room
        self._join_identity = str(
            getattr(getattr(ctx.room, "local_participant", None), "identity", "")
            or ""
        )
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
        # Faces and cast members, off the critical path: a slow puppet join
        # must never delay the first spoken line.
        self._schedule_visuals()
        logger.info(
            "voice_relay_started",
            room=getattr(ctx.room, "name", ""),
            source=self._source_username,
            persona=self._relay_persona,
            activation=self._activation,
            voices=dict(self._voices),
            video=self._video,
            multi=self._multi,
        )
        return session

    # ------------------------------------------------------------------ #
    # Faces + cast (voice_relay_video / voice_relay_multi)
    # ------------------------------------------------------------------ #

    def _puppet_manifest(self) -> dict[str, Any]:
        if self._manifest is None:
            self._manifest = load_manifest()
        return self._manifest

    def _schedule_visuals(self) -> None:
        """Reconcile faces/cast with the current flags, in the background."""
        if self._visuals_task is not None and not self._visuals_task.done():
            # A change while one is running: let it finish, then run again.
            self._visuals_task.add_done_callback(lambda _t: self._schedule_visuals())
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop (a unit test building the agent by hand).
            self._visuals_task = None
            return
        self._visuals_task = loop.create_task(
            self._reconcile_visuals(), name=f"voice-relay-visuals:{self._relay_persona}"
        )

    async def _reconcile_visuals(self) -> None:
        """Make the room match the flags: own face on/off, cast joined/left.
        Every step is fail-open — a face that cannot be drawn must not cost a
        line of speech."""
        try:
            await self._reconcile_own_face()
        except Exception:
            logger.warning("voice_relay_face_reconcile_failed", exc_info=True)
        try:
            await self._reconcile_cast()
        except Exception:
            logger.warning("voice_relay_cast_reconcile_failed", exc_info=True)

    async def _reconcile_own_face(self) -> None:
        room = self._lk_room
        if room is None:
            return
        if self._video and self._puppet is None:
            spec = build_spec(
                self._join_identity or self._source_username,
                None,
                self._puppet_manifest(),
            )
            puppet = PuppetVideo(spec)
            await puppet.start(room)
            self._puppet = puppet
            # The mouth follows whatever the session actually sends to the wire.
            if self._session is not None and not tap_audio_output(
                self._session, puppet.feed
            ):
                logger.warning("voice_relay_face_audio_tap_missing")
        elif not self._video and self._puppet is not None:
            puppet, self._puppet = self._puppet, None
            await puppet.stop()

    def _cast_wanted(self) -> list[str]:
        """The senders that should have their own participant right now."""
        if not self._multi:
            return []
        return cast_identities(self._speaking_for(), self._source_username)

    async def _reconcile_cast(self) -> None:
        wanted = self._cast_wanted()
        # Leave: members no longer in the cast (or multi switched off).
        for identity in [i for i in self._cast if i not in wanted]:
            member = self._cast.pop(identity)
            await member.close()
            logger.info("voice_relay_cast_left", identity=identity)
        room = self._lk_room
        if room is None or not wanted:
            return
        taken = set()
        try:
            taken = {
                str(getattr(p, "identity", "") or "")
                for p in getattr(room, "remote_participants", {}).values()
            }
        except Exception:
            pass
        settings = self._settings
        voices = self._speaking_for()
        for identity in wanted:
            member = self._cast.get(identity)
            if member is not None:
                if member.video_enabled != self._video:
                    await member.set_video(self._video)
                member.voice = voices.get(identity, member.voice)
                continue
            if identity in taken:
                # The real worker is in the room under this name. Joining as
                # it would EVICT it (duplicate identity) — the cast never wins
                # that fight.
                logger.warning("voice_relay_cast_identity_taken", identity=identity)
                continue
            spec = build_spec(identity, None, self._puppet_manifest())
            member = CastMember(
                identity=identity,
                display_name=spec.display_name,
                voice=voices.get(identity, self._persona_voice),
                spec=spec,
                host_identity=self._join_identity or self._source_username,
                room_name=getattr(room, "name", "") or self._room_name,
                url=settings.livekit_url,
                api_key=settings.livekit_api_key,
                api_secret=settings.livekit_api_secret,
                video=self._video,
            )
            if await member.connect():
                self._cast[identity] = member

    async def _stop_visuals(self) -> None:
        if self._visuals_task is not None and not self._visuals_task.done():
            self._visuals_task.cancel()
        for identity, member in list(self._cast.items()):
            try:
                await member.close()
            except Exception:
                logger.debug("voice_relay_cast_close_failed", identity=identity, exc_info=True)
        self._cast.clear()
        if self._puppet is not None:
            puppet, self._puppet = self._puppet, None
            try:
                await puppet.stop()
            except Exception:
                logger.debug("voice_relay_face_stop_failed", exc_info=True)

    def _speaking_for(self) -> dict[str, str]:
        """The live cast: the map read at dispatch, or the legacy single source."""
        return self._voices or {self._source_username: self._persona_voice}

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
            if isinstance(payload, dict) and payload.get("type") == "relay_config":
                # A settings change, applied LIVE. Reading the mode only at
                # dispatch meant a change silently did nothing until everyone
                # left and rejoined — which reads as broken, because it is.
                if "voices" in payload:
                    # A cast change, applied live for the same reason: a
                    # voice that only changes after everyone rejoins is a
                    # voice that never changes during a show.
                    self._voices = relay_voices_from_metadata(
                        {"voice_relay_voices": payload.get("voices")},
                        self._source_username,
                        self._relay_persona,
                    )
                    logger.info("voice_relay_voices_changed", voices=dict(self._voices))
                    self._schedule_visuals()
                if "video" in payload or "multi" in payload:
                    # Faces on or off, live, for the same reason as the rest of
                    # this frame: a setting that waits for a rejoin is not one.
                    if "video" in payload:
                        self._video = _truthy(payload.get("video"))
                    if "multi" in payload:
                        self._multi = _truthy(payload.get("multi"))
                    logger.info(
                        "voice_relay_visuals_changed", video=self._video, multi=self._multi
                    )
                    self._schedule_visuals()
                mode = str(payload.get("activation") or "").strip().lower()
                if mode in ACTIVATION_MODES:
                    old_mode, self._activation = self._activation, mode
                    raw_window = payload.get("window_seconds")
                    if raw_window is not None and raw_window != "":
                        self._window_seconds = clamp_window_seconds(raw_window)
                    if mode != "window":
                        self._window_until = 0.0
                    logger.info(
                        "voice_relay_config_changed",
                        old=old_mode,
                        new=mode,
                        window_seconds=self._window_seconds,
                        by=str(payload.get("by") or "")[:40],
                    )
                elif not any(k in payload for k in ("voices", "video", "multi")):
                    logger.warning("voice_relay_config_invalid", value=mode[:20])
                return
            if isinstance(payload, dict) and payload.get("type") == "voice_relay_control":
                # A moderator's "mute mic" server-mutes this relay's track (see
                # server/app/api/moderation.py:mute_mic); LiveKit refuses the
                # server-side unmute (412 "remote unmute not enabled"), so the
                # only way back is the target unmuting ITSELF. This packet —
                # api/moderation.py's ``unmute_mic`` action — is that request.
                action = str(payload.get("action") or "").strip().lower()
                if action == "unmute":
                    self._unmute_own_audio(reason="control")
                else:
                    logger.warning(
                        "voice_relay_control_invalid", action=action[:20]
                    )
                return
            if isinstance(payload, dict) and payload.get("type") == "talk_gate":
                # The external activation signal. Any device can send it — a
                # foot pedal, a stream deck, a phone — via the gateway; the
                # relay does not care which, which is the point of having ONE
                # primitive instead of an extension per gadget.
                self._gate_open = bool(payload.get("open"))
                # The target rides with the OPEN frame and dies with the
                # close: a stale target on the next press would send Aaron's
                # words to whoever he addressed last time.
                self._gate_target = (
                    gate_target(
                        payload.get("target"),
                        self._relay_persona,
                        self._source_username,
                    )
                    if self._gate_open
                    else None
                )
                logger.info(
                    "voice_relay_talk_gate",
                    open=self._gate_open,
                    target=self._gate_target,
                )
                return
            if isinstance(payload, dict) and payload.get("type") == "transcript":
                self._on_transcript(payload)
                return
            line = should_speak_as(payload, self._speaking_for())
            if line is None:
                return
            message_id = str((payload.get("message") or {}).get("id") or "")
            # The same message can arrive twice (reconnect replay); saying it
            # twice is the kind of thing an audience notices immediately.
            if message_id and message_id in self._spoken_ids:
                return
            if message_id:
                self._spoken_ids.add(message_id)
            self._queue.put_nowait(line)
            logger.info(
                "voice_relay_queued",
                message_id=message_id[:8],
                chars=len(line.text),
                sender=line.sender,
                voice=line.voice,
                depth=self._queue.qsize(),
            )
        except Exception:
            logger.warning("voice_relay_data_failed", exc_info=True)

    def _unmute_own_audio(self, *, reason: str) -> bool:
        """Unmute this relay's own published AUDIO track(s). True if any track
        was actually muted (and is now unmuted); False when there was nothing
        to do — no room yet, no local participant, no audio published, or it
        was already unmuted.

        LiveKit's server-side unmute (``MuteRoomTrackRequest(muted=False)``)
        is refused by this deployment — 412 "remote unmute not enabled" (see
        LiveKitService.mute_participant). The SFU only lets a track's OWN
        publisher unmute it, so a moderator's ``mute_mic`` on this relay (see
        server/app/api/moderation.py) can only be undone from HERE. Never
        raises: called from the sync data callback and defensively before
        every line spoken, and a mute lookup failing must not cost a line.
        """
        room = self._lk_room
        participant = getattr(room, "local_participant", None) if room is not None else None
        publications = getattr(participant, "track_publications", None) or {}
        try:
            from livekit import rtc

            audio_kind = rtc.TrackKind.KIND_AUDIO
        except Exception:
            audio_kind = None
        changed = False
        for pub in publications.values():
            track = getattr(pub, "track", None)
            if track is None:
                continue
            kind = getattr(pub, "kind", None)
            if audio_kind is not None and kind is not None and kind != audio_kind:
                continue
            if not (getattr(pub, "muted", False) or getattr(track, "muted", False)):
                continue
            try:
                track.unmute()
                changed = True
            except Exception:
                logger.warning("voice_relay_unmute_track_failed", exc_info=True)
        if changed:
            logger.info("voice_relay_unmuted", reason=reason)
        return changed

    def _on_own_stt(self, ev: Any) -> None:
        """A final from the relay's OWN STT. Sync; must never raise."""
        try:
            if self._publisher is None:
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

            # EVERYTHING heard goes to the LIVE TRANSCRIPT — through the ONE
            # elected captioner. Every agent session transcribes the human, so
            # without the election a three-agent call rendered every sentence
            # three times in the panel.
            if self._captions is not None and elected_user_captioner(
                self._lk_room, self._join_identity or self._identity
            ):
                try:
                    self._captions.on_user_transcript(ev)
                except Exception:
                    logger.debug("voice_relay_caption_publish_failed", exc_info=True)

            # Chat is a different bar than the transcript, and BOTH ears share
            # one rule for it.
            self._maybe_persist(speaker, text, ear="stt")
        except Exception:
            logger.warning("voice_relay_own_stt_failed", exc_info=True)

    def _maybe_persist(self, speaker: str, text: str, *, ear: str) -> bool:
        """ONE decision for both ears: does this utterance become a chat message?

        The two ears (our own STT, and the browser's caption packets) used to
        apply different rules — the caption path persisted EVERYTHING it
        drained, which quietly resurrected the chat-flood for anyone on the
        default microphone. Whatever the ear, the answer must be the same.

        The activation gate (`_is_for_us`) runs first. Then two extra
        constraints apply only to ``always`` mode:

          * SOLE AGENT. An un-addressed line persisted next to a Brigade voice
            worker risks the same words landing twice (the worker persists the
            lines it replies to). ``name``/``ptt`` lines are addressed to US,
            which the other workers will not answer, so those modes work even
            in a multi-agent call — that is what lets "Rook, cut to camera
            two" work on show night with Majik and The General in the room.
            The residual edge (one line addressing us AND another agent) is
            accepted and rare.
          * NOT PURE FILLER. In always mode every utterance triggers a full
            agent turn; "um" as a turn is absurd, costs a real reply, and the
            agent then SAYS something to an utterance that meant nothing.
        """
        if not self._is_for_us(text):
            reason = log_name_near_miss(text, self._listen_names())
            if reason:
                # Visible on purpose: a silent miss is how "Rook isn't
                # responding" burns forty minutes. The transcript panel
                # already has the line; this log is why we did not chat it.
                logger.info(
                    "voice_relay_address_near_miss",
                    reason=reason,
                    chars=len(text),
                    ear=ear,
                    preview=text[:80],
                    activation=self._activation,
                )
            else:
                logger.debug(
                    "voice_relay_heard_not_addressed", chars=len(text), ear=ear
                )
            return False
        if self._activation == "always":
            if not sole_agent_in_call(self._lk_room, self._identity):
                logger.debug(
                    "voice_relay_always_stood_down",
                    reason="another agent is in the call",
                    ear=ear,
                )
                return False
            if filler_only(text):
                logger.debug("voice_relay_filler_skipped", preview=text[:40], ear=ear)
                return False
        if self._publisher is None:
            return False
        # A held pedal that NAMES an agent hands the line to that agent: the
        # persisted text carries the mention its poller matches on, and the
        # relay's own brain never sees a turn. The conversation window is left
        # alone on purpose — this line was for someone else.
        target = self._gate_target if self._gate_open else None
        content = f"@{target} {text}" if target else text
        if target:
            logger.info(
                "voice_relay_gate_target",
                target=target,
                speaker=speaker,
                chars=len(text),
                ear=ear,
            )
        self._publisher.persist_user_utterance(speaker, content)
        logger.info(
            "voice_relay_heard_addressed",
            speaker=speaker,
            chars=len(text),
            ear=ear,
            preview=text[:80],
        )
        return True

    def _listen_names(self) -> set[str]:
        return set(self._my_names) | set(self._name_aliases)

    def _addressed_by_name(self, text: str) -> bool:
        names = self._listen_names()
        return spoken_name_match(text, names) or fuzzy_spoken_name_match(text, names)

    def _touch_window(self) -> None:
        if self._activation == "window":
            self._window_until = self._clock() + self._window_seconds

    def _is_for_us(self, text: str) -> bool:
        """Was this line addressed to the agent, under this room's rule?"""
        mode = self._activation
        if mode == "off":
            return False
        if mode == "always":
            return True
        if mode == "ptt":
            # The gate is the whole signal — a held pedal cannot false-trigger
            # the way a spoken name can, which is why a show wants it.
            return self._gate_open
        if mode == "window":
            now = self._clock()
            if self._addressed_by_name(text):
                self._window_until = now + self._window_seconds
                return True
            if now < self._window_until:
                self._window_until = now + self._window_seconds
                return True
            return False
        return self._addressed_by_name(text)

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
                for utterance in due:
                    # The browser attributed this line itself, but the persist
                    # endpoint only accepts the username_<uuid> shape — an
                    # unacceptable id would be rejected as a silent 400, so
                    # check it HERE where it can be logged instead.
                    speaker = human_identity(utterance.participant_id)
                    if speaker is None:
                        logger.warning(
                            "voice_relay_caption_unattributed",
                            got=str(utterance.participant_id)[:40],
                        )
                        continue
                    self._maybe_persist(speaker, utterance.text, ear="captions")
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
                line = await self._queue.get()
            except asyncio.CancelledError:
                return
            try:
                await self._say(line)
            except asyncio.CancelledError:
                return
            except Exception:
                logger.error("voice_relay_say_failed", exc_info=True)

    def _uses_session_voice(self, voice: str) -> bool:
        """True when the line belongs to the voice the session TTS was built with."""
        return not voice or voice == self._persona_voice

    def _tts_for_voice(self, voice: str) -> Any:
        """The TTS plugin for one of the OTHER voices, built once and kept."""
        plugin = self._voice_tts.get(voice)
        if plugin is None:
            from plugins.tts import get_tts_plugin

            plugin = get_tts_plugin(personality=self._relay_persona, voice_id=voice)
            self._voice_tts[voice] = plugin
            logger.info("voice_relay_voice_tts_built", voice=voice)
        return plugin

    async def _synthesize(self, voice: str, text: str) -> list[Any]:
        """PCM frames for ``text`` in ``voice``; empty on any failure.

        Synthesised UP FRONT rather than streamed into ``say()``: the Kokoro
        plugin is one-shot anyway (a whole WAV per request, 0.65 s measured for
        a nine-second line), and holding the frames lets the caller fall back
        to the session voice when this one produced nothing — the alternative
        is a ``say()`` fed an empty generator, which is silence with a log
        line nobody is watching.
        """
        frames: list[Any] = []
        try:
            async with self._tts_for_voice(voice).synthesize(text) as stream:
                async for ev in stream:
                    frame = getattr(ev, "frame", None)
                    if frame is not None:
                        frames.append(frame)
        except Exception:
            logger.error("voice_relay_voice_synth_failed", voice=voice, exc_info=True)
            return []
        return frames

    async def _say(self, line: SpokenLine | str) -> None:
        session = self._session
        if session is None:
            return
        # Defensive: a moderator's ``mute_mic`` (server/app/api/moderation.py)
        # can land between two queued lines. The normal path is the
        # ``voice_relay_control`` unmute packet reaching ``_on_data`` first,
        # but that packet can be lost or arrive late — better a self-check
        # here than a queue that silently empties into a muted track.
        if self._unmute_own_audio(reason="before_speak"):
            logger.info("voice_relay_unmute_before_speak")
        if isinstance(line, str):
            line = SpokenLine(self._persona_voice, line, self._source_username, "")
        text = line.text
        member = self._cast.get(line.sender) if self._cast else None
        if member is not None and member.ready:
            # This sender has its OWN participant: the words leave its mouth
            # and its tile, not the relay's. Falls through to the relay's own
            # voice only if synthesis produced nothing, so a broken cast
            # voice degrades to the old behaviour rather than to silence.
            frames = await self._synthesize(line.voice, text)
            if frames and await member.speak(frames, budget_s=playout_budget(text)):
                if self._captions is not None:
                    self._captions.publish_agent_final(
                        text, name=line.name, participant_id=line.sender
                    )
                self._touch_window()
                logger.info(
                    "voice_relay_cast_spoke",
                    chars=len(text),
                    sender=line.sender,
                    voice=line.voice,
                )
                return
            logger.warning("voice_relay_cast_fallback", sender=line.sender)
        if self._uses_session_voice(line.voice):
            result = session.say(text)
        else:
            # livekit-agents 1.6.7: ``say(text, *, audio=AsyncIterable[AudioFrame])``
            # plays supplied audio instead of running the session's TTS, so
            # one session speaks in any number of voices without swapping
            # its plugin under the speak lock.
            frames = await self._synthesize(line.voice, text)
            if frames:
                result = session.say(text, audio=_replay(frames))
                # The tile still says Rook; the caption says whose words
                # these were.
                if self._captions is not None:
                    self._captions.publish_agent_final(
                        text, name=line.name, participant_id=line.sender
                    )
            else:
                logger.warning(
                    "voice_relay_voice_fallback",
                    voice=line.voice,
                    sender=line.sender,
                    fallback=self._persona_voice,
                )
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
        self._touch_window()
        logger.info(
            "voice_relay_spoke", chars=len(text), sender=line.sender, voice=line.voice
        )

    async def _shutdown_steps(self) -> None:  # pragma: no cover — lifecycle
        for task in (self._speaker_task, self._ears_task):
            if task is not None and not task.done():
                task.cancel()
        try:
            await asyncio.wait_for(self._stop_visuals(), timeout=8.0)
        except Exception:
            logger.debug("voice_relay_visuals_stop_failed", exc_info=True)
        await super()._shutdown_steps()
