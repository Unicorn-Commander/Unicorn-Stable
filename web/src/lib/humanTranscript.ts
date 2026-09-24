/**
 * Browser-side live captions for the LOCAL human participant.
 *
 * This module runs for every human participant, including rooms with an agent.
 * A LiveKit AgentSession is linked to one participant and its speaker_id is
 * normally null unless the STT provider performs diarization. It therefore
 * cannot truthfully identify every human in a group call. The local browser
 * owns the one fact it can prove: which signed-in person's mic produced the
 * audio.
 *
 * The Web Speech API captions that local mic and:
 *   1. ingests lines into callUiStore (local TranscriptPanel), and
 *   2. publishes them on the LiveKit `stable` data topic so remote peers see
 *      the same speaker-labeled captions.
 *
 * The agent STT path remains active as a quality/fallback source; callUiStore
 * deduplicates it when a matching local-mic line arrives.
 *
 * Fail-safe: if SpeechRecognition is missing or errors, we log and stay quiet
 * — never break the call audio path.
 */

import type { Room } from "livekit-client";
import {
  encodeRoomData,
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

function buildMsg(
  room: Room,
  text: string,
  isFinal: boolean,
  source: "local_mic" | "server",
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
    source,
  };
  if (segmentId) msg.segmentId = segmentId;
  return msg;
}

/** Publish one final from this browser: Web Speech, or an opted-in server clip. */
export function publishLocalCaption(
  room: Room,
  text: string,
  source: "local_mic" | "server",
): void {
  const segmentId = `${source}-${room.localParticipant.identity}-${Date.now()}`;
  const msg = buildMsg(room, text, true, source, segmentId);
  if (msg) publishAndIngest(room, msg);
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
 * Owns one SpeechRecognition session for a LiveKit Room. Create once per call
 * and call start()/stop() with the call lifecycle.
 */
export class HumanTranscriptSession {
  private room: Room;
  private rec: SpeechRecognitionLike | null = null;
  private wanted = false;
  private micEnabled = false;
  private running = false;
  private stopped = false;
  private interimSegId: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** True when a remote human is the active speaker and we are not — pause
   *  recognition so far-end audio from speakers is not captioned as "me". */
  private remoteDominant = false;

  constructor(room: Room) {
    this.room = room;
  }

  /** Begin captioning the signed-in participant's local microphone. */
  start(): void {
    this.wanted = true;
    this.stopped = false;
    this.micEnabled = this.room.localParticipant.isMicrophoneEnabled;
    this.ensureRunning();
  }

  /**
   * Mirror the call's real mute state. SpeechRecognition owns a browser mic
   * capture separate from LiveKit, so failing to stop it here would keep
   * captioning after the person pressed Mute.
   */
  syncMicrophone(enabled: boolean): void {
    this.micEnabled = enabled;
    if (!this.wanted || this.stopped) return;
    this.ensureRunning();
  }

  /** Stop captioning for good (call hang-up). */
  stop(): void {
    this.wanted = false;
    this.stopped = true;
    this.teardownRec();
  }

  /**
   * Stop recognition without ending the call. Used when a pinned mic or an
   * agent captioner takes the lane. start() arms it again.
   */
  suspend(): void {
    this.wanted = false;
    this.teardownRec();
  }

  /** True while this call still wants browser captions. */
  isArmed(): boolean {
    return this.wanted && !this.stopped;
  }

  isRemoteDominant(): boolean {
    return this.remoteDominant;
  }

  /**
   * Kept for the call lifecycle's participant-change hook. A recognition
   * engine can end during device churn, so this also restarts it if needed.
   */
  reevaluate(): void {
    if (!this.wanted || this.stopped) return;
    this.ensureRunning();
  }

  /**
   * Pause local captions when a remote human is clearly the active speaker.
   * Web Speech listens to the system mic path and often hears the other
   * person through speakers, which re-labels their words as ours.
   */
  setRemoteDominant(dominant: boolean): void {
    if (this.remoteDominant === dominant) return;
    this.remoteDominant = dominant;
    if (!this.wanted || this.stopped) return;
    this.ensureRunning();
  }

  private ensureRunning(): void {
    if (
      this.stopped ||
      !this.wanted ||
      !this.micEnabled ||
      this.remoteDominant
    ) {
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
      if (this.stopped || !this.micEnabled) return;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? "";
        if (!text.trim()) continue;
        if (result.isFinal) {
          const segmentId = `browser-${this.room.localParticipant.identity}-${Date.now()}`;
          const msg = buildMsg(this.room, text, true, "local_mic", segmentId);
          if (msg) publishAndIngest(this.room, msg);
          this.interimSegId = null;
        } else {
          if (!this.interimSegId) {
            this.interimSegId = `browser-interim-${this.room.localParticipant.identity}`;
          }
          const msg = buildMsg(
            this.room,
            text,
            false,
            "local_mic",
            this.interimSegId,
          );
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
      if (this.stopped || !this.wanted || !this.micEnabled || this.remoteDominant) {
        return;
      }
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (
          !this.stopped &&
          this.wanted &&
          this.micEnabled &&
          !this.remoteDominant
        ) {
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
