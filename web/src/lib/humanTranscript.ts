/**
 * Browser-side live captions for the LOCAL human participant.
 *
 * When an agent is in the call, the agent runtime already runs STT (Parakeet /
 * Amanuensis via livekit-agents) and republishes human + agent lines as
 * `transcript` data-channel messages (see agents/agent_runtime/transcript_publisher.py).
 * We deliberately DO NOT run browser STT in that case — reusing the agent path
 * avoids double captions and keeps agent voice history persistence working.
 *
 * When NO agent is present (human↔human calls), this module uses the Web
 * Speech API to caption the local mic and:
 *   1. ingests lines into callUiStore (local TranscriptPanel), and
 *   2. publishes them on the LiveKit `stable` data topic so remote peers see
 *      the same speaker-labeled captions.
 *
 * Fail-safe: if SpeechRecognition is missing or errors, we log and stay quiet
 * — never break the call audio path.
 */

import type { Room } from "livekit-client";
import {
  encodeRoomData,
  isAgentParticipant,
  ROOM_DATA_TOPIC,
  type TranscriptMessage,
} from "@/lib/roomDataProtocol";
import { useCallUiStore } from "@/stores/callUiStore";

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isBrowserSttAvailable(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

function roomHasAgent(room: Room): boolean {
  try {
    for (const p of room.remoteParticipants.values()) {
      if (isAgentParticipant(p)) return true;
    }
  } catch {
    // room tearing down
  }
  return false;
}

function buildMsg(
  room: Room,
  text: string,
  isFinal: boolean,
  segmentId?: string,
): TranscriptMessage | null {
  const lp = room.localParticipant;
  if (!lp) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const msg: TranscriptMessage = {
    type: "transcript",
    participantId: lp.identity,
    name: lp.name || lp.identity || "You",
    text: trimmed,
    isFinal,
    ts: Date.now(),
  };
  if (segmentId) msg.segmentId = segmentId;
  return msg;
}

function publishAndIngest(room: Room, msg: TranscriptMessage): void {
  // Local panel first so the speaker sees captions even if publish fails.
  useCallUiStore.getState().ingestTranscript(msg);
  try {
    const payload = encodeRoomData(msg);
    // livekit-client publishData is fire-and-forget (returns Promise).
    void room.localParticipant.publishData(payload, {
      reliable: true,
      topic: ROOM_DATA_TOPIC,
    });
  } catch (e) {
    console.debug("humanTranscript publish failed", e);
  }
}

/**
 * Owns one SpeechRecognition session for a LiveKit Room. Create once per call;
 * call start()/stop() as agents join/leave or the call ends.
 */
export class HumanTranscriptSession {
  private room: Room;
  private rec: SpeechRecognitionLike | null = null;
  private wanted = false;
  private running = false;
  private stopped = false;
  private interimSegId: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(room: Room) {
    this.room = room;
  }

  /** Begin (or re-evaluate) captioning. No-ops when an agent is present. */
  start(): void {
    this.wanted = true;
    this.stopped = false;
    this.ensureRunning();
  }

  /** Stop captioning for good (call hang-up). */
  stop(): void {
    this.wanted = false;
    this.stopped = true;
    this.teardownRec();
  }

  /**
   * Re-check agent presence. Call when participants join/leave so we hand off
   * to (or take over from) the agent STT path.
   */
  reevaluate(): void {
    if (!this.wanted || this.stopped) return;
    this.ensureRunning();
  }

  private ensureRunning(): void {
    if (this.stopped || !this.wanted) {
      this.teardownRec();
      return;
    }
    // Prefer the agent STT path when an agent is in the room.
    if (roomHasAgent(this.room)) {
      this.teardownRec();
      return;
    }
    if (this.running) return;
    this.spinUp();
  }

  private spinUp(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      console.debug(
        "humanTranscript: Web Speech API unavailable — human captions need an agent or a Chromium browser",
      );
      return;
    }
    this.teardownRec();
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang =
      (typeof navigator !== "undefined" && navigator.language) || "en-US";

    rec.onresult = (ev) => {
      if (this.stopped) return;
      // Skip if an agent joined mid-utterance.
      if (roomHasAgent(this.room)) {
        this.teardownRec();
        return;
      }
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? "";
        if (!text.trim()) continue;
        if (result.isFinal) {
          const segmentId = `browser-${this.room.localParticipant.identity}-${Date.now()}`;
          const msg = buildMsg(this.room, text, true, segmentId);
          if (msg) publishAndIngest(this.room, msg);
          this.interimSegId = null;
        } else {
          if (!this.interimSegId) {
            this.interimSegId = `browser-interim-${this.room.localParticipant.identity}`;
          }
          const msg = buildMsg(this.room, text, false, this.interimSegId);
          if (msg) publishAndIngest(this.room, msg);
        }
      }
    };

    rec.onerror = (ev) => {
      // "aborted" / "no-speech" are normal; "not-allowed" means no mic perm.
      const err = ev?.error ?? "unknown";
      if (err === "not-allowed" || err === "service-not-allowed") {
        console.warn("humanTranscript: speech recognition not allowed", err);
        this.wanted = false;
        this.teardownRec();
        return;
      }
      // Other errors: let onend restart if still wanted.
      console.debug("humanTranscript recognition error", err);
    };

    rec.onend = () => {
      this.running = false;
      // Continuous mode often ends after a pause — restart while still wanted.
      if (this.stopped || !this.wanted) return;
      if (roomHasAgent(this.room)) return;
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopped && this.wanted && !roomHasAgent(this.room)) {
          this.spinUp();
        }
      }, 250);
    };

    try {
      rec.start();
      this.rec = rec;
      this.running = true;
    } catch (e) {
      console.debug("humanTranscript start failed", e);
      this.running = false;
      this.rec = null;
    }
  }

  private teardownRec(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const rec = this.rec;
    this.rec = null;
    this.running = false;
    this.interimSegId = null;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.stop();
    } catch {
      try {
        rec.abort();
      } catch {
        // already dead
      }
    }
  }
}
