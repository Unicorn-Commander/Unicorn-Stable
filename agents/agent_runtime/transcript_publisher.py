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

import structlog
from livekit import rtc

logger = structlog.get_logger(__name__)

# The shared LiveKit data-channel topic the frontend listens on.
# Mirror of web/src/lib/roomDataProtocol.ts ROOM_DATA_TOPIC.
TRANSCRIPT_TOPIC = "stable"


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

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    def _resolve_human(self, speaker_id: str | None) -> tuple[str, str]:
        """Resolve a (participantId, displayName) pair for the human speaker.

        Prefers an exact match on ``speaker_id`` against the room's remote
        participants. Falls back to the single non-agent remote participant
        (the common 1-human + 1-agent call). Last resort: use ``speaker_id``
        (or a generic label) so the line still renders.
        """
        try:
            remotes = list(self._room.remote_participants.values())
        except Exception:
            remotes = []

        # 1. Exact speaker_id match.
        if speaker_id:
            for p in remotes:
                if getattr(p, "identity", None) == speaker_id:
                    return speaker_id, (getattr(p, "name", "") or speaker_id)

        # 2. Single non-agent remote participant (1-human call).
        humans = [
            p
            for p in remotes
            if not (getattr(p, "identity", "") or "").startswith("agent-")
        ]
        if len(humans) == 1:
            p = humans[0]
            ident = getattr(p, "identity", "") or (speaker_id or "human")
            return ident, (getattr(p, "name", "") or ident)

        # 3. Fall back to the raw speaker_id, else a generic label.
        if speaker_id:
            return speaker_id, speaker_id
        return "human", "Speaker"

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
