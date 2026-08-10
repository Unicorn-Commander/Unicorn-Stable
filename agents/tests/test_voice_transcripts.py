"""Browser-STT fallback ears — the pure grouping/dedupe/addressing logic.

Regression cover for the 2026-08-08 mute-agent call: the web published
`transcript` data messages (humanTranscript.ts) and the worker warn-dropped
every one, so Majik never heard Aaron. These tests pin the classification
(interims silent, agents excluded, version-tolerant fields), the segment
grouping (mid-thought pauses collapse into ONE utterance), the dedupe, and the
responder's guards (latch, STT-alive stand-down, spoken addressing).

Deliberately no livekit import anywhere on this path — the module under test
keeps its livekit surface duck-typed so this suite runs on a bare host.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from agent_runtime.voice_transcripts import (
    TranscriptAggregator,
    Utterance,
    VoiceTranscriptResponder,
    classify_transcript,
    mention_needles,
    other_agents_present,
    spoken_mention,
)


def line(
    text: str,
    *,
    final: bool = True,
    participant: str = "aaron_11111111-2222-3333-4444-555555555555",
    name: str = "Aaron",
    segment: str | None = "seg-1",
    ts: int | None = 1_000,
    source: str | None = "local_mic",
) -> dict:
    msg: dict = {
        "type": "transcript",
        "participantId": participant,
        "name": name,
        "text": text,
        "isFinal": final,
    }
    if segment is not None:
        msg["segmentId"] = segment
    if ts is not None:
        msg["ts"] = ts
    if source is not None:
        msg["source"] = source
    return msg


# ---------------------------------------------------------------------------
# classify_transcript
# ---------------------------------------------------------------------------


def test_interims_are_ignored_silently() -> None:
    verdict, norm = classify_transcript(line("hel", final=False))
    assert verdict == "interim"
    assert norm is None


def test_final_from_human_is_accepted() -> None:
    verdict, norm = classify_transcript(line("hello majik"))
    assert verdict == "final"
    assert norm is not None
    assert norm["text"] == "hello majik"
    assert norm["segment_id"] == "seg-1"


def test_agent_identity_never_counts_as_speaker() -> None:
    verdict, _ = classify_transcript(
        line("as I was saying", participant="agent-brigade", name="Majik")
    )
    assert verdict == "agent_speaker"


def test_agent_sourced_lines_are_excluded() -> None:
    # `agent` = the agent's own spoken reply; `agent_stt` = ANOTHER worker's
    # re-publish of the same human words. Replying to either double-answers.
    for source in ("agent", "agent_stt"):
        verdict, _ = classify_transcript(line("hello there", source=source))
        assert verdict == "agent_speaker", source


def test_unattributed_speaker_is_refused() -> None:
    verdict, _ = classify_transcript(
        line("who said this", participant="human", name="Unidentified speaker")
    )
    assert verdict == "unattributed"


def test_missing_segment_id_and_ts_do_not_crash() -> None:
    verdict, norm = classify_transcript(
        line("version tolerant", segment=None, ts=None), now_ms=42_000
    )
    assert verdict == "final"
    assert norm is not None
    assert norm["ts_ms"] == 42_000
    assert norm["segment_id"]  # synthesized


def test_sourceless_lines_from_older_web_bundles_still_count() -> None:
    verdict, _ = classify_transcript(line("old client", source=None))
    assert verdict == "final"


def test_garbage_payloads_are_invalid_not_exceptions() -> None:
    assert classify_transcript(None)[0] == "invalid"
    assert classify_transcript("nope")[0] == "invalid"  # type: ignore[arg-type]
    assert classify_transcript({"type": "transcript", "isFinal": True})[0] in (
        "empty",
        "unattributed",
    )


# ---------------------------------------------------------------------------
# TranscriptAggregator — grouping + dedupe
# ---------------------------------------------------------------------------


def test_duplicate_segment_ids_are_dropped() -> None:
    agg = TranscriptAggregator(group_window=1.5)
    assert agg.ingest(line("hello"), now=0.0) == "buffered"
    assert agg.ingest(line("hello"), now=0.1) == "duplicate"
    due = agg.pop_due(now=2.0)
    assert len(due) == 1
    assert due[0].text == "hello"


def test_consecutive_finals_within_window_group_into_one_utterance() -> None:
    """A mid-thought pause must NOT trigger two replies."""
    agg = TranscriptAggregator(group_window=1.5)
    agg.ingest(line("so about the deploy", segment="a", ts=1000), now=0.0)
    # 1.0s pause — inside the window; the deadline slides forward.
    agg.ingest(line("let's ship tonight", segment="b", ts=2000), now=1.0)

    assert agg.pop_due(now=1.6) == []  # window restarted at 1.0
    due = agg.pop_due(now=2.6)
    assert len(due) == 1
    utterance = due[0]
    assert utterance.text == "so about the deploy let's ship tonight"
    assert utterance.segment_ids == ("a", "b")
    assert utterance.first_ts_ms == 1000
    assert utterance.last_ts_ms == 2000


def test_finals_after_the_window_are_a_new_utterance() -> None:
    agg = TranscriptAggregator(group_window=1.5)
    agg.ingest(line("first thought", segment="a"), now=0.0)
    first = agg.pop_due(now=1.6)
    assert [u.text for u in first] == ["first thought"]

    agg.ingest(line("second thought", segment="b"), now=5.0)
    second = agg.pop_due(now=6.6)
    assert [u.text for u in second] == ["second thought"]


def test_speakers_group_independently() -> None:
    agg = TranscriptAggregator(group_window=1.5)
    agg.ingest(line("aaron speaking", segment="a", participant="p-aaron"), now=0.0)
    agg.ingest(line("jordan speaking", segment="b", participant="p-jordan"), now=0.5)
    due = sorted(agg.pop_due(now=2.5), key=lambda u: u.participant_id)
    assert [(u.participant_id, u.text) for u in due] == [
        ("p-aaron", "aaron speaking"),
        ("p-jordan", "jordan speaking"),
    ]


def test_next_due_in_tracks_the_earliest_deadline() -> None:
    agg = TranscriptAggregator(group_window=1.5)
    assert agg.next_due_in(now=0.0) is None
    agg.ingest(line("hello", segment="a"), now=0.0)
    due_in = agg.next_due_in(now=0.5)
    assert due_in is not None
    assert abs(due_in - 1.0) < 1e-6
    assert agg.next_due_in(now=9.0) == 0.0


def test_interims_never_reach_the_buffer() -> None:
    agg = TranscriptAggregator(group_window=1.5)
    assert agg.ingest(line("hel", final=False, segment="i1"), now=0.0) == "interim"
    assert agg.pop_due(now=10.0) == []


def test_dedupe_memory_is_bounded() -> None:
    agg = TranscriptAggregator(group_window=0.0, dedupe_capacity=16)
    for i in range(200):
        agg.ingest(line(f"line {i}", segment=f"seg-{i}"), now=float(i))
        agg.pop_due(now=float(i) + 1.0)
    assert len(agg._seen) <= 16  # noqa: SLF001 — bound is the contract


# ---------------------------------------------------------------------------
# Addressing
# ---------------------------------------------------------------------------


def test_spoken_mention_matches_bare_names_with_word_boundaries() -> None:
    needles = mention_needles("majik")
    assert spoken_mention("Majik, what do you think?", needles)
    assert spoken_mention("hey majik what's up", needles)
    assert spoken_mention("@majik ping", needles)  # typed style still matches
    assert not spoken_mention("the majikarp is evolving", needles)
    assert not spoken_mention("nothing for you here", needles)


def test_mention_needles_include_spaced_id_forms() -> None:
    needles = mention_needles("corporal-qwen", "brigade")
    assert "corporal qwen" in needles
    assert "corporal-qwen" in needles
    assert spoken_mention("corporal qwen take this one", needles)


def test_other_agents_present_ignores_self_and_humans() -> None:
    def room_with(*identities: str):
        return SimpleNamespace(
            remote_participants={
                i: SimpleNamespace(identity=i) for i in identities
            }
        )

    me = "agent-brigade"
    assert not other_agents_present(room_with("aaron_uuid"), me)
    assert not other_agents_present(room_with("aaron_uuid", me), me)
    assert other_agents_present(room_with("aaron_uuid", "agent-triage"), me)
    assert not other_agents_present(SimpleNamespace(), me)  # no attr → False


# ---------------------------------------------------------------------------
# VoiceTranscriptResponder — guards around the shared pipeline
# ---------------------------------------------------------------------------


class FakeSpeechHandle:
    def __init__(self) -> None:
        self.waited = False

    async def wait_for_playout(self) -> None:
        self.waited = True


class FakeSession:
    def __init__(self) -> None:
        self.replies: list[str] = []
        self.handle = FakeSpeechHandle()

    def generate_reply(self, *, user_input: str) -> FakeSpeechHandle:
        self.replies.append(user_input)
        return self.handle


def human_room() -> SimpleNamespace:
    return SimpleNamespace(
        remote_participants={
            "aaron_uuid": SimpleNamespace(identity="aaron_uuid"),
        }
    )


def make_responder(
    *,
    session: FakeSession | None = None,
    room: SimpleNamespace | None = None,
    stt_configured: bool = False,
    persisted: list | None = None,
    restart_session=None,
    direct_reply=None,
    clock=None,
) -> tuple[VoiceTranscriptResponder, FakeSession]:
    fake = session or FakeSession()
    responder = VoiceTranscriptResponder(
        session=fake,
        room=room or human_room(),
        agent_identity="agent-brigade",
        brigade_agent_id="majik",
        stt_configured=stt_configured,
        group_window=0.0,  # tests flush immediately
        stt_grace=0.0,
        stt_alive_window=12.0,
        persist_user_utterance=(
            (lambda pid, text: persisted.append((pid, text)))
            if persisted is not None
            else None
        ),
        restart_session=restart_session,
        direct_reply=direct_reply,
        clock=clock or (lambda: 0.0),
    )
    return responder, fake


def utterance(text: str = "hello majik") -> Utterance:
    return Utterance(
        participant_id="aaron_uuid",
        name="Aaron",
        text=text,
        segment_ids=("s1",),
        first_ts_ms=0,
        last_ts_ms=0,
    )


def test_utterance_flows_into_generate_reply_and_persists() -> None:
    async def run() -> None:
        persisted: list = []
        responder, session = make_responder(persisted=persisted)
        await responder._handle_utterance(utterance("ship it tonight"))
        assert session.replies == ["ship it tonight"]
        assert session.handle.waited  # latch held through playout
        assert persisted == [("aaron_uuid", "ship it tonight")]

    asyncio.run(run())


def test_stt_alive_stands_the_fallback_down() -> None:
    """When our own ears heard something recently, the session replies itself —
    the browser path must NOT double-fire."""

    async def run() -> None:
        now = {"t": 100.0}
        responder, session = make_responder(
            stt_configured=True, clock=lambda: now["t"]
        )
        responder.note_agent_stt_activity(
            SimpleNamespace(transcript="real words")
        )  # heard at t=100
        now["t"] = 105.0  # within the 12s alive window
        await responder._handle_utterance(utterance())
        assert session.replies == []

        now["t"] = 150.0  # alive window expired → fallback takes over
        await responder._handle_utterance(utterance("are you there"))
        assert session.replies == ["are you there"]

    asyncio.run(run())


def test_empty_stt_events_do_not_count_as_alive() -> None:
    """NeverFatalSTT degrades a dead endpoint into EMPTY finals. Those must
    not stand the browser fallback down — otherwise the agent is deaf on both
    paths at once (the 2026-08-10 shape, one layer up)."""

    async def run() -> None:
        now = {"t": 100.0}
        responder, session = make_responder(
            stt_configured=True, clock=lambda: now["t"]
        )
        responder.note_agent_stt_activity(SimpleNamespace(transcript=""))
        responder.note_agent_stt_activity(SimpleNamespace(transcript="   "))
        responder.note_agent_stt_activity(object())  # no transcript attr at all
        now["t"] = 101.0
        await responder._handle_utterance(utterance("still hear me?"))
        assert session.replies == ["still hear me?"]

    asyncio.run(run())


def test_multi_agent_room_requires_spoken_name() -> None:
    async def run() -> None:
        room = SimpleNamespace(
            remote_participants={
                "aaron_uuid": SimpleNamespace(identity="aaron_uuid"),
                "agent-triage": SimpleNamespace(identity="agent-triage"),
            }
        )
        responder, session = make_responder(room=room)
        await responder._handle_utterance(utterance("what's the weather"))
        assert session.replies == []  # unaddressed in a multi-agent room
        await responder._handle_utterance(utterance("majik, what's the weather"))
        assert session.replies == ["majik, what's the weather"]

    asyncio.run(run())


def test_inflight_latch_drops_overlapping_utterances() -> None:
    async def run() -> None:
        release = asyncio.Event()

        class SlowHandle:
            async def wait_for_playout(self) -> None:
                await release.wait()

        class SlowSession(FakeSession):
            def generate_reply(self, *, user_input: str):  # type: ignore[override]
                self.replies.append(user_input)
                return SlowHandle()

        responder, session = make_responder(session=SlowSession())
        first = asyncio.create_task(
            responder._handle_utterance(utterance("first"))
        )
        await asyncio.sleep(0)  # let it take the latch
        await responder._handle_utterance(utterance("second"))
        release.set()
        await first
        assert session.replies == ["first"]  # second was dropped, not queued

    asyncio.run(run())


class DeadSession:
    """generate_reply raises exactly what a closed AgentSession raises."""

    def __init__(self) -> None:
        self.attempts = 0

    def generate_reply(self, *, user_input: str):
        self.attempts += 1
        raise RuntimeError("AgentSession isn't running")


def test_dead_session_restarts_once_and_replays_the_utterance() -> None:
    """The 2026-08-10 failure, fixed: session closed itself → ONE restart →
    the same utterance replays through the fresh session → persist happens
    exactly once, only after the reply is scheduled."""

    async def run() -> None:
        dead = DeadSession()
        fresh = FakeSession()
        restarts: list[int] = []

        async def restart():
            restarts.append(1)
            return fresh

        persisted: list = []
        responder, _ = make_responder(
            session=dead,  # type: ignore[arg-type]
            persisted=persisted,
            restart_session=restart,
        )
        await responder._handle_utterance(utterance("hello majik"))

        assert dead.attempts == 1
        assert restarts == [1]
        assert fresh.replies == ["hello majik"]  # replayed on the NEW session
        assert fresh.handle.waited
        assert persisted == [("aaron_uuid", "hello majik")]  # once
        # Later utterances go straight to the fresh session — no re-restart.
        await responder._handle_utterance(utterance("second thought"))
        assert restarts == [1]
        assert fresh.replies == ["hello majik", "second thought"]

    asyncio.run(run())


def test_restart_failure_falls_back_to_the_direct_path() -> None:
    async def run() -> None:
        direct_calls: list[str] = []

        async def restart():
            return None  # rebuild failed

        async def direct(text: str, on_commit) -> bool:
            direct_calls.append(text)
            on_commit()  # a reply exists → commit the user turn
            return True

        persisted: list = []
        responder, _ = make_responder(
            session=DeadSession(),  # type: ignore[arg-type]
            persisted=persisted,
            restart_session=restart,
            direct_reply=direct,
        )
        await responder._handle_utterance(utterance("anyone home"))
        assert direct_calls == ["anyone home"]
        assert persisted == [("aaron_uuid", "anyone home")]

    asyncio.run(run())


def test_total_failure_persists_nothing() -> None:
    """The persist contract: no reply on ANY path → the user's line is NOT
    written to the reply-suppressing history route. Persist-then-fail was the
    incident's worst outcome — silence in both modalities."""

    async def run() -> None:
        async def restart():
            return None

        async def direct(text: str, on_commit) -> bool:
            return False  # Brigade down too

        persisted: list = []
        responder, _ = make_responder(
            session=DeadSession(),  # type: ignore[arg-type]
            persisted=persisted,
            restart_session=restart,
            direct_reply=direct,
        )
        await responder._handle_utterance(utterance("is this thing on"))
        assert persisted == []

    asyncio.run(run())


def test_session_error_before_scheduling_does_not_persist() -> None:
    """A live-session failure that is NOT a dead-session RuntimeError stays on
    the session's own error handling — and must not persist the user line."""

    class ExplodingSession:
        def generate_reply(self, *, user_input: str):
            raise ValueError("LLM exploded mid-flight")

    async def run() -> None:
        persisted: list = []
        responder, _ = make_responder(
            session=ExplodingSession(),  # type: ignore[arg-type]
            persisted=persisted,
        )
        await responder._handle_utterance(utterance("hello"))
        assert persisted == []

    asyncio.run(run())


def test_end_to_end_ingest_groups_then_replies() -> None:
    """The full path: raw payloads → aggregator → drain → generate_reply."""

    async def run() -> None:
        responder, session = make_responder(clock=None)
        # Real monotonic clock; a tiny window keeps the test fast.
        responder._aggregator = TranscriptAggregator(group_window=0.05)
        import time as _time

        responder._clock = _time.monotonic
        await responder.on_transcript(line("part one", segment="a"))
        await responder.on_transcript(line("part two", segment="b"))
        await responder.on_transcript(line("part one", segment="a"))  # dup
        await asyncio.sleep(0.4)
        assert session.replies == ["part one part two"]
        await responder.aclose()

    asyncio.run(run())
