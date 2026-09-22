"""Voice dispatch v1 — who, if anyone, answers a spoken utterance.

Rules-only implementation of docs/voice-dispatch-spec-2026-08-09.md §2/§4/§5.
The spec's own words: rules-only is not a stepping stone, it is "the permanent
bottom fallback tier" — the floor that keeps working when every model tier is
down. A classifier can be layered on top later for the ambiguous residue; it
does not replace any rule here.

THE PROBLEM THIS SOLVES. Every agent worker used to decide for itself whether
to answer, and the only guard was "is another agent in the room?". With ONE
resident agent that guard is vacuous, so the agent answered every human
utterance in the call — including two humans talking to each other. That is
the pile-on the spec predicted, in its simplest form: independent per-agent
decisions cannot produce room-level etiquette.

THE FOUR LAYERS (spec §2), in the order they fire:

  0. Agents ignore agents. An agent's speech never dispatches another agent.
  1. NAME ADDRESSING. "Majik, what's the status" routes to majik and to nobody
     else. A name that matches a DIFFERENT resident is a positive signal that
     this utterance is not ours.
  2. STICKY TURN-TAKING. After you address an agent, YOUR unnamed follow-ups
     keep going to that agent until the window lapses or someone re-addresses.
     Stickiness is keyed to the SPEAKER, deliberately: "Majik, mute the bed" /
     "and drop the tempo" is one person continuing one thread, whereas the
     other human answering back is a different conversation. Room-wide
     stickiness would swallow exactly the human-to-human speech layer 3
     exists to protect.
  3. THE NOBODY CLASS. Unaddressed speech, with no sticky claim, dispatches
     NOBODY. This is the layer Aaron actually asked for and the spec calls
     critical.

  Plus the FLOOR MUTEX: exactly one agent may hold the speaking floor in a
  room at a time (one-hot voice, mirroring the one-hot-mic doctrine). It is
  the backstop that caps the bad case even when a rule misfires.

THE SOLO-HUMAN EXCEPTION. With exactly one human in the call, unaddressed
speech goes to ONE designated agent — the co-host — and every other agent
still waits to be named. Alone with one agent that is just the DM rule the
text responder already uses; alone with several it is the show format: a
co-host who is always listening, and specialists you call on by name. Without
a designated agent, unaddressed speech with several agents present would be
answered by whichever worker won the race for the floor, which is
nondeterministic and, on a recorded show, arbitrary.

The moment a SECOND HUMAN joins, addressing is required from everyone,
co-host included: two people talking to each other is the nobody class, and
that is the whole point of it.

WHO THE CO-HOST IS. ``voice_primary_agent_id`` in the room metadata, and
nothing else. When that key is unset, nobody is the co-host — the old
fallback to ``brigade_agent_id`` followed whoever was invited last, and a
show cannot change co-host by inviting a specialist. An explicit
``nobody`` / ``none`` / ``off`` is the same outcome, written on purpose.
The sole-agent exception (one human, one agent, a DM) still answers
unaddressed speech; that is not a co-host.

PLACEMENT. The spec wants one authority. ``RoomFloor`` is the in-memory
shape; ``agent_runtime.floor_store`` is the shared one (InMemory for tests,
Redis when ``VOICE_FLOOR_BACKEND=redis`` or ``VOICE_FLOOR_REDIS_URL`` is
set) so every agents container and the relay hold one lease. The kill
switch is unchanged.

EVERY DECISION IS LOGGED by the caller with the rule that produced it — the
spec requires it, and the eval set for any future classifier is real logged
decisions, never synthetic holdout.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import structlog

logger = structlog.get_logger(__name__)

__all__ = [
    "Decision",
    "RoomFloor",
    "dispatch_enabled",
    "decide",
    "decision_record",
    "set_decision_recorder",
    "STICKY_WINDOW_S",
    "FLOOR_LEASE_S",
    "spoken_name_match",
    "fuzzy_spoken_name_match",
    "log_name_near_miss",
    "floor_for",
    "forget_room",
]

#: How long a speaker's claim on an agent survives without re-addressing.
#: Long enough for "and what about the audio?" to follow "Majik, status?";
#: short enough that the conversation moving on releases the agent.
STICKY_WINDOW_S = 30.0

#: How long a floor claim can be held before it is presumed abandoned. A reply
#: releases the floor explicitly; this only covers a worker that dies mid-turn,
#: which must not silence the room forever.
FLOOR_LEASE_S = 120.0

_ENV_FLAG = "VOICE_DISPATCH_ENABLED"


def dispatch_enabled() -> bool:
    """Kill switch. Unset ⇒ ON.

    Set ``VOICE_DISPATCH_ENABLED=0`` to restore the previous behaviour exactly
    (every worker decides for itself) without a rollback — the escape hatch a
    live show needs when a rule misbehaves on air.
    """
    raw = os.getenv(_ENV_FLAG)
    if raw is None:
        return True
    return raw.strip().lower() not in ("0", "false", "no", "off")


@dataclass(frozen=True)
class Decision:
    """The outcome for ONE agent considering ONE utterance."""

    #: Should THIS agent reply?
    respond: bool
    #: The rule that decided it — logged verbatim, and the label a future
    #: classifier's eval set is keyed on.
    rule: str
    #: The agent this utterance was addressed to, when known.
    addressed: str | None = None


#: Words that introduce an address ("hey Majik", "ok Majik", "so Majik").
_ADDRESS_CUES = frozenset(
    {
        "hey", "hi", "hello", "ok", "okay", "so", "and", "but", "alright",
        "right", "yo", "um", "uh", "well", "now", "please", "thanks",
    }
)


def _addresses(text_lc: str, name: str) -> bool:
    """Is ``name`` used to ADDRESS someone in ``text_lc``, not merely present?

    Presence alone is not address, and the difference is not academic: the
    agent id ``the-general`` occurs verbatim inside "that is the general
    idea", so a presence test dispatches an agent into a sentence about
    something else. That is precisely the nobody class failing, and on a
    recorded show it is an agent talking over the host.

    A name counts as an address when it sits where a name sits when you are
    talking TO someone:
      * at the start of the utterance — "Majik, status?";
      * right after an address cue or any punctuation — "hey Majik", "ok, Majik";
      * immediately before punctuation — "what do you think, Majik?".
    Everything else is the name being MENTIONED, which dispatches nobody.
    """
    for match in re.finditer(
        rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])", text_lc
    ):
        start, end = match.start(), match.end()
        before = text_lc[:start].strip()
        after = text_lc[end:].lstrip()
        if not before:
            return True  # utterance opens with the name
        if before[-1] in ",.!?:;":
            return True  # "...done, Majik do the next one"
        if before.split()[-1] in _ADDRESS_CUES:
            return True  # "hey Majik", "so Majik"
        if after[:1] in (",", "?", "!", ".", ":", ";"):
            return True  # "what do you think, Majik?"
    return False


def spoken_name_match(text: str, names: set[str] | frozenset[str]) -> bool:
    """Whether ``text`` ADDRESSES one of ``names`` by spoken name.

    Case-insensitive, word-boundary, and position-aware (see ``_addresses``).
    Speech has no ``@``, so the bare name in an address position is the only
    address form available.
    """
    lc = (text or "").lower()
    if not lc:
        return False
    return any(
        _addresses(lc, n.strip().lower()) for n in names if n and n.strip()
    )


_FIRST_TOKEN = re.compile(r"[a-z']+")


def _first_token(text_lc: str) -> str:
    match = _FIRST_TOKEN.search(text_lc or "")
    return match.group(0) if match else ""


def _edit_distance(a: str, b: str, cap: int = 2) -> int:
    """Levenshtein with an early exit once the distance exceeds ``cap``."""
    if a == b:
        return 0
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        row = [i]
        min_row = i
        for j, cb in enumerate(b, 1):
            ins = row[j - 1] + 1
            delete = prev[j] + 1
            sub = prev[j - 1] + (ca != cb)
            val = min(ins, delete, sub)
            row.append(val)
            if val < min_row:
                min_row = val
        if min_row > cap:
            return cap + 1
        prev = row
    return prev[-1]


def fuzzy_spoken_name_match(text: str, names: set[str] | frozenset[str]) -> bool:
    """Leading token is one edit from a name of length >= 4.

    Whisper ate a leading synthetic "Rook," twice on 2026-08-30 (human
    "hey rook" worked). A one-edit first-token match recovers "ruk",
    "rook", "rooks" without treating every mention as an address.
    Names shorter than 4 are skipped: one edit on "maj" is too greedy.
    """
    token = _first_token((text or "").lower())
    if len(token) < 3:
        return False
    for raw in names:
        name = (raw or "").strip().lower()
        if not name:
            continue
        needle = name.split()[0]
        if len(needle) < 4:
            continue
        # First letter must match: "look" is one edit from "rook" and is a
        # real English word. Whisper mutating the rest of the name is the
        # failure we recover; swapping the onset is not.
        if token[0] != needle[0]:
            continue
        if _edit_distance(token, needle, cap=1) <= 1:
            return True
    return False


def log_name_near_miss(
    text: str, names: set[str] | frozenset[str]
) -> str | None:
    """Reason string when a line looks like a missed address, else None.

    Logged so a miss is visible instead of silent. Two shapes:
      * the name is IN the line but not in an address position
      * the first token is two edits from a name (close, not close enough)
    """
    lc = (text or "").lower()
    if not lc:
        return None
    token = _first_token(lc)
    for raw in names:
        name = (raw or "").strip().lower()
        if not name:
            continue
        if name in lc and not spoken_name_match(text, {name}):
            return f"mention_not_address:{name}"
        needle = name.split()[0]
        if token and len(needle) >= 4:
            dist = _edit_distance(token, needle, cap=2)
            if dist == 2:
                return f"fuzzy_distance_2:{token}~{needle}"
    return None


@dataclass
class _Claim:
    agent: str
    at: float


@dataclass
class _FloorHold:
    agent: str
    at: float


@dataclass
class RoomFloor:
    """Per-room dispatch state: who is sticky for whom, and who holds the floor.

    One instance per room, shared by every worker in the process (see the
    module docstring on placement). All methods take an explicit ``now`` so
    tests never sleep and behaviour is reproducible.
    """

    #: speaker participant id → the agent they last addressed
    sticky: dict[str, _Claim] = field(default_factory=dict)
    _floor: _FloorHold | None = None

    # -- stickiness ---------------------------------------------------- #

    def claim(self, speaker: str, agent: str, *, now: float) -> None:
        """Record that ``speaker`` addressed ``agent`` by name."""
        if speaker:
            self.sticky[speaker] = _Claim(agent=agent, at=now)

    def sticky_agent(self, speaker: str, *, now: float) -> str | None:
        """The agent ``speaker`` is still in conversation with, if any."""
        claim = self.sticky.get(speaker)
        if claim is None:
            return None
        if now - claim.at > STICKY_WINDOW_S:
            self.sticky.pop(speaker, None)
            return None
        return claim.agent

    def release_speaker(self, speaker: str) -> None:
        """Drop a speaker's claim (they addressed someone else, or a human)."""
        self.sticky.pop(speaker, None)

    # -- floor mutex ---------------------------------------------------- #

    def floor_holder(self, *, now: float) -> str | None:
        hold = self._floor
        if hold is None:
            return None
        if now - hold.at > FLOOR_LEASE_S:
            # A worker died mid-turn. An expired lease must never mute a room
            # permanently — that failure is worse than a rare double-reply.
            self._floor = None
            return None
        return hold.agent

    def take_floor(self, agent: str, *, now: float) -> bool:
        """Claim the speaking floor. False when another agent already holds it."""
        holder = self.floor_holder(now=now)
        if holder is not None and holder != agent:
            return False
        self._floor = _FloorHold(agent=agent, at=now)
        return True

    def release_floor(self, agent: str) -> None:
        if self._floor is not None and self._floor.agent == agent:
            self._floor = None


def floor_for(room_key: str) -> Any:
    """The shared dispatch state for a room (created on first use).

    Backed by the process ``FloorStore`` — in-memory unless Redis was
    configured — so two workers in two containers take one lease.
    """
    from agent_runtime.floor_store import bind_room

    return bind_room(room_key)


def forget_room(room_key: str) -> None:
    """Drop a room's state when its call ends, so this never grows unbounded."""
    from agent_runtime.floor_store import forget_room as _forget

    _forget(room_key)


_recorder: Callable[[dict[str, Any]], None] | None = None


def set_decision_recorder(fn: Callable[[dict[str, Any]], None] | None) -> None:
    """Where every ``decide()`` writes its record. ``None`` keeps tests quiet.

    Production installs a poster that appends an ``agent_events`` row of type
    ``voice_dispatch`` and asks the server to fan the same decision out as a
    room-scoped WebSocket event. The recorder must not raise into the voice
    loop; ``decide`` swallows a failure.
    """
    global _recorder
    _recorder = fn


def text_hash(text: str) -> str:
    """Short hash of the utterance. The eval log stores this, not the words."""
    raw = (text or "").strip().lower().encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def decision_record(
    decision: Decision,
    *,
    me: str,
    state: Any,
    now: float,
    room: str,
    speaker: str,
    text: str,
    human_count: int,
    shared_mic: bool,
    agent_identity: str = "",
) -> dict[str, Any]:
    """The ``voice_dispatch`` event body. No utterance text."""
    winner: str | None
    if decision.respond:
        winner = me or None
    elif decision.rule in ("addressed_other_agent", "sticky_other_agent"):
        winner = decision.addressed
    elif decision.rule == "floor_busy":
        try:
            winner = state.floor_holder(now=now)
        except Exception:
            winner = None
    else:
        winner = None
    return {
        "room": room or "",
        "speaker": speaker or "",
        "text_hash": text_hash(text),
        "rule": decision.rule,
        "winner": winner,
        "human_count": int(human_count),
        "shared_mic": bool(shared_mic),
        "agent_identity": agent_identity or "voice-dispatch",
        "agent_type": "voice",
    }


def _emit(record: dict[str, Any]) -> None:
    fn = _recorder
    if fn is None:
        return
    try:
        fn(record)
    except Exception:
        logger.debug("voice_dispatch_record_failed", exc_info=True)


def decide(
    *,
    state: Any = None,
    me: str,
    my_names: set[str] | frozenset[str],
    speaker: str,
    speaker_is_agent: bool,
    text: str,
    other_agent_names: dict[str, set[str]],
    human_count: int,
    primary_agent: str | None = None,
    now: float | None = None,
    shared_mic: bool = False,
    room: str = "",
    store: Any = None,
    room_key: str = "",
    agent_identity: str = "",
) -> Decision:
    """Should *this* agent answer *this* utterance?

    ``me`` is my agent id; ``my_names`` the spoken forms of it.
    ``other_agent_names`` maps every OTHER resident agent id to its spoken
    forms — needed so "General, thoughts?" is recognised as *addressed
    elsewhere* rather than merely *not addressed to me*.
    ``human_count`` is the number of humans the caller counted. ``shared_mic``
    floors that at 2 for the solo rule: two people on one device must not
    look like a DM. The logged ``human_count`` stays the caller's number.
    ``primary_agent`` is the room's designated co-host, if any — the only
    agent that answers unaddressed speech when one human is present.
    Pass ``state`` (a ``RoomFloor`` or a bound store) or ``store`` plus
    ``room_key`` when two clients must share one floor.

    Every return is recorded. The recorder is a no-op until one is installed.
    """
    now = time.monotonic() if now is None else now
    if state is None:
        if store is None:
            raise TypeError("decide() requires state or store")
        from agent_runtime.floor_store import BoundFloor

        state = BoundFloor(store, (room_key or room or "room"))
    ruled_humans = int(human_count)
    if shared_mic and ruled_humans < 2:
        ruled_humans = 2

    def finish(decision: Decision) -> Decision:
        _emit(
            decision_record(
                decision,
                me=me,
                state=state,
                now=now,
                room=room or room_key,
                speaker=speaker,
                text=text,
                human_count=int(human_count),
                shared_mic=shared_mic,
                agent_identity=agent_identity,
            )
        )
        return decision

    # 0. Agents ignore agents (spec §2). Without this, one agent's TTS is
    #    another's prompt and the room never stops talking.
    if speaker_is_agent:
        return finish(Decision(False, "agent_speech_ignored"))

    if not (text or "").strip():
        return finish(Decision(False, "empty_utterance"))

    addressed_me = spoken_name_match(text, my_names)
    addressed_other = next(
        (
            agent
            for agent, names in other_agent_names.items()
            if agent != me and spoken_name_match(text, names)
        ),
        None,
    )

    # 1. NAME ADDRESSING.
    if addressed_me:
        # An explicit address re-points stickiness even mid-conversation.
        state.claim(speaker, me, now=now)
        if not state.take_floor(me, now=now):
            return finish(Decision(False, "floor_busy", addressed=me))
        return finish(Decision(True, "addressed_by_name", addressed=me))

    if addressed_other is not None:
        # Someone else was named. Their claim, not ours — and this speaker's
        # sticky claim on us is over.
        state.claim(speaker, addressed_other, now=now)
        return finish(Decision(False, "addressed_other_agent", addressed=addressed_other))

    # 2. STICKY TURN-TAKING — the speaker's own unnamed follow-up.
    held = state.sticky_agent(speaker, now=now)
    if held == me:
        if not state.take_floor(me, now=now):
            return finish(Decision(False, "floor_busy", addressed=me))
        return finish(Decision(True, "sticky_follow_up", addressed=me))
    if held is not None:
        return finish(Decision(False, "sticky_other_agent", addressed=held))

    # 3. SOLO-HUMAN EXCEPTION — the co-host answers when nobody was named.
    #    A shared mic counts as at least two humans, so this cannot fire
    #    while two people are talking through one device.
    if ruled_humans <= 1:
        sole_agent = not other_agent_names
        am_cohost = primary_agent is not None and primary_agent == me
        if sole_agent or am_cohost:
            if not state.take_floor(me, now=now):
                return finish(Decision(False, "floor_busy", addressed=me))
            rule = "solo_human_sole_agent" if sole_agent else "solo_human_cohost"
            return finish(Decision(True, rule, addressed=me))
        # Several agents and I am not the co-host: wait to be named. Falls
        # through to the nobody class below so the log names the real reason.

    # 4. THE NOBODY CLASS. Humans talking to each other, or to no one.
    return finish(Decision(False, "addressed_to_nobody"))


def observe_reply_finished(state: Any, me: str) -> None:
    """Release the floor after a reply completes (success or failure)."""
    state.release_floor(me)


def make_room_key(room_name: str | None, fallback: str = "unknown-room") -> str:
    return (room_name or "").strip() or fallback


#: Injection point for tests that need a deterministic clock.
Clock = Callable[[], float]
