/**
 * Dev-only helper to inject sample transcript lines so the live-transcript
 * panel is testable NOW, before the real STT producer exists.
 *
 * There is no transcript producer wired yet (that's a later track). This feeds
 * the SAME store path real `transcript` data-channel messages will use, so the
 * panel renders and autoscrolls exactly as it will in production.
 *
 * Usage (any of):
 *   - Append `?devtranscript` to the URL → a hidden "seed transcript" control
 *     appears in the transcript panel header (see TranscriptPanel).
 *   - From the devtools console: `window.__stableSeedTranscript()` for a canned
 *     conversation, or `window.__stableInjectTranscript({ ...TranscriptMessage })`
 *     for a single line.
 *
 * Stripped of behavioral effect in normal use — it only ever writes to the
 * transcript buffer, never the audio path.
 */

import { useCallUiStore } from "@/stores/callUiStore";
import type { TranscriptMessage } from "@/lib/roomDataProtocol";

/** True when the `?devtranscript` flag is present in the URL. */
export function isDevTranscriptEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("devtranscript");
}

/** Inject a single transcript line straight into the panel buffer. */
export function injectTranscriptLine(msg: TranscriptMessage): void {
  useCallUiStore.getState().ingestTranscript(msg);
}

const SAMPLE_SCRIPT: ReadonlyArray<{
  participantId: string;
  name: string;
  text: string;
}> = [
  { participantId: "agent-majik", name: "Majik", text: "Hey Aaron — I'm on the call. What are we tackling?" },
  { participantId: "you", name: "You", text: "Let's review the deploy. Can you pull the latest status?" },
  { participantId: "agent-majik", name: "Majik", text: "On it. The commander instance is green across all five subdomains." },
  { participantId: "you", name: "You", text: "Switch us to a focus view so I can see your screen while we talk." },
  { participantId: "agent-majik", name: "Majik", text: "Done — pinning myself. The last deploy was six hours ago, no errors." },
];

/**
 * Seed a short canned conversation, streaming each line as an interim then a
 * final (so the partial→final visual difference is exercised). Resolves when
 * the script finishes.
 */
export async function seedSampleTranscript(): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < SAMPLE_SCRIPT.length; i++) {
    const entry = SAMPLE_SCRIPT[i];
    if (!entry) continue;
    const baseTs = now + i * 1200;
    const segmentId = `dev-${baseTs}-${entry.participantId}`;

    // Stream the line word-by-word as interim hypotheses…
    const words = entry.text.split(" ");
    for (let w = 1; w <= words.length; w++) {
      injectTranscriptLine({
        type: "transcript",
        participantId: entry.participantId,
        name: entry.name,
        text: words.slice(0, w).join(" "),
        isFinal: false,
        ts: baseTs,
        segmentId,
      });
      await delay(70);
    }
    // …then commit it as final.
    injectTranscriptLine({
      type: "transcript",
      participantId: entry.participantId,
      name: entry.name,
      text: entry.text,
      isFinal: true,
      ts: baseTs,
      segmentId,
    });
    await delay(300);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Expose the helpers on `window` for console use, but only behind the
 * `?devtranscript` flag so they never leak into a normal session.
 */
export function installDevTranscriptGlobals(): void {
  if (typeof window === "undefined" || !isDevTranscriptEnabled()) return;
  const w = window as unknown as {
    __stableSeedTranscript?: () => Promise<void>;
    __stableInjectTranscript?: (msg: TranscriptMessage) => void;
  };
  w.__stableSeedTranscript = seedSampleTranscript;
  w.__stableInjectTranscript = injectTranscriptLine;
}
