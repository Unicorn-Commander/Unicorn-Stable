"""TranscriptPublisher — publish live call captions as LiveKit data messages.

The web client's TranscriptPanel renders near-real-time, speaker-labeled
caption lines from ``transcript`` data-channel messages on the shared
``stable`` topic (see web/src/lib/roomDataProtocol.ts — the producer side this
module mirrors). Two producers feed it:

  1. The HUMAN's speech-to-text — interim hypotheses (``isFinal: false``) that
     update in place, then a committed final (``isFinal: true``). Sourced from
     the AgentSession ``user_input_transcribed`` event.
  2. MAJIK's spoken replies — the assistant's text, sourced from the
     AgentSession ``conversation_item_added`` event (role == "assistant").

Wire contract (must match the deployed frontend EXACTLY):
    topic   = "stable", published reliably.
    payload = json.dumps(msg).encode("utf-8")   (UTF-8 bytes of JSON)
    msg     = {
        "type": "transcript",
        "participantId": <livekit identity of the speaker>,
        "name": <display name to label the line>,
        "text": <str>,
        "isFinal": <bool>,
        "ts": <epoch ms int>,
        "segmentId": <optional str>,
    }

Design constraints:
  * ADDITIVE + SAFE — this never touches STT/TTS/LLM/mic wiring. It only reads
    the events those produce and republishes them as captions.
  * Fire-and-forget — publishing is scheduled on the event loop and never
    awaited by the voice loop.
  * NEVER raises into the voice loop — every public entry point wraps its work
    in try/except and logs; a captioning failure must not disturb the call.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx
import structlog
from livekit import rtc

from agent_runtime.config import get_agent_settings

logger = structlog.get_logger(__name__)

# The shared LiveKit data-channel topic the frontend listens on.
# Mirror of web/src/lib/roomDataProtocol.ts ROOM_DATA_TOPIC.
TRANSCRIPT_TOPIC = "stable"


def resolve_human(room: rtc.Room, speaker_id: str | None) -> tuple[str, str]:
    """Resolve a (livekit_identity, displayName) for the human speaker.

    Prefers an exact ``speaker_id`` match against the room's remote
    participants; falls back to the single non-agent remote (the common
    1-human + 1-agent call); last resort uses ``speaker_id`` or a generic
    label. Shared by the caption publisher and the history persister so both
    attribute a turn to the same participant.
    """
    try:
        remotes = list(room.remote_participants.values())
    except Exception:
        remotes = []

    if speaker_id:
        for p in remotes:
            if getattr(p, "identity", None) == speaker_id:
                return speaker_id, (getattr(p, "name", "") or speaker_id)

    humans = [
        p
        for p in remotes
        if not (getattr(p, "identity", "") or "").startswith("agent-")
    ]
    if len(humans) == 1:
        p = humans[0]
        ident = getattr(p, "identity", "") or (speaker_id or "human")
        return ident, (getattr(p, "name", "") or ident)

    if speaker_id:
        return speaker_id, speaker_id
    return "human", "Speaker"


def _now_ms() -> int:
    """Epoch milliseconds — the frontend uses ``ts`` for ordering + autoscroll."""
    return int(time.time() * 1000)


def _agent_display_name(brigade_agent_id: str | None) -> str:
    """Friendly label for an agent's transcript lines.

    Mirrors the server's canonical derivation
    (``brigade_agent_id.replace("-", " ").title()`` in
    services/agent_chat_responder.py) so a caption label matches the name the
    rest of the app shows: "majik" -> "Majik", "the-general" -> "The General".
    """
    if not brigade_agent_id:
        return "Majik"
    return brigade_agent_id.replace("-", " ").title()


class _AgentInterim:
    """Accumulates one agent utterance's streamed reply text and republishes a
    growing interim caption line.

    Created via ``TranscriptPublisher.begin_agent_interim()`` for each agent
    speech generation. Each ``push(delta)`` appends to the buffer and publishes
    the whole accumulated text as an ``isFinal: false`` line on a stable
    segmentId, so the frontend replaces the agent's single interim line in place
    while the reply is spoken. Fully guarded: ``push`` never raises, so it is
    safe to call from inside the voice pipeline's ``transcription_node``.
    """

    __slots__ = ("_pub", "_segment_id", "_buf")

    def __init__(self, pub: "TranscriptPublisher", segment_id: str) -> None:
        self._pub = pub
        self._segment_id = segment_id
        self._buf: list[str] = []

    def push(self, delta: str) -> None:
        """Append a spoken/streamed text delta and publish the growing interim.

        ``delta`` may be a plain ``str`` or a ``TimedString`` (a ``str``
        subclass) -- either way it is treated as text. Never raises.
        """
        try:
            if not delta:
                return
            self._buf.append(str(delta))
            text = "".join(self._buf).strip()
            if not text:
                return
            self._pub._publish(
                participant_id=self._pub._agent_identity,
                name=self._pub._agent_name,
                text=text,
                is_final=False,
                segment_id=self._segment_id,
            )
        except Exception:
            # NEVER let a captioning error bubble into the voice loop.
            logger.debug("transcript_agent_interim_push_failed", exc_info=True)


class TranscriptPublisher:
    """Publishes ``transcript`` data messages for one in-room AgentSession.

    Holds the LiveKit room handle and the resolved identity/name for both the
    agent (Majik) side and is wired to the session's STT + conversation events
    by the agent that builds the pipeline.
    """

    def __init__(
        self,
        *,
        room: rtc.Room,
        agent_identity: str,
        agent_name: str,
    ) -> None:
        self._room: rtc.Room = room
        # Majik's own LiveKit identity (the "agent-..." convention). The
        # frontend styles a line as an agent line when participantId starts
        # with "agent-" (TranscriptPanel.tsx), so this MUST be the in-room
        # agent identity.
        self._agent_identity: str = agent_identity
        self._agent_name: str = agent_name
        # Monotonic counter to give each agent utterance a unique segmentId so
        # the frontend keys consecutive final lines distinctly even within the
        # same millisecond.
        self._agent_seq: int = 0
        # Separate monotonic counter for the STREAMING interim caption line of
        # each agent utterance. Interims collapse per participantId on the
        # frontend, but we give each utterance a stable segmentId so its growing
        # interim keeps one React key while it builds up in place; the turn-end
        # final (on_conversation_item) then supersedes it.
        self._agent_interim_seq: int = 0

    # ------------------------------------------------------------------ #
    # Event handlers — these are registered as sync callbacks on the
    # AgentSession via ``session.on(...)``. They must NOT raise.
    # ------------------------------------------------------------------ #

    def on_user_transcript(self, ev: Any) -> None:
        """Handle a ``UserInputTranscribedEvent`` (interim + final user STT).

        Fields (livekit-agents 1.6): ``transcript`` (str), ``is_final`` (bool),
        ``speaker_id`` (str | None). We label the line with the human's room
        participant (identity + display name) resolved from ``speaker_id`` when
        present, else the single remote human in the room.
        """
        try:
            text = (getattr(ev, "transcript", "") or "").strip()
            if not text:
                return
            is_final = bool(getattr(ev, "is_final", False))
            speaker_id = getattr(ev, "speaker_id", None)

            participant_id, name = self._resolve_human(speaker_id)
            # Rolling interim lines collapse per participantId on the frontend,
            # so a stable segmentId across an utterance's interims isn't needed;
            # for finals we give a unique id to avoid key collisions.
            segment_id = (
                f"{participant_id}-{_now_ms()}" if is_final else None
            )
            self._publish(
                participant_id=participant_id,
                name=name,
                text=text,
                is_final=is_final,
                segment_id=segment_id,
            )
        except Exception:
            # NEVER let a captioning error bubble into the voice loop.
            logger.debug("transcript_user_publish_failed", exc_info=True)

    def on_conversation_item(self, ev: Any) -> None:
        """Handle a ``ConversationItemAddedEvent`` for Majik's spoken replies.

        We only caption assistant messages (the agent's own speech). The item
        is a ``ChatMessage`` with ``.role`` and ``.text_content``. These are
        emitted once per turn (already-final), so we publish them as final
        lines under the agent's identity.
        """
        try:
            item = getattr(ev, "item", None)
            if item is None:
                return
            if getattr(item, "role", None) != "assistant":
                return
            # ChatMessage.text_content joins all text parts; fall back to str().
            text = getattr(item, "text_content", None)
            if text is None:
                text = ""
            text = (text or "").strip()
            if not text:
                return

            self._agent_seq += 1
            segment_id = f"{self._agent_identity}-{self._agent_seq}-{_now_ms()}"
            self._publish(
                participant_id=self._agent_identity,
                name=self._agent_name,
                text=text,
                is_final=True,
                segment_id=segment_id,
            )
        except Exception:
            logger.debug("transcript_agent_publish_failed", exc_info=True)

    def begin_agent_interim(self) -> "_AgentInterim":
        """Start a new streaming interim caption for one agent utterance.

        The voice pipeline feeds the agent's reply text through
        ``Agent.transcription_node`` as it is produced/spoken (the LLM token
        stream, or TTS-aligned word timings when the TTS supports them). The
        agent tees each delta into the returned handle, which publishes a
        growing ``isFinal: false`` line under the agent's identity so the
        caption builds up "as it reads" instead of appearing as one block at
        turn end. The existing ``on_conversation_item`` still publishes the
        committed ``isFinal: true`` line, which supersedes this interim.

        Never raises: the returned handle swallows and logs its own errors so a
        captioning hiccup can never disturb the voice loop.
        """
        self._agent_interim_seq += 1
        segment_id = f"{self._agent_identity}-interim-{self._agent_interim_seq}"
        return _AgentInterim(self, segment_id)

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    def _resolve_human(self, speaker_id: str | None) -> tuple[str, str]:
        """Delegate to the shared module-level resolver (one source of truth
        for both captions and history persistence)."""
        return resolve_human(self._room, speaker_id)

    def _publish(
        self,
        *,
        participant_id: str,
        name: str,
        text: str,
        is_final: bool,
        segment_id: str | None,
    ) -> None:
        """Build the transcript envelope and fire-and-forget publish it."""
        msg: dict[str, Any] = {
            "type": "transcript",
            "participantId": participant_id,
            "name": name,
            "text": text,
            "isFinal": is_final,
            "ts": _now_ms(),
        }
        if segment_id:
            msg["segmentId"] = segment_id

        try:
            payload = json.dumps(msg).encode("utf-8")
        except Exception:
            logger.debug("transcript_encode_failed", exc_info=True)
            return

        # publish_data is a coroutine in livekit-rtc 1.x; schedule it without
        # awaiting so we never block the synchronous event callback or the
        # voice loop. Errors are swallowed in _publish_task.
        try:
            asyncio.create_task(self._publish_task(payload))
        except RuntimeError:
            # No running loop (shouldn't happen inside the session) — drop it.
            logger.debug("transcript_no_event_loop")

    async def _publish_task(self, payload: bytes) -> None:
        try:
            await self._room.local_participant.publish_data(
                payload,
                reliable=True,
                topic=TRANSCRIPT_TOPIC,
            )
        except Exception:
            logger.debug("transcript_publish_data_failed", exc_info=True)


class VoiceHistoryPersister:
    """Persist FINAL voice turns to the room's chat history.

    The caption data-channel (TranscriptPublisher) is ephemeral — once a call
    ends those lines are gone. This sibling writes the same turns to the
    backend so a spoken conversation is reviewable later alongside typed chat:

      * human final STT  -> POST /api/v1/internal/voice-user-message
                            (attributed to the human, tagged via=voice; the
                            backend suppresses any text agent reply)
      * agent reply      -> POST /api/v1/internal/agent-messages (via=voice)

    Same safety contract as TranscriptPublisher: ADDITIVE, fire-and-forget,
    NEVER raises into the voice loop. Authenticated with the LiveKit shared
    secret, like the other internal agent routes.
    """

    def __init__(
        self,
        *,
        room: rtc.Room,
        livekit_room_name: str,
        brigade_agent_id: str | None,
    ) -> None:
        self._room = room
        self._lk_room_name = livekit_room_name
        self._brigade_agent_id = brigade_agent_id or "majik"
        cfg = get_agent_settings()
        self._base = (getattr(cfg, "stable_backend_url", "") or "").rstrip("/")
        self._secret = (
            getattr(cfg, "internal_agent_secret", "")
            or getattr(cfg, "livekit_api_secret", "")
            or ""
        )

    # -- AgentSession event handlers (sync callbacks; must NOT raise) -- #

    def on_user_transcript(self, ev: Any) -> None:
        """Persist a human's FINAL STT turn (interims are ignored)."""
        try:
            if not bool(getattr(ev, "is_final", False)):
                return
            text = (getattr(ev, "transcript", "") or "").strip()
            if not text:
                return
            identity, _name = resolve_human(self._room, getattr(ev, "speaker_id", None))
            self._fire(
                "/api/v1/internal/voice-user-message",
                {
                    "livekit_room_name": self._lk_room_name,
                    "speaker_identity": identity,
                    "content": text,
                },
            )
        except Exception:
            logger.debug("voice_history_user_failed", exc_info=True)

    def on_conversation_item(self, ev: Any) -> None:
        """Persist the agent's spoken reply (assistant items only)."""
        try:
            item = getattr(ev, "item", None)
            if item is None or getattr(item, "role", None) != "assistant":
                return
            text = (getattr(item, "text_content", None) or "").strip()
            if not text:
                return
            self._fire(
                "/api/v1/internal/agent-messages",
                {
                    "livekit_room_name": self._lk_room_name,
                    "brigade_agent_id": self._brigade_agent_id,
                    "content": text,
                    "via": "voice",
                },
            )
        except Exception:
            logger.debug("voice_history_agent_failed", exc_info=True)

    # -- internals -- #

    def _fire(self, path: str, body: dict[str, Any]) -> None:
        if not self._base or not self._secret:
            return
        try:
            asyncio.create_task(self._post(path, body))
        except RuntimeError:
            logger.debug("voice_history_no_event_loop")

    async def _post(self, path: str, body: dict[str, Any]) -> None:
        try:
            async with httpx.AsyncClient(
                base_url=self._base,
                timeout=httpx.Timeout(10.0, connect=5.0),
            ) as client:
                resp = await client.post(
                    path,
                    json=body,
                    headers={"Authorization": f"Bearer {self._secret}"},
                )
                if resp.status_code >= 400:
                    logger.debug(
                        "voice_history_http_error",
                        path=path,
                        status=resp.status_code,
                        detail=resp.text[:200],
                    )
        except Exception:
            logger.debug("voice_history_post_failed", path=path, exc_info=True)
