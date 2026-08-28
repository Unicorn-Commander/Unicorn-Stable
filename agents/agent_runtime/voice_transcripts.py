"""Browser-STT transcript consumption — the agent's fallback set of ears.

Why this exists (2026-08-08, verified live): Aaron voice-called Majik and the
agent never answered. The web client captions every human's LOCAL mic with the
Web Speech API and publishes the lines on the LiveKit data channel as
``{"type": "transcript", ...}`` (web/src/lib/humanTranscript.ts →
roomDataProtocol.ts). The worker's ChatHandler knew nothing about that type, so
every line was warn-dropped (``chat_unknown_type raw_type=transcript``) while
the AgentSession's own STT plugin — the only path that COULD hear — sat silent
(Amanuensis unreachable / VAD unloaded / plugin failed). Result: a flood of
warnings and a mute agent.

This module turns those browser captions into real conversation input:

  * INTERIM lines (``isFinal: false``, ~2/sec) are ignored silently.
  * FINAL lines from HUMANS are deduped by segmentId and grouped: consecutive
    finals from the same speaker within a short window collapse into ONE
    utterance, so a mid-thought pause doesn't trigger two replies.
  * The grouped utterance is fed into the SAME reply pipeline the agent's own
    STT feeds — ``AgentSession.generate_reply(user_input=...)`` — so the reply
    goes through the identical Brigade LLM plugin, the identical TTS voice, the
    identical live-caption tee (``transcription_node``) and the identical
    voice-history persistence (``conversation_item_added``). Nothing is forked.

Double-reply protection, in order:

  1. SOURCE — only ``local_mic`` (or source-less, for older web bundles) lines
     count. ``agent_stt`` re-publishes from ANOTHER agent's session must not
     re-trigger a reply for the same words, and ``agent`` lines are replies.
  2. SPEAKER — agent identities (``agent-*``) and the unattributed
     ``"human"``/"Unidentified speaker" placeholder never trigger.
  3. STT-ALIVE ARBITRATION — when this worker's own STT plugin is configured,
     the browser path is a FALLBACK: if the session produced any
     ``user_input_transcribed`` activity recently, the AgentSession is hearing
     fine and will answer by itself, so the browser trigger stands down. The
     grouping window is stretched by a grace period so a slow-but-alive STT
     final still wins the race instead of producing two replies.
  4. LATCH — one in-flight reply per room. Utterances completing while a reply
     is being generated/spoken are dropped (logged), not queued, so overlapping
     speech can't stack replies.
  5. ADDRESSING — mirrors the text policy (_handle_chat_message /
     server _should_respond): when this agent is the only agent in the room,
     every human utterance is addressed to it (a 1:1 call IS the conversation,
     like a DM). When OTHER agents are present, the utterance must speak this
     agent's name — the voice analogue of the @-mention rule. The full
     multi-agent dispatcher is deferred work (docs/voice-dispatch-spec).

The grouping/dedupe/classification core is pure (injected clock, plain dicts)
so it is unit-testable without livekit installed; this module deliberately has
no top-level livekit import.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import structlog

from agent_runtime import voice_dispatch

logger = structlog.get_logger(__name__)

# Wire contract mirror of web/src/lib/roomDataProtocol.ts TranscriptMessage.
# Sources that may DRIVE a reply. ``None`` (field absent) is accepted for
# older web bundles that predate the ``source`` field.
_REPLY_SOURCES: frozenset[str | None] = frozenset({None, "", "local_mic"})

# Placeholder identities the agent-STT publisher uses when it refuses to guess
# the speaker in a multi-human room. Never conversation input.
_UNATTRIBUTED_IDS: frozenset[str] = frozenset({"", "human"})
_UNATTRIBUTED_NAMES: frozenset[str] = frozenset({"Unidentified speaker", "Speaker"})


def is_agent_identity(participant_id: str | None) -> bool:
    """The ``agent-*`` LiveKit identity convention, used app-wide.

    Workers register as ``agent-<agent_type>`` (registry.py job accept) and
    server evictions probe ``agent-<brigade_id>`` / ``agent-brigade-<id>``
    (api/brigade.py) — all share the prefix, so the prefix is the contract.
    """
    return bool(participant_id) and str(participant_id).startswith("agent-")


@dataclass(frozen=True)
class Utterance:
    """One grouped, reply-worthy piece of human speech."""

    participant_id: str
    name: str
    text: str
    segment_ids: tuple[str, ...]
    first_ts_ms: int
    last_ts_ms: int


@dataclass
class _Pending:
    name: str
    parts: list[str] = field(default_factory=list)
    segment_ids: list[str] = field(default_factory=list)
    first_ts_ms: int = 0
    last_ts_ms: int = 0
    deadline: float = 0.0  # monotonic seconds


def classify_transcript(
    msg: dict[str, Any] | None,
    *,
    now_ms: int | None = None,
) -> tuple[str, dict[str, Any] | None]:
    """Classify one transcript payload. Pure; never raises on malformed input.

    Returns ``(verdict, normalized)``. ``normalized`` is set only for
    ``"final"`` and carries ``participant_id, name, text, segment_id, ts_ms``.

    Verdicts:
        interim        — isFinal false/absent → ignore silently (no warn).
        agent_speaker  — spoken by an agent identity, or an ``agent``/
                         ``agent_stt`` sourced line → never reply input.
        unattributed   — the publisher could not name a real human.
        empty          — no usable text.
        invalid        — not a dict.
        final          — a human's committed line; use ``normalized``.
    """
    if not isinstance(msg, dict):
        return "invalid", None

    if not bool(msg.get("isFinal")):
        return "interim", None

    source = msg.get("source")
    if source not in _REPLY_SOURCES:
        # "agent" (the agent's own spoken reply) and "agent_stt" (another
        # worker's linked-participant fallback captions). Replying to either
        # would echo-loop or double-answer the same human words.
        return "agent_speaker", None

    participant_id = str(msg.get("participantId") or "")
    name = str(msg.get("name") or "")
    if is_agent_identity(participant_id):
        return "agent_speaker", None
    if participant_id in _UNATTRIBUTED_IDS or name in _UNATTRIBUTED_NAMES:
        return "unattributed", None

    text = str(msg.get("text") or "").strip()
    if not text:
        return "empty", None

    # Version tolerance: ts and segmentId are optional on the wire. A missing
    # segmentId still needs a dedupe key — identical (speaker, ts, text) IS the
    # same line, so synthesize from those.
    raw_ts = msg.get("ts")
    ts_ms = (
        int(raw_ts)
        if isinstance(raw_ts, (int, float))
        else (now_ms if now_ms is not None else int(time.time() * 1000))
    )
    segment_id = str(msg.get("segmentId") or "") or f"{participant_id}:{ts_ms}:{len(text)}"

    return "final", {
        "participant_id": participant_id,
        "name": name or participant_id,
        "text": text,
        "segment_id": segment_id,
        "ts_ms": ts_ms,
    }


class TranscriptAggregator:
    """Dedupe + group browser-STT finals into utterances. Pure logic.

    The clock is injected (``now`` = monotonic seconds) so tests drive time.
    Typical flow: ``ingest`` each payload; when it returns ``"buffered"`` the
    caller arms a drain that calls ``pop_due`` until ``next_due_in`` is None.
    """

    def __init__(
        self,
        *,
        group_window: float = 1.5,
        dedupe_capacity: int = 512,
    ) -> None:
        self._window = max(0.0, float(group_window))
        self._capacity = max(16, int(dedupe_capacity))
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._pending: dict[str, _Pending] = {}

    def ingest(self, msg: dict[str, Any] | None, *, now: float) -> str:
        """Feed one payload. Returns the classification verdict, with finals
        refined to ``"duplicate"`` or ``"buffered"``."""
        verdict, norm = classify_transcript(msg)
        if verdict != "final" or norm is None:
            return verdict

        segment_id = norm["segment_id"]
        if segment_id in self._seen:
            return "duplicate"
        self._seen[segment_id] = None
        while len(self._seen) > self._capacity:
            self._seen.popitem(last=False)

        pid = norm["participant_id"]
        pending = self._pending.get(pid)
        if pending is None:
            pending = _Pending(name=norm["name"], first_ts_ms=norm["ts_ms"])
            self._pending[pid] = pending
        pending.parts.append(norm["text"])
        pending.segment_ids.append(segment_id)
        pending.last_ts_ms = norm["ts_ms"]
        pending.deadline = now + self._window
        return "buffered"

    def next_due_in(self, *, now: float) -> float | None:
        """Seconds until the earliest pending utterance flushes, or None."""
        if not self._pending:
            return None
        return max(0.0, min(p.deadline for p in self._pending.values()) - now)

    def pop_due(self, *, now: float) -> list[Utterance]:
        """Remove and return every utterance whose quiet window has elapsed."""
        due: list[Utterance] = []
        for pid in [p for p, pend in self._pending.items() if pend.deadline <= now]:
            due.append(self._finalize(pid))
        return due

    def flush_all(self) -> list[Utterance]:
        """Drain everything regardless of deadlines (shutdown path)."""
        return [self._finalize(pid) for pid in list(self._pending)]

    def _finalize(self, participant_id: str) -> Utterance:
        pending = self._pending.pop(participant_id)
        return Utterance(
            participant_id=participant_id,
            name=pending.name,
            text=" ".join(part.strip() for part in pending.parts if part.strip()),
            segment_ids=tuple(pending.segment_ids),
            first_ts_ms=pending.first_ts_ms,
            last_ts_ms=pending.last_ts_ms,
        )


def spoken_mention(text: str, names: list[str] | tuple[str, ...] | set[str]) -> bool:
    """Whether spoken ``text`` addresses one of ``names``.

    The text @-mention rule (base._is_mentioned / server _should_respond)
    requires a literal ``@``, which STT never produces — speech addresses by
    bare name ("Majik, what do you think"). Word-boundary match, case
    insensitive; a typed-style "@majik" also matches because ``@`` is not a
    word character.
    """
    lc = (text or "").lower()
    if not lc:
        return False
    for raw in names:
        needle = (raw or "").strip().lower()
        if not needle:
            continue
        if re.search(rf"(?<![a-z0-9]){re.escape(needle)}(?![a-z0-9])", lc):
            return True
    return False


def mention_needles(brigade_agent_id: str | None, agent_type: str | None = None) -> set[str]:
    """The name forms a speaker might use for this agent.

    Mirrors the needles _should_respond builds (id + spaced id) — bare, since
    speech has no ``@``. ``@everyone``/``@all`` are deliberately NOT honored by
    voice: "all" is far too common a spoken word (see the "nobody class" in
    docs/voice-dispatch-spec-2026-08-09.md).
    """
    needles: set[str] = set()
    for candidate in (brigade_agent_id, agent_type):
        if not candidate:
            continue
        lowered = str(candidate).strip().lower()
        if not lowered:
            continue
        needles.add(lowered)
        needles.add(lowered.replace("-", " "))
    return needles


def other_agents_present(room: Any, self_identity: str) -> bool:
    """Any OTHER ``agent-*`` participant in the room?

    The dispatched worker is the room's resident agent; this is the structural
    check that another resident is present, in which case bare human speech is
    ambiguous and the mention rule applies (mirroring the channel @-rule).
    """
    try:
        remotes = list(getattr(room, "remote_participants", {}).values())
    except Exception:
        return False
    for participant in remotes:
        identity = getattr(participant, "identity", "") or ""
        if is_agent_identity(identity) and identity != self_identity:
            return True
    return False


def primary_agent_id(room: Any) -> str | None:
    """The room's designated voice co-host, or None.

    ``voice_primary_agent_id`` is the deliberate setting. It falls back to
    ``brigade_agent_id`` so a room that has never been configured still has a
    co-host — but that scalar is LAST-INVITED-WINS (registry, same file that
    warns it is "shared mutable state that the next dispatch overwrites"), so
    the fallback quietly follows whoever was invited most recently. Set the
    explicit key on any room where it matters.
    """
    raw = getattr(room, "metadata", "") or ""
    if not raw:
        return None
    try:
        meta = json.loads(raw)
    except Exception:
        return None
    if not isinstance(meta, dict):
        return None
    for key in ("voice_primary_agent_id", "brigade_agent_id"):
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def call_roster(room: Any, self_identity: str) -> tuple[dict[str, set[str]], int]:
    """(other agents → their spoken names, human count) for the live call.

    The dispatcher needs both: other agents so an utterance naming one of them
    reads as "addressed elsewhere" rather than merely "not mine", and the human
    count because one human alone with one agent is a DM, not a conversation
    the agent should stay out of.

    The local participant is US (a worker), so only remotes are counted; the
    egress recorder and hidden broadcast viewers are not people and are
    excluded by the same prefixes the server uses.
    """
    others: dict[str, set[str]] = {}
    humans = 0
    try:
        remotes = list(getattr(room, "remote_participants", {}).values())
    except Exception:
        return others, 0
    for participant in remotes:
        identity = str(getattr(participant, "identity", "") or "")
        if not identity or identity == self_identity:
            continue
        if identity.startswith("broadcast-") or identity.startswith("EG_"):
            continue
        if is_agent_identity(identity):
            agent_id = identity.removeprefix("agent-")
            others[agent_id] = mention_needles(agent_id, None)
        else:
            humans += 1
    return others, humans


class VoiceTranscriptResponder:
    """Bridges grouped browser-STT utterances into the AgentSession pipeline.

    Owned by BrigadeBackedAgent.build_pipeline. All entry points are
    fail-safe: an error here logs and drops the utterance — it must never
    disturb the live voice loop.
    """

    # Hard ceiling on one reply generation+playout before the latch frees.
    _REPLY_TIMEOUT_SECONDS = 180.0

    def __init__(
        self,
        *,
        session: Any,
        room: Any,
        agent_identity: str,
        brigade_agent_id: str,
        agent_type: str = "brigade",
        stt_configured: bool,
        group_window: float = 1.5,
        stt_grace: float = 2.0,
        stt_alive_window: float = 12.0,
        persist_user_utterance: Callable[[str, str], None] | None = None,
        acquire_rate_slot: Callable[[], Awaitable[bool]] | None = None,
        restart_session: Callable[[], Awaitable[Any | None]] | None = None,
        direct_reply: Callable[[str, Callable[[], None]], Awaitable[bool]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._session = session
        self._room = room
        self._agent_identity = agent_identity
        self._brigade_agent_id = brigade_agent_id
        self._needles = mention_needles(brigade_agent_id, agent_type)
        self._stt_configured = bool(stt_configured)
        # When our own STT is configured, stretch the quiet window by the grace
        # period so a slow-but-alive plugin final arrives (and stands us down)
        # BEFORE we fire — the race that would otherwise double-reply.
        effective_window = group_window + (stt_grace if stt_configured else 0.0)
        self._aggregator = TranscriptAggregator(group_window=effective_window)
        self._stt_alive_window = max(0.0, float(stt_alive_window))
        self._persist_user_utterance = persist_user_utterance
        self._acquire_rate_slot = acquire_rate_slot
        # Session-death recovery (incident 2026-08-10): the AgentSession can
        # close itself (unrecoverable STT errors → CloseReason.ERROR) and
        # generate_reply then raises "AgentSession isn't running". The owner
        # provides: restart_session() → a fresh started session (or None),
        # and direct_reply(text, on_commit) → the bounded emergency path
        # (Brigade text + TTS publish) when even a restart fails.
        self._restart_session = restart_session
        self._direct_reply = direct_reply
        self._clock = clock
        self._last_stt_activity: float | None = None
        self._drain_task: asyncio.Task[None] | None = None
        self._reply_lock = asyncio.Lock()
        self._closed = False
        # Shared per-room dispatch state. Every worker for this room in this
        # process resolves the SAME object — that shared identity is what
        # makes the floor a mutex rather than a per-agent flag.
        self._room_key = voice_dispatch.make_room_key(
            getattr(room, "name", None)
        )
        self._floor = voice_dispatch.floor_for(self._room_key)

    # ------------------------------------------------------------------ #
    # Inputs
    # ------------------------------------------------------------------ #

    def note_agent_stt_activity(self, ev: Any = None) -> None:
        """AgentSession ``user_input_transcribed`` listener (sync, never raises).

        Only NON-EMPTY transcripts count as "the session's ears work". This
        matters because NeverFatalSTT degrades a broken STT endpoint into
        empty finals — if those counted as activity, a dead STT would stand
        the browser fallback down while producing nothing, and the agent
        would be deaf in both paths at once.
        """
        try:
            if not (getattr(ev, "transcript", "") or "").strip():
                return
            self._last_stt_activity = self._clock()
        except Exception:  # pragma: no cover — clock() failing is hypothetical
            pass

    async def on_transcript(self, message: dict[str, Any]) -> None:
        """Entry point for a ``transcript`` data-channel payload."""
        if self._closed:
            return
        try:
            verdict = self._aggregator.ingest(message, now=self._clock())
        except Exception:
            logger.debug("voice_transcript_ingest_failed", exc_info=True)
            return
        if verdict == "buffered":
            self._ensure_drain_task()
        # interim / agent_speaker / unattributed / duplicate / empty / invalid:
        # silent by design — interims alone arrive ~2/sec.

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    async def aclose(self) -> None:
        self._closed = True
        task = self._drain_task
        self._drain_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    def _ensure_drain_task(self) -> None:
        if self._drain_task is None or self._drain_task.done():
            self._drain_task = asyncio.create_task(
                self._drain_loop(), name=f"voice-transcripts:{self._agent_identity}"
            )

    async def _drain_loop(self) -> None:
        """Sleep until the earliest utterance is due, flush, repeat; exit idle."""
        try:
            while not self._closed:
                due_in = self._aggregator.next_due_in(now=self._clock())
                if due_in is None:
                    return
                if due_in > 0:
                    await asyncio.sleep(min(due_in, 0.25))
                    continue
                for utterance in self._aggregator.pop_due(now=self._clock()):
                    await self._handle_utterance(utterance)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.error("voice_transcript_drain_failed", exc_info=True)

    def _stt_recently_alive(self) -> bool:
        if self._last_stt_activity is None:
            return False
        return (self._clock() - self._last_stt_activity) <= self._stt_alive_window

    async def _handle_utterance(self, utterance: Utterance) -> None:
        """Guards, then the shared reply pipeline. Mirrors the text policy."""
        if not utterance.text:
            return

        # STT-alive arbitration: our own ears heard something recently → the
        # AgentSession replies by itself; the fallback must not double-fire.
        if self._stt_configured and self._stt_recently_alive():
            logger.info(
                "voice_transcript_stood_down_stt_alive",
                speaker=utterance.participant_id,
                chars=len(utterance.text),
            )
            return

        # ADDRESSING — voice dispatch v1 (docs/voice-dispatch-spec-2026-08-09).
        # One shared decision per room: name addressing, sticky follow-ups,
        # the nobody class, and the floor mutex. The old rule ("answer
        # everything unless another agent is here") made a sole resident agent
        # reply to two humans talking to each other.
        decision = None
        if voice_dispatch.dispatch_enabled():
            others, humans = call_roster(self._room, self._agent_identity)
            decision = voice_dispatch.decide(
                state=self._floor,
                me=self._brigade_agent_id,
                my_names=self._needles,
                speaker=utterance.participant_id,
                speaker_is_agent=is_agent_identity(utterance.participant_id),
                text=utterance.text,
                other_agent_names=others,
                human_count=humans,
                primary_agent=primary_agent_id(self._room),
                now=self._clock(),
            )
            # EVERY decision is logged with the rule that produced it — the
            # spec requires it, and a future classifier's eval set is real
            # logged decisions, never a synthetic holdout.
            logger.info(
                "voice_dispatch_decision",
                room=self._room_key,
                me=self._brigade_agent_id,
                speaker=utterance.participant_id,
                speaker_name=utterance.name,
                respond=decision.respond,
                rule=decision.rule,
                addressed=decision.addressed,
                other_agents=sorted(others),
                humans=humans,
                preview=utterance.text[:80],
            )
            if not decision.respond:
                return
        elif other_agents_present(self._room, self._agent_identity):
            # Kill switch engaged: the pre-dispatch behaviour, unchanged.
            if not spoken_mention(utterance.text, self._needles):
                logger.info(
                    "voice_transcript_not_addressed",
                    speaker=utterance.participant_id,
                    agents="multiple",
                )
                return

        # One reply at a time per room. Drop — never queue — so overlapping
        # utterances can't stack replies (matches the task latch contract).
        if self._reply_lock.locked():
            logger.info(
                "voice_transcript_dropped_reply_inflight",
                speaker=utterance.participant_id,
                chars=len(utterance.text),
            )
            voice_dispatch.observe_reply_finished(
                self._floor, self._brigade_agent_id
            )
            return

        if self._acquire_rate_slot is not None:
            try:
                if not await self._acquire_rate_slot():
                    logger.warning("voice_transcript_rate_limited")
                    voice_dispatch.observe_reply_finished(
                        self._floor, self._brigade_agent_id
                    )
                    return
            except Exception:
                logger.debug("voice_transcript_rate_check_failed", exc_info=True)

        async with self._reply_lock:
            logger.info(
                "voice_transcript_reply",
                speaker=utterance.participant_id,
                speaker_name=utterance.name,
                segments=len(utterance.segment_ids),
                chars=len(utterance.text),
                preview=utterance.text[:80],
            )

            # PERSIST CONTRACT (incident 2026-08-10): the human's spoken line
            # is written to history ONLY once a reply is actually committed on
            # some path. The voice-user-message route suppresses the server's
            # text reply, so persisting a line we then fail to answer produces
            # the worst outcome — silence in BOTH modalities. `commit` is
            # invoked by whichever reply path succeeds, exactly once, at the
            # earliest moment the reply is guaranteed (scheduled on a live
            # session / Brigade text obtained) so history keeps user→agent
            # order.
            committed = False

            def commit() -> None:
                nonlocal committed
                if committed or self._persist_user_utterance is None:
                    committed = True
                    return
                committed = True
                try:
                    self._persist_user_utterance(
                        utterance.participant_id, utterance.text
                    )
                except Exception:
                    logger.debug("voice_transcript_persist_failed", exc_info=True)

            try:
                delivered = await asyncio.wait_for(
                    self._speak_reply(utterance.text, commit),
                    timeout=self._REPLY_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                logger.warning("voice_transcript_reply_timeout")
                delivered = False
            except Exception:
                logger.error("voice_transcript_reply_failed", exc_info=True)
                delivered = False
            if not delivered:
                logger.error(
                    "voice_transcript_reply_failed_all_paths",
                    speaker=utterance.participant_id,
                    chars=len(utterance.text),
                    persisted=committed,
                )
            # The floor is released on EVERY exit from the turn, delivered or
            # not: a failed reply that kept the floor would mute every other
            # agent in the room until the lease expired.
            voice_dispatch.observe_reply_finished(
                self._floor, self._brigade_agent_id
            )

    async def _speak_reply(
        self, text: str, on_commit: Callable[[], None]
    ) -> bool:
        """Deliver one spoken reply; True only if SOME path succeeded.

        Ladder (incident 2026-08-10 — "AgentSession isn't running"):
          1. The session pipeline (``generate_reply``): Brigade LLM → TTS →
             caption tee → history listeners. The shared path; nothing forked.
          2. The session is DEAD (RuntimeError from generate_reply — the
             session closes itself after max_unrecoverable_errors STT/LLM/TTS
             failures): ask the owner for ONE restart and replay the
             utterance through the fresh session.
          3. Restart failed: the bounded emergency fork — the owner's
             direct_reply (Brigade text + persist + captions + best-effort
             TTS publish), clearly logged ``voice_reply_via_direct_path``.
             The agent must never sit visibly present and mute.
        """
        try:
            await self._speak_via_session(self._session, text, on_commit)
            return True
        except RuntimeError as exc:
            # "AgentSession isn't running" — the session closed under us.
            logger.warning(
                "voice_session_not_running",
                error=str(exc),
                will_restart=self._restart_session is not None,
            )
        except Exception:
            # A live session failed mid-generation (LLM/TTS trouble). The
            # session's own error handling owns that case; don't restart-loop
            # on top of it.
            logger.error("voice_transcript_session_reply_failed", exc_info=True)
            return False

        if self._restart_session is not None:
            fresh: Any | None = None
            try:
                fresh = await self._restart_session()
            except Exception:
                logger.error("voice_session_restart_failed", exc_info=True)
            if fresh is not None:
                self._session = fresh
                try:
                    await self._speak_via_session(fresh, text, on_commit)
                    logger.info("voice_reply_after_session_restart", chars=len(text))
                    return True
                except Exception:
                    logger.error(
                        "voice_reply_replay_failed_after_restart", exc_info=True
                    )

        if self._direct_reply is not None:
            try:
                if await self._direct_reply(text, on_commit):
                    logger.warning("voice_reply_via_direct_path", chars=len(text))
                    return True
            except Exception:
                logger.error("voice_direct_reply_failed", exc_info=True)

        return False

    async def _speak_via_session(
        self, session: Any, text: str, on_commit: Callable[[], None]
    ) -> None:
        """``AgentSession.generate_reply(user_input=...)`` — THE shared pipeline.

        This is the same entry the session's own turn loop uses: Brigade LLM →
        TTS playout, with the reply teed into live captions
        (``transcription_node``) and persisted by the ``conversation_item_added``
        listeners. Version-tolerant across livekit-agents 1.x return shapes
        (SpeechHandle, awaitable, or awaitable→SpeechHandle). Raises on any
        failure so the caller can walk the recovery ladder.
        """
        generate = getattr(session, "generate_reply", None)
        if not callable(generate):
            raise RuntimeError(
                f"session {type(session).__name__} has no generate_reply"
            )

        result: Any = generate(user_input=text)
        if inspect.isawaitable(result):
            result = await result
        # The reply is now scheduled on a LIVE session: the user turn may be
        # committed to history (the assistant item lands after it, keeping
        # conversational order).
        on_commit()
        # Hold the latch through playout when the handle exposes a waiter.
        for waiter_name in ("wait_for_playout", "join"):
            waiter = getattr(result, waiter_name, None)
            if callable(waiter):
                out = waiter()
                if inspect.isawaitable(out):
                    await out
                return
        if inspect.isawaitable(result):  # pragma: no cover — belt & braces
            await result
