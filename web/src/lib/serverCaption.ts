/**
 * Server captions for a microphone Web Speech cannot follow.
 *
 * Records the local LiveKit mic in ~5s clips and posts each one to the
 * existing STT proxy (`POST /api/v1/stt`). The proxy is rate-limited
 * (20/min); one clip at a time stays under that. This is transcription,
 * not a recording — nothing is written to the call recording pipeline.
 */

import { Track, type Room } from "livekit-client";
import { getToken, refreshToken } from "@/services/auth";
import { useFederationStore } from "@/stores/federationStore";
import { publishLocalCaption } from "@/lib/humanTranscript";

export const SERVER_CAPTION_CHUNK_MS = 5_000;

export class ServerCaptionSession {
  private stopped = true;
  private dead = false;
  private generation = 0;
  private loopPromise: Promise<void> | null = null;
  private lastError = false;

  constructor(
    private readonly room: Room,
    private readonly onActivity: () => void,
  ) {}

  get canCapture(): boolean {
    return typeof MediaRecorder !== "undefined";
  }

  get hasLastError(): boolean {
    return this.lastError;
  }

  start(): void {
    if (this.dead || (this.loopPromise && !this.stopped)) return;
    this.stopped = false;
    const generation = ++this.generation;
    this.loopPromise = this.loop(generation).finally(() => {
      if (this.generation === generation) this.loopPromise = null;
    });
  }

  /** Pause without forgetting the call. A later start() resumes. */
  suspend(): void {
    this.stopped = true;
  }

  /** Hang-up. start() will not revive this session. */
  stop(): void {
    this.dead = true;
    this.stopped = true;
  }

  private async loop(generation: number): Promise<void> {
    while (!this.stopped && !this.dead && this.generation === generation) {
      const track = microphoneTrack(this.room);
      if (!track) {
        await sleep(500);
        continue;
      }
      const blob = await recordChunk(track, SERVER_CAPTION_CHUNK_MS, () =>
        this.stopped || this.dead || this.generation !== generation,
      );
      if (this.stopped || this.dead || this.generation !== generation) break;
      if (!blob || blob.size === 0) continue;
      try {
        const text = (await transcribeChunk(blob)).trim();
        this.lastError = false;
        if (text) publishLocalCaption(this.room, text, "server");
      } catch {
        this.lastError = true;
      }
      this.onActivity();
    }
  }
}

export async function transcribeChunk(blob: Blob): Promise<string> {
  const token = (await refreshToken()) ?? getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = new FormData();
  const type = blob.type || "audio/webm";
  const ext = type.includes("mp4") ? "m4a" : "webm";
  body.append("file", new File([blob], `caption.${ext}`, { type }));
  const lang = (
    (typeof navigator !== "undefined" && navigator.language) ||
    ""
  ).slice(0, 2);
  if (lang) body.append("language", lang);
  const response = await fetch(`${apiBase()}/api/v1/stt`, {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`stt ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const text = (parsed as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function microphoneTrack(room: Room): MediaStreamTrack | null {
  const publication = room.localParticipant.getTrackPublication(
    Track.Source.Microphone,
  );
  const track = publication?.track?.mediaStreamTrack ?? null;
  if (!track || track.readyState !== "live") return null;
  return track;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function recordChunk(
  track: MediaStreamTrack,
  ms: number,
  cancelled: () => boolean,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (cancelled() || typeof MediaRecorder === "undefined") {
      resolve(null);
      return;
    }
    let rec: MediaRecorder;
    try {
      const mime = pickMime();
      const stream = new MediaStream([track]);
      rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      resolve(null);
      return;
    }
    const parts: Blob[] = [];
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      resolve(blob);
    };
    rec.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) parts.push(event.data);
    };
    rec.onerror = () => finish(null);
    rec.onstop = () => {
      finish(
        parts.length
          ? new Blob(parts, { type: rec.mimeType || "audio/webm" })
          : null,
      );
    };
    try {
      rec.start();
    } catch {
      finish(null);
      return;
    }
    const stop = () => {
      if (rec.state === "inactive") return;
      try {
        rec.stop();
      } catch {
        finish(null);
      }
    };
    const poll = setInterval(() => {
      if (!cancelled()) return;
      clearInterval(poll);
      clearTimeout(timer);
      stop();
    }, 200);
    const timer = setTimeout(() => {
      clearInterval(poll);
      stop();
    }, ms);
  });
}

function apiBase(): string {
  const fed = useFederationStore.getState();
  return (
    fed.accessibleInstances.find((instance) => instance.id === fed.activeInstanceId)
      ?.apiBaseUrl ??
    import.meta.env.VITE_API_BASE_URL ??
    ""
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
