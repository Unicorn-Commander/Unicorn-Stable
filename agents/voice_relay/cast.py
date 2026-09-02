"""Cast members — one LiveKit participant per sender the relay speaks for.

WHY A SECOND PARTICIPANT. ``voice_relay_voices`` let one relay speak for the
whole cast, each sender in its own voice — but every line still left the
relay's OWN track. The call grid, the transcript, ``/broadcast/{room}/{id}``
and OBS all key on the participant, so Grok's words came out of Rook's tile
and Grok had no tile to broadcast at all. The honest shape is the one humans
already have: a participant per character, with its own mic and its own
camera.

WHY NOT A JOB PER CHARACTER. livekit-agents runs each job in its own process
with its own AgentSession, STT and VAD. A cast member needs none of that — it
never listens, never thinks; it has a mouth and a face. So the relay HOSTS
them: one extra ``rtc.Room`` connection each, inside the relay's own process,
minted with the worker's API key. Cost per character is a websocket and two
encoders, not a process; and there is nothing for the backend to dispatch,
so the join webhook, the presence probe and the unmute control packet all
keep working with no change of shape.

WHAT THE ROOM SEES. Identity = the sender's username (``agent-grok``), kind
``agent``, attribute ``stable.cast=1`` and ``stable.cast_of=<host identity>``
so a worker that elects a captioner or counts agents can tell a puppet from
a colleague (voice_transcripts.is_cast_puppet). Audio goes straight into an
``rtc.AudioSource`` — no RoomIO in the path, so the visible-subscriber gate
that silenced E03 does not exist here — and the face is a PuppetVideo.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import structlog

from agent_runtime.puppet_video import PuppetSpec, PuppetVideo

logger = structlog.get_logger(__name__)

CAST_ATTRIBUTE = "stable.cast"
CAST_OF_ATTRIBUTE = "stable.cast_of"

#: Kokoro's rate; the source is built for it and other rates are resampled.
DEFAULT_SAMPLE_RATE = 24000
CONNECT_TIMEOUT_S = 12.0


def mint_cast_token(
    *,
    api_key: str,
    api_secret: str,
    room_name: str,
    identity: str,
    display_name: str,
    host_identity: str,
    ttl_s: int = 6 * 3600,
) -> str:
    """A publish-only token for one cast member. Visible (never hidden): the
    whole point is to be seen; subscribes to nothing, it has no ears."""
    from datetime import timedelta

    from livekit import api

    grants = api.VideoGrants(
        room_join=True,
        room=room_name,
        can_publish=True,
        can_subscribe=False,
        can_publish_data=False,
        hidden=False,
    )
    token = (
        api.AccessToken(api_key=api_key, api_secret=api_secret)
        .with_identity(identity)
        .with_name(display_name)
        .with_grants(grants)
        .with_ttl(timedelta(seconds=ttl_s))
        .with_attributes({CAST_ATTRIBUTE: "1", CAST_OF_ATTRIBUTE: host_identity})
    )
    try:
        token = token.with_kind("agent")
    except Exception:  # pragma: no cover — older livekit-api
        pass
    return token.to_jwt()


class CastMember:
    """One hosted participant: a mouth (audio track) and a face (puppet)."""

    def __init__(
        self,
        *,
        identity: str,
        display_name: str,
        voice: str,
        spec: PuppetSpec,
        host_identity: str,
        room_name: str,
        url: str,
        api_key: str,
        api_secret: str,
        video: bool = True,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
    ) -> None:
        self.identity = identity
        self.display_name = display_name
        self.voice = voice
        self.spec = spec
        self.video_enabled = video
        self._host_identity = host_identity
        self._room_name = room_name
        self._url = url
        self._api_key = api_key
        self._api_secret = api_secret
        self._sample_rate = sample_rate
        self.room: Any = None
        self.audio_source: Any = None
        self.audio_track: Any = None
        self.puppet: PuppetVideo | None = None
        self._resampler: Any = None
        self._resampler_rate = 0
        self._connected = False
        self._lock = asyncio.Lock()
        self.spoken_frames = 0

    @property
    def ready(self) -> bool:
        return self._connected and self.audio_source is not None

    # ------------------------------------------------------------------ #
    # lifecycle
    # ------------------------------------------------------------------ #

    async def connect(self) -> bool:
        """Join the room and publish. False (logged) on any failure; never raises."""
        from livekit import rtc

        async with self._lock:
            if self._connected:
                return True
            try:
                token = mint_cast_token(
                    api_key=self._api_key,
                    api_secret=self._api_secret,
                    room_name=self._room_name,
                    identity=self.identity,
                    display_name=self.display_name,
                    host_identity=self._host_identity,
                )
                room = rtc.Room()
                room.on("data_received", self._on_data)
                await asyncio.wait_for(
                    room.connect(
                        self._url,
                        token,
                        options=rtc.RoomOptions(auto_subscribe=False, dynacast=False),
                    ),
                    timeout=CONNECT_TIMEOUT_S,
                )
                self.room = room
                self.audio_source = rtc.AudioSource(self._sample_rate, 1, queue_size_ms=200)
                self.audio_track = rtc.LocalAudioTrack.create_audio_track(
                    "cast_voice", self.audio_source
                )
                await room.local_participant.publish_track(
                    self.audio_track,
                    rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
                )
                if self.video_enabled:
                    self.puppet = PuppetVideo(self.spec)
                    await self.puppet.start(room)
                self._connected = True
                logger.info(
                    "voice_relay_cast_joined",
                    identity=self.identity,
                    name=self.display_name,
                    voice=self.voice,
                    video=self.video_enabled,
                )
                return True
            except Exception:
                logger.error(
                    "voice_relay_cast_join_failed", identity=self.identity, exc_info=True
                )
                await self._teardown()
                return False

    async def set_video(self, enabled: bool) -> None:
        """Turn the face on or off on a live member."""
        self.video_enabled = enabled
        if not self._connected or self.room is None:
            return
        if enabled and self.puppet is None:
            try:
                self.puppet = PuppetVideo(self.spec)
                await self.puppet.start(self.room)
            except Exception:
                logger.warning("voice_relay_cast_video_failed", identity=self.identity, exc_info=True)
                self.puppet = None
        elif not enabled and self.puppet is not None:
            puppet, self.puppet = self.puppet, None
            await puppet.stop()

    async def close(self) -> None:
        async with self._lock:
            await self._teardown()

    async def _teardown(self) -> None:
        """Leave in the order the FFI tolerates: tracks unpublished, room
        disconnected, sources closed LAST. Measured 2026-09-02 in the runtime
        image: closing the AudioSource while its track was still published,
        then disconnecting, aborted the process at exit with a Rust
        "panic in a function that cannot unwind" (exit 139); the same member
        with the track unpublished first exited 0."""
        from livekit import rtc

        self._connected = False
        if self.puppet is not None:
            try:
                await self.puppet.stop()
            except Exception:
                pass
            self.puppet = None
        room, track = self.room, self.audio_track
        if room is not None and track is not None:
            try:
                if getattr(room, "connection_state", None) == rtc.ConnectionState.CONN_CONNECTED:
                    await asyncio.wait_for(
                        room.local_participant.unpublish_track(track.sid), timeout=3.0
                    )
            except Exception:
                logger.debug("voice_relay_cast_unpublish_failed", exc_info=True)
        self.audio_track = None
        if room is not None:
            try:
                await asyncio.wait_for(room.disconnect(), timeout=3.0)
            except Exception:
                pass
            self.room = None
        if self.audio_source is not None:
            try:
                await self.audio_source.aclose()
            except Exception:
                pass
            self.audio_source = None

    # ------------------------------------------------------------------ #
    # speaking
    # ------------------------------------------------------------------ #

    def _to_source_rate(self, frame: Any) -> list[Any]:
        rate = int(getattr(frame, "sample_rate", self._sample_rate) or self._sample_rate)
        if rate == self._sample_rate:
            return [frame]
        from livekit import rtc

        if self._resampler is None or self._resampler_rate != rate:
            self._resampler = rtc.AudioResampler(rate, self._sample_rate, num_channels=1)
            self._resampler_rate = rate
        return list(self._resampler.push(frame))

    async def speak(self, frames: list[Any], *, budget_s: float = 45.0) -> bool:
        """Play pre-synthesised frames out of this member's mouth. Blocks, bounded,
        until playout; True if anything was pushed."""
        if not self.ready or not frames:
            return False
        pushed = 0
        started = time.monotonic()
        try:
            for frame in frames:
                for out in self._to_source_rate(frame):
                    if self.puppet is not None:
                        self.puppet.feed(out)
                    await self.audio_source.capture_frame(out)
                    pushed += 1
                if time.monotonic() - started > budget_s:
                    logger.warning("voice_relay_cast_speak_over_budget", identity=self.identity)
                    break
            try:
                await asyncio.wait_for(
                    self.audio_source.wait_for_playout(),
                    timeout=max(1.0, budget_s - (time.monotonic() - started)),
                )
            except asyncio.TimeoutError:
                logger.debug("voice_relay_cast_playout_wait_elapsed", identity=self.identity)
        except Exception:
            logger.error("voice_relay_cast_speak_failed", identity=self.identity, exc_info=True)
        self.spoken_frames += pushed
        return pushed > 0

    # ------------------------------------------------------------------ #
    # control
    # ------------------------------------------------------------------ #

    def unmute(self, *, reason: str = "control") -> bool:
        """Undo a moderator mute on this member's own tracks. Mirrors the host's
        ``_unmute_own_audio``: the SFU only lets the publisher unmute."""
        changed = False
        room = self.room
        participant = getattr(room, "local_participant", None) if room is not None else None
        publications = getattr(participant, "track_publications", None) or {}
        for pub in publications.values():
            track = getattr(pub, "track", None)
            if track is None:
                continue
            if not (getattr(pub, "muted", False) or getattr(track, "muted", False)):
                continue
            try:
                track.unmute()
                changed = True
            except Exception:
                logger.warning("voice_relay_cast_unmute_failed", identity=self.identity, exc_info=True)
        if changed:
            logger.info("voice_relay_cast_unmuted", identity=self.identity, reason=reason)
        return changed

    def _on_data(self, packet: Any) -> None:
        """The moderator's ``voice_relay_control`` packet, addressed to THIS
        identity, lands on this connection — not the host's."""
        try:
            raw = getattr(packet, "data", packet)
            if isinstance(raw, (bytes, bytearray)):
                raw = raw.decode("utf-8", "replace")
            payload = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(payload, dict) or payload.get("type") != "voice_relay_control":
                return
            action = str(payload.get("action") or "").strip().lower()
            if action == "unmute":
                self.unmute(reason="control")
        except Exception:
            logger.debug("voice_relay_cast_data_failed", exc_info=True)


def cast_identities(voices: dict[str, str], host_identity: str) -> list[str]:
    """Who gets their own participant: every sender in the cast except the
    host itself (the relay already IS that participant). Stable order."""
    host = (host_identity or "").strip()
    return [s for s in voices if s and s != host]
