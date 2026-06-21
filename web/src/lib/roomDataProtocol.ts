/**
 * Room data-channel protocol — the shared wire contract for LiveKit
 * `publishData` / `RoomEvent.DataReceived` messages that flow between humans and
 * AI agents in a Stable room.
 *
 * Both sides (this web client AND the backend / Brigade agent that drives the
 * UI later) must agree on these shapes, so this module is intentionally
 * framework-free: just TypeScript types + tiny encode/decode/guard helpers.
 * Mirror these definitions on the producer side.
 *
 * Two message families today:
 *   - `transcript` — near-real-time speaker-labeled caption lines (interim +
 *     final). Produced by the STT pipeline (Amanuensis) later; consumed by the
 *     live-transcript panel.
 *   - `ui_command`  — AG-UI-style imperative UI control ("change the call view",
 *     "focus this participant", …). Only honored when the sender is an AGENT —
 *     this is the seam that lets Majik drive the interface.
 *
 * The envelope is JSON encoded as UTF-8 bytes (LiveKit data packets are
 * `Uint8Array`). Keep messages small; data packets are not a bulk channel.
 */

import { ParticipantKind } from "livekit-client";
import type { Participant, RemoteParticipant } from "livekit-client";

/** LiveKit data-channel topic these messages are published on. */
export const ROOM_DATA_TOPIC = "stable" as const;

/* ------------------------------------------------------------------ *
 * Transcript messages
 * ------------------------------------------------------------------ */

/**
 * One transcript line. Interim (`isFinal:false`) lines update in place per
 * `participantId` until a `isFinal:true` line for that speaker commits them.
 */
export interface TranscriptMessage {
  type: "transcript";
  /** LiveKit participant identity of the speaker (e.g. "agent-majik", a uid). */
  participantId: string;
  /** Display name to label the line with ("Majik", "Aaron"). */
  name: string;
  /** The (partial or final) recognized text. */
  text: string;
  /** false = interim/streaming hypothesis; true = committed final line. */
  isFinal: boolean;
  /** Epoch ms the segment was produced. Used for ordering + autoscroll. */
  ts: number;
  /** Optional STT segment id; lets a producer revise a specific segment. */
  segmentId?: string;
}

/* ------------------------------------------------------------------ *
 * UI-command messages (AG-UI seam)
 * ------------------------------------------------------------------ */

/** The four call view modes the UI can switch between. */
export type CallViewMode = "compact" | "focus" | "grid" | "sidebar";

/**
 * Imperative UI actions an agent may invoke. Keep this list closed — the
 * receiver allow-lists against it and silently drops anything else, so adding a
 * capability is a deliberate two-sided change.
 */
export type UiCommandAction =
  | "setViewMode"
  | "toggleVideo"
  | "toggleTranscript"
  | "focusParticipant";

/** Args per action, discriminated by `action` for exhaustive handling. */
export type UiCommandArgs =
  | { action: "setViewMode"; args: { mode: CallViewMode } }
  | { action: "toggleVideo"; args: { on?: boolean } }
  | { action: "toggleTranscript"; args: { on?: boolean } }
  | { action: "focusParticipant"; args: { participantId: string } };

/**
 * UI-command envelope. `type` discriminates it from transcript packets on the
 * same channel; the `action`/`args` pair is one of {@link UiCommandArgs}.
 */
export type UiCommandMessage = {
  type: "ui_command";
} & UiCommandArgs;

/* ------------------------------------------------------------------ *
 * Union + codec
 * ------------------------------------------------------------------ */

/** Every message that can travel on {@link ROOM_DATA_TOPIC}. */
export type RoomDataMessage = TranscriptMessage | UiCommandMessage;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a message to the bytes LiveKit `publishData` expects. */
export function encodeRoomData(msg: RoomDataMessage): Uint8Array {
  return textEncoder.encode(JSON.stringify(msg));
}

/**
 * Decode + validate a received data packet. Returns the typed message, or
 * `null` if the payload isn't a well-formed message we understand (so callers
 * can ignore foreign / malformed traffic on the channel without throwing).
 */
export function decodeRoomData(payload: Uint8Array): RoomDataMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(textDecoder.decode(payload));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type === "transcript") {
    return isTranscriptMessage(obj) ? obj : null;
  }
  if (obj.type === "ui_command") {
    return isUiCommandMessage(obj) ? obj : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Type guards
 * ------------------------------------------------------------------ */

export function isTranscriptMessage(v: unknown): v is TranscriptMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.type === "transcript" &&
    typeof m.participantId === "string" &&
    typeof m.name === "string" &&
    typeof m.text === "string" &&
    typeof m.isFinal === "boolean" &&
    typeof m.ts === "number"
  );
}

const UI_COMMAND_ACTIONS: ReadonlySet<string> = new Set<UiCommandAction>([
  "setViewMode",
  "toggleVideo",
  "toggleTranscript",
  "focusParticipant",
]);

const CALL_VIEW_MODES: ReadonlySet<string> = new Set<CallViewMode>([
  "compact",
  "focus",
  "grid",
  "sidebar",
]);

export function isCallViewMode(v: unknown): v is CallViewMode {
  return typeof v === "string" && CALL_VIEW_MODES.has(v);
}

/**
 * Structural + semantic validation of a ui_command. Rejects unknown actions and
 * actions whose args don't match — defense-in-depth on top of the
 * agent-only sender gate, since these drive the interface.
 */
export function isUiCommandMessage(v: unknown): v is UiCommandMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  if (m.type !== "ui_command") return false;
  if (typeof m.action !== "string" || !UI_COMMAND_ACTIONS.has(m.action)) {
    return false;
  }
  const args = (m.args ?? {}) as Record<string, unknown>;
  switch (m.action as UiCommandAction) {
    case "setViewMode":
      return isCallViewMode(args.mode);
    case "toggleVideo":
    case "toggleTranscript":
      return args.on === undefined || typeof args.on === "boolean";
    case "focusParticipant":
      return typeof args.participantId === "string" && args.participantId.length > 0;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * Agent identification
 * ------------------------------------------------------------------ */

/**
 * Whether a LiveKit participant is an AI agent. Used to gate ui_command — only
 * agents may drive the UI.
 *
 * Robust across the ways an agent shows up:
 *   1. LiveKit `ParticipantKind.AGENT` (set when dispatched as an agent worker);
 *   2. the `agent-<brigade_id>` identity convention this app already uses
 *      everywhere (ParticipantStrip, VoiceVideoBar, StageView);
 *   3. an explicit `{ "participant_type": "agent" }` flag in participant
 *      metadata, mirroring the room-member wire format.
 */
export function isAgentParticipant(
  participant: Participant | RemoteParticipant | undefined | null,
): boolean {
  if (!participant) return false;
  if (participant.kind === ParticipantKind.AGENT) return true;
  if (participant.identity.startsWith("agent-")) return true;
  const meta = participant.metadata;
  if (meta) {
    try {
      const parsed = JSON.parse(meta) as { participant_type?: unknown };
      if (parsed?.participant_type === "agent") return true;
    } catch {
      // Non-JSON metadata — fall through; identity/kind already checked.
    }
  }
  return false;
}
