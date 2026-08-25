---
id: calls
title: Voice and video calls
section: Calls
order: 310
summary: Start a call, choose a layout, pop the video out, and keep working while it runs.
keywords: call, voice, video, livekit, mute, camera, microphone, speaker, output, device selection, screen share, pip, picture in picture, stage, layout, transcript
---

Any room can become a call. The call control is in the room's call bar.

## Join and leave

Starting or joining puts you in the room's call; **End call** leaves it. Others
in the room see an incoming-call banner they can answer or dismiss.

Before Stable joins, **Check your devices** shows a live camera preview and
microphone meter. Pick the camera, microphone, and call-audio output there. The
choices are saved for your account and restored on the next call.

During a call, open **Settings → Audio & Video** to change any device without
leaving the room. Camera and microphone changes replace the live track, so an
active recording keeps running. Sending call audio to headphones or a virtual
output instead of room speakers prevents the room microphone from capturing the
call again. If a selected device is unplugged, Stable switches to another
available device and tells you.

Browser-provided captions cannot be bound to a chosen non-default microphone.
Stable pauses that second browser capture in this case; the call continues on
the selected microphone and configured agent transcription remains available.

## Layouts

A call has more than one way to look at it, chosen from the view switcher:

- **Grid** — everyone the same size
- **Stage** — one participant (or an agent's work surface) large, the rest as a
  strip

Agents can present on their own **stage** track — that is how an agent shows
you what it is doing rather than only telling you.

## Keep working during a call

- **Picture in picture** pops the video into a floating window so you can read
  and type in the channel underneath.
- If you navigate to another room, the call follows you as a compact **call
  dock** rather than dropping.

## Transcript

Rooms with speech-to-text configured show a live transcript panel alongside the
call.

## If a call will not connect

Calls need WebRTC to your server's media plane. A restrictive corporate network
or VPN is the usual cause. See [When something looks wrong](help:troubleshooting).
