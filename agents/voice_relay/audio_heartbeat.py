"""Metadata-only diagnostics: distinguish muted/silent capture from no frames.

Never records samples, transcripts, names or user metadata in logs.
"""
import asyncio
import math
from array import array
import structlog
logger = structlog.get_logger(__name__)

class AudioWindow:
    def __init__(self):
        self.frames = 0
        self.samples = 0
        self.energy = 0.0

    def feed(self, data):
        values = array('h')
        values.frombytes(bytes(data))
        self.frames += 1
        self.samples += len(values)
        self.energy += sum((v / 32768.0) ** 2 for v in values)

    def drain(self):
        rms = math.sqrt(self.energy / self.samples) if self.samples else 0.0
        report = dict(frames=self.frames, rms=round(rms, 6), state='no_frames' if not self.frames else 'silent' if rms < 0.001 else 'audio')
        self.frames = self.samples = 0
        self.energy = 0.0
        return report

class AudioHeartbeat:
    def __init__(self, room, human_identity):
        self.room = room
        self.human_identity = human_identity
        self.windows = {}
        self.readers = {}
        self.timer = None

    def start(self):
        self.room.on('track_published', self.published)
        self.room.on('track_subscribed', self.subscribed)
        self.room.on('participant_disconnected', self.disconnected)
        for participant in self.room.remote_participants.values():
            for publication in participant.track_publications.values():
                self.published(publication, participant)
                if publication.track:
                    self.subscribed(publication.track, publication, participant)
        self.timer = asyncio.create_task(self.report_loop())

    def published(self, publication, participant):
        from livekit import rtc
        if not self.human_identity(participant.identity) or publication.source != rtc.TrackSource.SOURCE_MICROPHONE:
            return
        key = (participant.sid, publication.sid)
        self.windows.setdefault(key, AudioWindow())
        # Also observe humans other than the session's currently linked speaker.
        publication.set_subscribed(True)

    def subscribed(self, track, publication, participant):
        key = (participant.sid, publication.sid)
        if key not in self.windows:
            self.published(publication, participant)
        if key in self.windows and key not in self.readers:
            self.readers[key] = asyncio.create_task(self.read(track, key))

    async def read(self, track, key):
        from livekit import rtc
        stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1)
        try:
            async for event in stream:
                if key in self.windows:
                    self.windows[key].feed(event.frame.data)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning('voice_relay_audio_monitor_failed', track_sid=key[1])
        finally:
            await stream.aclose()
            self.readers.pop(key, None)

    def disconnected(self, participant):
        for key in list(self.windows):
            if key[0] == participant.sid:
                task = self.readers.pop(key, None)
                if task: task.cancel()
                self.windows.pop(key, None)

    async def report_loop(self):
        while True:
            await asyncio.sleep(5)
            for (participant_sid, track_sid), window in list(self.windows.items()):
                logger.info('voice_relay_audio_heartbeat', participant_sid=participant_sid, track_sid=track_sid, **window.drain())

    async def close(self):
        for event, handler in [('track_published', self.published), ('track_subscribed', self.subscribed), ('participant_disconnected', self.disconnected)]:
            self.room.off(event, handler)
        tasks = list(self.readers.values()) + ([self.timer] if self.timer else [])
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.readers.clear()
        self.windows.clear()
