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

    def reconcile(self, tracks: list[HumanAudioTrack]) -> None:
        chosen = select_tracks(tracks, cap=self._cap)
        wanted = {track.track_sid: track for track in chosen}
        for sid in list(self._sessions):
            if sid not in wanted:
                self._close(sid)
        for sid, track in wanted.items():
            if self._sessions.get(sid) is not None:
                continue
            try:
                session = self._opener(track)
            except Exception:
                logger.warning(
                    "multi_track_open_failed",
                    track_sid=sid,
                    speaker=track.participant_identity,
                    exc_info=True,
                )
                continue
            if session is not None:
                self._sessions[sid] = session

    def _close(self, sid: str) -> None:
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


class LiveTrackSession:
    """Read one remote mic and emit a final attributed to its owner.

    Energy-gated: speech followed by a short quiet stretch is one utterance,
    handed to the non-streaming STT ``recognize``. A failure logs and yields
    nothing — browser captions are still the fallback.
    """

    def __init__(self, track: HumanAudioTrack, media: Any, stt: Any, on_final: OnFinal) -> None:
        self.track = track
        self._media = media
        self._stt = stt
        self._on_final = on_final
        self._task: asyncio.Task[None] | None = None
        self._closed = False

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
        self._closed = True
        task = self._task
        if task is not None and not task.done():
            task.cancel()

    async def _run(self) -> None:
        try:
            from livekit import rtc

            stream = rtc.AudioStream(self._media, sample_rate=16000, num_channels=1)
        except Exception:
            logger.warning(
                "multi_track_stream_failed",
                track_sid=self.track.track_sid,
                exc_info=True,
            )
            return
        frames: list[Any] = []
        quiet = 0
        heard = False
        try:
            async for event in stream:
                if self._closed:
                    break
                frame = getattr(event, "frame", event)
                energy = _frame_energy(frame)
                if energy >= 400:
                    heard = True
                    quiet = 0
                    frames.append(frame)
                elif heard:
                    quiet += 1
                    frames.append(frame)
                    # ~0.5s of quiet at 50 frames/s of 20ms, or 25 quiet frames.
                    if quiet >= 25 and frames:
                        await self._recognize(frames)
                        frames = []
                        quiet = 0
                        heard = False
                if len(frames) > 1500:
                    await self._recognize(frames)
                    frames = []
                    quiet = 0
                    heard = False
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "multi_track_read_failed",
                track_sid=self.track.track_sid,
                exc_info=True,
            )

    async def _recognize(self, frames: list[Any]) -> None:
        recognize = getattr(self._stt, "recognize", None)
        if not callable(recognize):
            return
        try:
            event = recognize(frames)
            if asyncio.iscoroutine(event):
                event = await event
        except Exception:
            logger.warning(
                "multi_track_recognize_failed",
                track_sid=self.track.track_sid,
                speaker=self.track.participant_identity,
                exc_info=True,
            )
            return
        text = _event_text(event)
        if not text:
            return
        try:
            self._on_final(self.track, text)
        except Exception:
            logger.debug("multi_track_final_failed", exc_info=True)


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
