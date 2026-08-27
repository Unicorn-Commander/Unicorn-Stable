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
speech goes to the sole resident agent: alone in a room with one agent, you
are talking to it — the DM rule the text responder already uses. The moment a
second human joins, addressing is required. This is what lets a solo recording
session stay conversational while a two-person show stays quiet.

PLACEMENT, HONESTLY. The spec says the dispatcher belongs in the server,
"single authority". This module is a single authority for every worker in the
agents runtime process, which is where all of a room's workers actually run
today (one `stable-agents` container, registry.py runs each agent as a job in
it). That is genuinely one decision-maker per room right now — but it is
process-local, so a SECOND agents container would split the authority and the
floor mutex would stop being a mutex. `RoomFloor` is deliberately the only
stateful piece and its whole surface is four methods, so backing it with Redis
(or moving it behind a backend endpoint, as the spec prefers) is a contained
change. Do that before running a second agents replica.

EVERY DECISION IS LOGGED by the caller with the rule that produced it — the
spec requires it, and the eval set for any future classifier is real logged
decisions, never synthetic holdout.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Callable

__all__ = [
    "Decision",
    "RoomFloor",
    "dispatch_enabled",
    "decide",
    "STICKY_WINDOW_S",
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


def _needle_pattern(name: str) -> str:
    return rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])"


def spoken_name_match(text: str, names: set[str] | frozenset[str]) -> bool:
    """Whether ``text`` addresses one of ``names`` by bare spoken name.

    Word-boundary, case-insensitive. Speech has no ``@``, so the bare name is
    the address form (mirrors voice_transcripts.spoken_mention, kept separate
    so the dispatcher owns its own matching and can be tested alone).
    """
    lc = (text or "").lower()
    if not lc:
        return False
    return any(
        re.search(_needle_pattern(n.strip().lower()), lc)
        for n in names
        if n and n.strip()
    )


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


_ROOMS: dict[str, RoomFloor] = {}


def floor_for(room_key: str) -> RoomFloor:
    """The shared dispatch state for a room (created on first use)."""
    state = _ROOMS.get(room_key)
    if state is None:
        state = RoomFloor()
        _ROOMS[room_key] = state
    return state


def forget_room(room_key: str) -> None:
    """Drop a room's state when its call ends, so this never grows unbounded."""
    _ROOMS.pop(room_key, None)


def decide(
    *,
    state: RoomFloor,
    me: str,
    my_names: set[str] | frozenset[str],
    speaker: str,
    speaker_is_agent: bool,
    text: str,
    other_agent_names: dict[str, set[str]],
    human_count: int,
    now: float | None = None,
) -> Decision:
    """Should *this* agent answer *this* utterance?

    ``me`` is my agent id; ``my_names`` the spoken forms of it.
    ``other_agent_names`` maps every OTHER resident agent id to its spoken
    forms — needed so "General, thoughts?" is recognised as *addressed
    elsewhere* rather than merely *not addressed to me*.
    ``human_count`` is the number of humans in the call (drives the solo rule).

    Pure apart from ``state``: no I/O, no clock unless one is omitted.
    """
    now = time.monotonic() if now is None else now

    # 0. Agents ignore agents (spec §2). Without this, one agent's TTS is
    #    another's prompt and the room never stops talking.
    if speaker_is_agent:
        return Decision(False, "agent_speech_ignored")

    if not (text or "").strip():
        return Decision(False, "empty_utterance")

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
            return Decision(False, "floor_busy", addressed=me)
        return Decision(True, "addressed_by_name", addressed=me)

    if addressed_other is not None:
        # Someone else was named. Their claim, not ours — and this speaker's
        # sticky claim on us is over.
        state.claim(speaker, addressed_other, now=now)
        return Decision(False, "addressed_other_agent", addressed=addressed_other)

    # 2. STICKY TURN-TAKING — the speaker's own unnamed follow-up.
    held = state.sticky_agent(speaker, now=now)
    if held == me:
        if not state.take_floor(me, now=now):
            return Decision(False, "floor_busy", addressed=me)
        return Decision(True, "sticky_follow_up", addressed=me)
    if held is not None:
        return Decision(False, "sticky_other_agent", addressed=held)

    # 3. SOLO-HUMAN EXCEPTION — one human, one agent: they are talking to us.
    if human_count <= 1 and not other_agent_names:
        if not state.take_floor(me, now=now):
            return Decision(False, "floor_busy", addressed=me)
        return Decision(True, "solo_human_sole_agent", addressed=me)

    # 4. THE NOBODY CLASS. Humans talking to each other, or to no one.
    return Decision(False, "addressed_to_nobody")


def observe_reply_finished(state: RoomFloor, me: str) -> None:
    """Release the floor after a reply completes (success or failure)."""
    state.release_floor(me)


def make_room_key(room_name: str | None, fallback: str = "unknown-room") -> str:
    return (room_name or "").strip() or fallback


#: Injection point for tests that need a deterministic clock.
Clock = Callable[[], float]
