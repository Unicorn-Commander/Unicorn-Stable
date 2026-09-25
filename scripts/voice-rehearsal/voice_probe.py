"""Synthetic human participant for a Stable room (runs INSIDE stable-agents).

usage: python3 voice_probe.py <livekit_room_name> <gap_seconds> <wav> [<wav> ...]
Joins as identity `voice-probe` (a non-agent identity, so relay dispatch and
the cast treat it as a human), publishes a 16 kHz mono mic track, waits 12 s
of silence (relay dispatch + cast join), then plays each wav with `gap`
seconds of silence between them, then 20 s of silence, then leaves.
Prints a timestamped line per phase so the run can be lined up with
`docker logs stable-agents` and agent_events.
"""
import asyncio, os, sys, time, wave
from datetime import datetime, timezone
from livekit import api, rtc

def ts():
    return datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3] + "Z"

async def main():
    room_name, gap, wavs = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
    url = os.environ["LIVEKIT_URL"]; key = os.environ["LIVEKIT_API_KEY"]; secret = os.environ["LIVEKIT_API_SECRET"]
    # A HUMAN identity is `<username>_<participant uuid>`; the relay drops anything
    # else as unattributed (agents/voice_relay/agent.py human_identity).
    identity = os.environ.get("PROBE_IDENTITY", "voice-probe")
    token = (api.AccessToken(key, secret).with_identity(identity).with_name("Voice Probe")
             .with_grants(api.VideoGrants(room_join=True, room=room_name, can_publish=True, can_subscribe=True)).to_jwt())
    room = rtc.Room()
    await room.connect(url, token)
    print(ts(), "connected", room_name, "participants:", [p.identity for p in room.remote_participants.values()], flush=True)
    source = rtc.AudioSource(16000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    print(ts(), "published mic", flush=True)

    async def silence(seconds):
        frames = int(seconds * 100)  # 10 ms frames
        for _ in range(frames):
            await source.capture_frame(rtc.AudioFrame(bytes(320), 16000, 1, 160))

    async def play(path):
        with wave.open(path, "rb") as w:
            assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, path
            data = w.readframes(w.getnframes())
        for i in range(0, len(data), 320):
            chunk = data[i:i+320]
            if len(chunk) < 320:
                chunk = chunk + bytes(320 - len(chunk))
            await source.capture_frame(rtc.AudioFrame(chunk, 16000, 1, 160))

    await silence(12)
    print(ts(), "warmup done; remote:", [p.identity for p in room.remote_participants.values()], flush=True)
    for path in wavs:
        print(ts(), "SPEAK", os.path.basename(path), flush=True)
        await play(path)
        print(ts(), "END  ", os.path.basename(path), flush=True)
        await silence(gap)
    await silence(float(os.environ.get("PROBE_TAIL_SECONDS", "20")))
    print(ts(), "leaving; remote:", [p.identity for p in room.remote_participants.values()], flush=True)
    await room.disconnect()

asyncio.run(main())
