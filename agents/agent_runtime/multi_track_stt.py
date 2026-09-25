"""One STT session per human microphone, on the elected captioner only.

A worker's AgentSession hears the single participant it is linked to. In a
call with several humans that drops everyone else. The captioner — the same
lexicographic election that already publishes one copy of the captions —
subscribes to every human mic and runs one recognize session per track,
capped at 6, and attributes the final by that track's participant identity.

Browser captions stay the fallback. If a track has no audio yet, or STT
cannot be built, that track is skipped and the log says so.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Callable

import structlog

from agent_runtime.voice_transcripts import (
    elected_user_captioner,
    is_agent_identity,
    is_cast_puppet,
)

logger = structlog.get_logger(__name__)

MAX_STT_TRACKS = 6

#: End-of-speech silence before a track emits one utterance, in real seconds
#: from each frame's sample count. A comma-sized pause must not become its
#: own chat line (measured 2026-09-24: "grok" / "in one sentence" / "what is
#: the point of a rehearsal"). Counting frames is wrong: LiveKit 1.1 delivers
#: 10 ms frames unless the stream is asked for a size.
UTTERANCE_SILENCE_GATE_S = 1.0
#: A turn that never goes quiet still emits here. The previous cap counted
#: frames and recognized without emitting, so a noise bed went silent.
UTTERANCE_MAX_S = 15.0
#: Ask the stream for 20 ms frames. Timing does not depend on getting them.
FRAME_SIZE_MS = 20
#: The per-track ear covers its speaker only while a frame arrived this recently.
HEALTHY_FRAME_S = 1.0
#: On close, recognize whatever is buffered, then give up.
CLOSE_FLUSH_TIMEOUT_S = 3.0
ENERGY_THRESHOLD = 400

OnFinal = Callable[["HumanAudioTrack", str], None]
Opener = Callable[["HumanAudioTrack"], Any]


@dataclass(frozen=True)
class HumanAudioTrack:
    participant_identity: str
    participant_name: str
    track_sid: str
    publication: Any = None


def _is_microphone(publication: Any) -> bool:
    source = str(getattr(publication, "source", "") or "").lower()
    kind = str(getattr(publication, "kind", "") or "").lower()
    if "microphone" in source:
        return True
    if source in {"2", "source_microphone"}:
        return True
    if not source and "audio" in kind:
        return True
    return False


def list_human_mic_tracks(room: Any) -> list[HumanAudioTrack]:
    """Remote human microphone publications, in roster order."""
    found: list[HumanAudioTrack] = []
    try:
        remotes = list(getattr(room, "remote_participants", {}).values())
    except Exception:
        return found
    for participant in remotes:
        identity = str(getattr(participant, "identity", "") or "")
        if not identity or identity.startswith(("broadcast-", "EG_")):
            continue
        if is_agent_identity(identity) or is_cast_puppet(participant):
            continue
        name = str(getattr(participant, "name", "") or "").strip() or identity
        publications = getattr(participant, "track_publications", {}) or {}
        try:
            pubs = list(publications.values())
        except Exception:
            continue
        for pub in pubs:
            if not _is_microphone(pub):
                continue
            sid = str(getattr(pub, "sid", "") or "")
            if not sid:
                continue
            found.append(
                HumanAudioTrack(
                    participant_identity=identity,
                    participant_name=name,
                    track_sid=sid,
                    publication=pub,
                )
            )
    return found


def select_tracks(
    tracks: list[HumanAudioTrack], *, cap: int = MAX_STT_TRACKS
) -> list[HumanAudioTrack]:
    """Stable order, then the cap. The same worker always picks the same six."""
    ordered = sorted(tracks, key=lambda t: (t.participant_identity, t.track_sid))
    return ordered[: max(0, cap)]


class MultiTrackController:
    """Open one session per selected track; close the ones that leave."""

    def __init__(
        self,
        *,
        on_final: OnFinal,
        opener: Opener,
        cap: int = MAX_STT_TRACKS,
    ) -> None:
        self._on_final = on_final
        self._opener = opener
        self._cap = cap
        self._sessions: dict[str, Any] = {}
        self._last_tracks: list[HumanAudioTrack] = []
        #: A sid we already reopened once after its task died. The next
        #: external reconcile (a track event) may try again. Without the
        #: guard a stream that cannot open spins a new session forever.
        self._retried: set[str] = set()
        self._closing: set[str] = set()

    def reconcile(self, tracks: list[HumanAudioTrack], *, _retry: bool = False) -> None:
        self._last_tracks = list(tracks)
        if not _retry:
            self._retried.clear()
        for sid, session in list(self._sessions.items()):
            if not _session_running(session):
                self._sessions.pop(sid, None)
        chosen = select_tracks(tracks, cap=self._cap)
        wanted = {track.track_sid: track for track in chosen}
        for sid in list(self._sessions):
            if sid not in wanted:
                self._close(sid)
        for sid, track in wanted.items():
            if _session_running(self._sessions.get(sid)):
                continue
            self._sessions.pop(sid, None)
            self._open(sid, track)

    def _open(self, sid: str, track: HumanAudioTrack) -> None:
        try:
            session = self._opener(track)
        except Exception:
            logger.warning(
                "multi_track_open_failed",
                track_sid=sid,
                speaker=track.participant_identity,
                exc_info=True,
            )
            return
        if session is None:
            return
        self._sessions[sid] = session
        task = getattr(session, "_task", None)
        if isinstance(task, asyncio.Task):
            task.add_done_callback(
                lambda _done, sid=sid, session=session: self._on_done(sid, session)
            )

    def _on_done(self, sid: str, session: Any) -> None:
        """Drop a finished session and let a new one attach, once."""
        current = self._sessions.get(sid)
        if current is not None and current is not session:
            return
        self._sessions.pop(sid, None)
        if sid in self._closing:
            self._closing.discard(sid)
            return
        if sid in self._retried:
            return
        self._retried.add(sid)
        try:
            self.reconcile(self._last_tracks, _retry=True)
        except Exception:
            logger.warning("multi_track_reopen_failed", track_sid=sid, exc_info=True)

    def _close(self, sid: str) -> None:
        self._closing.add(sid)
        session = self._sessions.pop(sid, None)
        closer = getattr(session, "aclose", None) or getattr(session, "close", None)
        if not callable(closer):
            return
        try:
            result = closer()
            if asyncio.iscoroutine(result):
                try:
                    asyncio.get_running_loop().create_task(result)
                except RuntimeError:
                    result.close()
        except Exception:
            logger.debug("multi_track_close_failed", track_sid=sid, exc_info=True)

    @property
    def active_sids(self) -> set[str]:
        return set(self._sessions)

    def session_for(self, sid: str) -> Any:
        return self._sessions.get(sid)


def _session_running(session: Any) -> bool:
    """True while this session should keep its slot in the controller.

    A finished LiveTrackSession does not. A test double with no task does:
    the controller tests hand back a plain object and expect it to stay.
    """
    if session is None:
        return False
    if isinstance(session, LiveTrackSession):
        task = session._task
        return task is not None and not task.done()
    task = getattr(session, "_task", None)
    if isinstance(task, asyncio.Task):
        return not task.done()
    return True


class LiveTrackSession:
    """Read one remote mic and emit a final attributed to its owner.

    Energy-gated: speech followed by a second of real quiet is one utterance,
    handed to the non-streaming STT ``recognize``. Silence and the long-turn
    cap are measured from each frame's samples, not from how many frames
    arrived. A failure logs and yields nothing — the session ear is the
    fallback once this session is no longer healthy.
    """

    def __init__(
        self,
        track: HumanAudioTrack,
        media: Any,
        stt: Any,
        on_final: OnFinal,
    ) -> None:
        self.track = track
        self._media = media
        self._stt = stt
        self._on_final = on_final
        self._task: asyncio.Task[None] | None = None
        self._closed = False
        self._pending_parts: list[str] = []
        self._frames: list[Any] = []
        self._buf_s = 0.0
        self._quiet_s = 0.0
        self._in_speech = False
        self._last_frame_at: float | None = None
        self._last_recognize_failed = False
        self._close_timeout = CLOSE_FLUSH_TIMEOUT_S
        self._stream: Any = None

    def is_healthy(self, *, now: float | None = None) -> bool:
        """True while this ear is the one that should own the speaker.

        The task is running, a frame arrived within the last second, and the
        last recognition attempt did not fail. Anything else leaves the
        session ear and browser captions in charge.
        """
        now = time.monotonic() if now is None else now
        task = self._task
        if self._closed or task is None or task.done():
            return False
        if self._last_recognize_failed:
            return False
        if self._last_frame_at is None:
            return False
        return (now - self._last_frame_at) <= HEALTHY_FRAME_S

    def start(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.info("multi_track_no_loop", track_sid=self.track.track_sid)
            return
        self._task = loop.create_task(
            self._run(), name=f"multi-track-stt:{self.track.track_sid}"
        )

    def aclose(self) -> None:
        """Stop reading. The task recognizes whatever is buffered, then ends."""
        self._closed = True
        task = self._task
        if task is not None and not task.done():
            task.cancel()

    async def _run(self) -> None:
        try:
            try:
                from livekit import rtc

                self._stream = rtc.AudioStream(
                    self._media,
                    sample_rate=16000,
                    num_channels=1,
                    frame_size_ms=FRAME_SIZE_MS,
                )
            except Exception:
                logger.warning(
                    "multi_track_stream_failed",
                    track_sid=self.track.track_sid,
                    exc_info=True,
                )
                return
            try:
                async for event in self._stream:
                    if self._closed:
                        break
                    frame = getattr(event, "frame", event)
                    self._last_frame_at = time.monotonic()
                    await self._take_frame(frame)
            except asyncio.CancelledError:
                self._uncancel()
        except Exception:
            logger.warning(
                "multi_track_read_failed",
                track_sid=self.track.track_sid,
                exc_info=True,
            )
        finally:
            await self._flush_tail()

    async def _take_frame(self, frame: Any) -> None:
        dt = _frame_seconds(frame)
        energy = _frame_energy(frame)
        if energy >= ENERGY_THRESHOLD:
            self._in_speech = True
            self._quiet_s = 0.0
            self._frames.append(frame)
            self._buf_s += dt
        elif self._in_speech:
            self._quiet_s += dt
            self._frames.append(frame)
            self._buf_s += dt
            if self._quiet_s >= UTTERANCE_SILENCE_GATE_S and self._frames:
                await self._cut()
                return
        if self._buf_s >= UTTERANCE_MAX_S and self._frames:
            await self._cut()

    async def _cut(self) -> None:
        """Recognize the buffer and emit. One utterance boundary."""
        frames = self._frames
        self._reset_buffer()
        await self._recognize(frames)
        self._emit_pending()

    def _reset_buffer(self) -> None:
        self._frames = []
        self._buf_s = 0.0
        self._quiet_s = 0.0
        self._in_speech = False

    async def _flush_tail(self) -> None:
        """Recognize audio still buffered when the track ends or closes."""
        self._uncancel()
        frames = self._frames
        self._frames = []
        self._buf_s = 0.0
        if frames:
            try:
                await asyncio.wait_for(
                    self._recognize(frames), timeout=self._close_timeout
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "multi_track_close_flush_timeout",
                    track_sid=self.track.track_sid,
                )
            except asyncio.CancelledError:
                self._uncancel()
            except Exception:
                logger.warning(
                    "multi_track_close_flush_failed",
                    track_sid=self.track.track_sid,
                    exc_info=True,
                )
        self._emit_pending()

    def _uncancel(self) -> None:
        """A close() cancels the read. The flush that follows must still await."""
        task = asyncio.current_task()
        if task is None:
            return
        uncancel = getattr(task, "uncancel", None)
        if not callable(uncancel):
            return
        while uncancel():
            pass

    async def _recognize(self, frames: list[Any]) -> None:
        recognize = getattr(self._stt, "recognize", None)
        if not callable(recognize):
            return
        try:
            event = recognize(frames)
            if asyncio.iscoroutine(event):
                event = await event
        except Exception:
            self._last_recognize_failed = True
            logger.warning(
                "multi_track_recognize_failed",
                track_sid=self.track.track_sid,
                speaker=self.track.participant_identity,
                exc_info=True,
            )
            return
        self._last_recognize_failed = False
        text = _event_text(event)
        if not text:
            return
        self._pending_parts.append(text)

    def _emit_pending(self) -> None:
        """One final for every partial recognize since the last silence."""
        from agent_runtime.voice_dispatch import join_partial_finals

        parts = self._pending_parts
        self._pending_parts = []
        text = join_partial_finals(parts)
        if not text:
            return
        if len(parts) > 1:
            logger.info(
                "multi_track_partials_joined",
                n=len(parts),
                speaker=self.track.participant_identity,
            )
        try:
            self._on_final(self.track, text)
        except Exception:
            logger.debug("multi_track_final_failed", exc_info=True)


def _frame_seconds(frame: Any) -> float:
    """Duration of one frame from its sample count, not from a assumed size."""
    rate = getattr(frame, "sample_rate", None) or 16000
    try:
        rate_f = float(rate)
    except (TypeError, ValueError):
        rate_f = 16000.0
    if rate_f <= 0:
        rate_f = 16000.0
    samples = getattr(frame, "samples_per_channel", None)
    if not samples:
        data = getattr(frame, "data", None)
        try:
            samples = len(bytes(data)) // 2 if data else 0
        except Exception:
            samples = 0
    try:
        samples_i = int(samples)
    except (TypeError, ValueError):
        samples_i = 0
    if samples_i <= 0:
        return 0.0
    return samples_i / rate_f


def _frame_energy(frame: Any) -> float:
    data = getattr(frame, "data", None)
    if not data:
        return 0.0
    try:
        raw = bytes(data)
    except Exception:
        return 0.0
    if len(raw) < 2:
        return 0.0
    count = len(raw) // 2
    total = 0
    for i in range(0, count * 2, 2):
        sample = int.from_bytes(raw[i : i + 2], "little", signed=True)
        total += abs(sample)
    return total / max(1, count)


def _event_text(event: Any) -> str:
    alternatives = getattr(event, "alternatives", None) or []
    if alternatives:
        text = getattr(alternatives[0], "text", "") or ""
        return str(text).strip()
    return str(getattr(event, "text", "") or "").strip()


def _live_opener(on_final: OnFinal) -> Opener:
    def open_track(track: HumanAudioTrack) -> Any:
        media = getattr(track.publication, "track", None)
        if media is None:
            return None
        try:
            from plugins.stt import get_stt_plugin

            stt = get_stt_plugin()
        except Exception:
            logger.warning("multi_track_stt_unavailable", exc_info=True)
            return None
        session = LiveTrackSession(track, media, stt, on_final)
        session.start()
        logger.info(
            "multi_track_stt_started",
            track_sid=track.track_sid,
            speaker=track.participant_identity,
        )
        return session

    return open_track


def attach_multi_track_stt(
    room: Any,
    self_identity: str,
    on_final: OnFinal,
    *,
    opener: Opener | None = None,
    cap: int = MAX_STT_TRACKS,
) -> MultiTrackController | None:
    """Subscribe the elected captioner. Anyone else returns None and does nothing."""
    if not self_identity or not elected_user_captioner(room, self_identity):
        logger.info("multi_track_stt_not_captioner", identity=self_identity)
        return None
    controller = MultiTrackController(
        on_final=on_final,
        opener=opener or _live_opener(on_final),
        cap=cap,
    )

    def reconcile(*_args: Any) -> None:
        try:
            controller.reconcile(list_human_mic_tracks(room))
        except Exception:
            logger.warning("multi_track_reconcile_failed", exc_info=True)

    for event in (
        "track_subscribed",
        "track_published",
        "track_unpublished",
        "participant_connected",
        "participant_disconnected",
    ):
        try:
            room.on(event, reconcile)
        except Exception:
            logger.debug("multi_track_listen_failed", event=event, exc_info=True)
    reconcile()
    logger.info(
        "multi_track_stt_attached",
        identity=self_identity,
        tracks=len(controller.active_sids),
        cap=cap,
    )
    return controller
