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
 * Three message families today:
 *   - `transcript` — near-real-time speaker-labeled caption lines (interim +
 *     final). Every human browser publishes its own `local_mic` captions; the
 *     in-room agent publishes its replies and a linked-participant STT fallback.
 *     The transcript store deduplicates matching browser/agent hypotheses.
 *   - `ui_command`  — AG-UI-style imperative UI control ("change the call view",
 *     "focus this participant", "pin this participant", …). Only honored when the
 *     sender is an AGENT — this is the seam that lets Majik drive the interface.
 *   - artifact events (`artifact_created` / `artifact_updated`) — the canvas
 *     co-working channel. The backend broadcasts these when an artifact gains a
 *     new version (human OR agent edit); the canvas store re-fetches the
 *     affected artifact so the panel live-updates. NOTE: these are tagged with
 *     an `event` field (not `type`), matching the server's broadcast envelope.
 *
 * The envelope is JSON encoded as UTF-8 bytes (LiveKit data packets are
 * `Uint8Array`). Keep messages small; data packets are not a bulk channel.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRE-CONTRACT EVOLUTION (view-modes + tile-interaction system)
 * ─────────────────────────────────────────────────────────────────────────────
 * This is a DELIBERATE, ADDITIVE two-sided change (see audit §4c). The closed
 * unions below GREW — they were never narrowed — so old producers/consumers keep
 * working and new capabilities are allow-listed in lockstep:
 *   • `CallViewMode` gained `"spotlight"` (auto active-speaker, SFU-ranked) and
 *     `"screen"` (screen-share-first / presentation stage). `"compact" | "focus"
 *     | "grid" | "sidebar"` are all preserved.
 *   • `UiCommandAction` gained `"pinParticipant"` — agent-drivable (no user
 *     gesture needed), unlike pop-out / picture-in-picture which are
 *     user-activation-gated and therefore intentionally NOT on the wire.
 * The producer side (Brigade agent) must mirror these additions.
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
  /**
   * Attribution provenance. `local_mic` is the human speaker's own browser,
   * `agent_stt` is the linked-participant fallback, `captioner` is the elected
   * agent's per-track STT, `server` is an opted-in clip sent to the STT proxy,
   * and `agent` is the agent's spoken reply. Optional for older producers.
   */
  source?: "local_mic" | "agent_stt" | "captioner" | "server" | "agent";
}

/* ------------------------------------------------------------------ *
 * UI-command messages (AG-UI seam)
 * ------------------------------------------------------------------ */

/**
 * The call view modes the UI can switch between. CLOSED union — the receiver
 * allow-lists against {@link CALL_VIEW_MODES}, so growing it is a deliberate
 * two-sided change.
 *
 *   - `compact`   — audio-first bar: avatar chips, no video tiles (the default).
 *   - `grid`      — "Gallery": equal, paginated, best-fit tiles.
 *   - `focus`     — legacy alias of the big-stage layout; kept for back-compat.
 *                   Renders identically to `spotlight` (one big tile + filmstrip)
 *                   and is what `focusParticipant` still switches to.
 *   - `spotlight` — "Speaker" / "Spotlight": one big tile + a filmstrip. Who is
 *                   big resolves as pinned ?? focused ?? active-speaker ?? …, so
 *                   the SAME mode serves BOTH auto-active-speaker (no pin) and a
 *                   sticky manual pin.
 *   - `sidebar`   — co-working dock: a narrow vertical column beside chat.
 *   - `screen`    — "Presentation": a screen share fills the stage with a people
 *                   filmstrip.
 */
export type CallViewMode =
  | "compact"
  | "focus"
  | "grid"
  | "sidebar"
  | "spotlight"
  | "screen";

/**
 * Imperative UI actions an agent may invoke. Keep this list closed — the
 * receiver allow-lists against it and silently drops anything else, so adding a
 * capability is a deliberate two-sided change.
 *
 * NOTE: pop-out (`window.open`) and picture-in-picture
 * (`requestPictureInPicture`) are intentionally NOT here. They require a
 * synchronous user-activation gesture (a click) and would silently fail if
 * driven by an inbound data packet, so they stay human-only controls. The
 * agent-drivable additions are the view modes + `pinParticipant`.
 */
export type UiCommandAction =
  | "setViewMode"
  | "toggleVideo"
  | "toggleTranscript"
  | "focusParticipant"
  | "pinParticipant";

/** Args per action, discriminated by `action` for exhaustive handling. */
export type UiCommandArgs =
  | { action: "setViewMode"; args: { mode: CallViewMode } }
  | { action: "toggleVideo"; args: { on?: boolean } }
  | { action: "toggleTranscript"; args: { on?: boolean } }
  | { action: "focusParticipant"; args: { participantId: string } }
  /**
   * Durable, sticky spotlight pin. `participantId: null` clears the pin (returns
   * spotlight to auto active-speaker). A non-null id both pins AND switches the
   * room to `spotlight` so the agent's intent is visible (see
   * `uiCommandBus.pinParticipant`), mirroring `focusParticipant` → `focus`.
   */
  | { action: "pinParticipant"; args: { participantId: string | null } };

/**
 * UI-command envelope. `type` discriminates it from transcript packets on the
 * same channel; the `action`/`args` pair is one of {@link UiCommandArgs}.
 */
export type UiCommandMessage = {
  type: "ui_command";
} & UiCommandArgs;

/* ------------------------------------------------------------------ *
 * Voice-relay frames (talk gate + activation config)
 * ------------------------------------------------------------------ */

/**
 * How the room's voice relay decides a spoken line is addressed to it.
 * CLOSED union mirroring the server's VOICE_ACTIVATION_MODES
 * (server/app/api/rooms.py) and agents/voice_relay/agent.py::ACTIVATION_MODES.
 * Each side validates independently; an unknown value degrades to the safe
 * default ("name") instead of crashing — see {@link coerceVoiceActivationMode}.
 */
export const VOICE_ACTIVATION_MODES = [
  "name",
  "window",
  "always",
  "ptt",
  "off",
] as const;
export type VoiceActivationMode = (typeof VOICE_ACTIVATION_MODES)[number];

export function isVoiceActivationMode(v: unknown): v is VoiceActivationMode {
  return (
    typeof v === "string" &&
    (VOICE_ACTIVATION_MODES as readonly string[]).includes(v)
  );
}

/** Absent/unknown → the server's default ("name"), never a crash. */
export function coerceVoiceActivationMode(v: unknown): VoiceActivationMode {
  return isVoiceActivationMode(v) ? v : "name";
}

/**
 * The external talk gate (a foot pedal, stream deck, hotkey…) was held or
 * released. Broadcast server-side by POST /gateway/talk-gate — the frame is
 * the ONLY signal; nothing is stored — so the client must treat a lost close
 * frame as possible and time the indicator out (see callUiStore's talk-gate
 * safety timeout).
 */
export interface TalkGateMessage {
  type: "talk_gate";
  /** true = held (the relay is treating speech as addressed to it). */
  open: boolean;
  /** Gateway principal that sent it (an agent id, e.g. "rook"). */
  by: string;
  /**
   * The agent the held pedal addresses (a username, e.g. "agent-grok").
   * Absent = the room's relay persona — the pre-E04 behaviour.
   */
  target?: string;
}

export function isTalkGateMessage(v: unknown): v is TalkGateMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.type === "talk_gate" &&
    typeof m.open === "boolean" &&
    typeof m.by === "string" &&
    (m.target === undefined || typeof m.target === "string")
  );
}

/**
 * The room's voice-activation mode changed (PATCH /rooms/{id}/voice-settings
 * broadcasts this into the live call so a relay — and every open client —
 * switches immediately instead of waiting for the next call). `activation` is
 * validated against the closed union; a frame carrying a mode this bundle
 * doesn't know is dropped by the decoder (the follow-up room refetch still
 * reconciles the persisted value).
 */
export interface RelayConfigMessage {
  type: "relay_config";
  activation: VoiceActivationMode;
  /** Participant UUID of whoever changed it. */
  by: string;
  /** Present when activation is `window`. Sliding follow-up window in seconds. */
  window_seconds?: number;
}

export function isRelayConfigMessage(v: unknown): v is RelayConfigMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.type === "relay_config" &&
    isVoiceActivationMode(m.activation) &&
    typeof m.by === "string"
  );
}

/* ------------------------------------------------------------------ *
 * Artifact (canvas) events
 * ------------------------------------------------------------------ */

/**
 * Broadcast when a room's artifact is created or gains a new version. The
 * canvas store reacts by re-fetching the affected artifact (if it's the one
 * open) and bumping the room's artifact list.
 *
 * Unlike transcript/ui_command (which discriminate on `type`), the backend
 * tags these on an `event` field — both shapes are decoded on the same channel.
 */
export interface ArtifactEventMessage {
  event: "artifact_created" | "artifact_updated";
  room_id: string;
  artifact_id: string;
  /** The new current version's id (may be absent on some emits). */
  current_version_id?: string | null;
  /** The new current version's seq. */
  seq?: number | null;
  /**
   * The edit op that produced the version, when the server includes it:
   * "rewrite" | "edit" | "restore" (server/app/api/artifacts.py passes these as
   * a plain string to `broadcast_artifact_event`). Typed open as `string` so a
   * new op name from a newer backend is not a type error on an older bundle.
   */
  op?: string | null;
}

export function isArtifactEventMessage(v: unknown): v is ArtifactEventMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    (m.event === "artifact_created" || m.event === "artifact_updated") &&
    typeof m.room_id === "string" &&
    typeof m.artifact_id === "string"
  );
}

/**
 * Normalize an artifact event off EITHER realtime plane into the canonical
 * shape, accepting the discriminator under `event` OR `type`.
 *
 * Why the tolerance: the backend broadcaster historically tagged these packets
 * `{type: "artifact_created", …}` while this decoder only ever matched on
 * `event` — so every artifact packet on the LiveKit channel decoded to `null`
 * and was dropped. The server now sends both keys, but accepting either means
 * the client works against an older backend too (the deployed image is baked,
 * so the web bundle and the API roll independently).
 *
 * Returns `null` for anything that isn't a well-formed artifact event.
 */
export function coerceArtifactEvent(v: unknown): ArtifactEventMessage | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const kind = m.event ?? m.type;
  if (kind !== "artifact_created" && kind !== "artifact_updated") return null;
  // Keep `op` honest against its declared type rather than passing an
  // unvalidated field through a type predicate that never looks at it.
  const candidate = {
    ...m,
    event: kind,
    op: typeof m.op === "string" ? m.op : null,
  };
  return isArtifactEventMessage(candidate) ? candidate : null;
}

/* ------------------------------------------------------------------ *
 * Union + codec
 * ------------------------------------------------------------------ */

/** Every message that can travel on {@link ROOM_DATA_TOPIC}. */
export type RoomDataMessage =
  | TranscriptMessage
  | UiCommandMessage
  | TalkGateMessage
  | RelayConfigMessage
  | ArtifactEventMessage;

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
  // Transcript + ui_command discriminate on `type`.
  if (obj.type === "transcript") {
    return isTranscriptMessage(obj) ? obj : null;
  }
  if (obj.type === "ui_command") {
    return isUiCommandMessage(obj) ? obj : null;
  }
  // Voice-relay frames (server-broadcast; see gateway.py + rooms.py).
  if (obj.type === "talk_gate") {
    return isTalkGateMessage(obj) ? obj : null;
  }
  if (obj.type === "relay_config") {
    return isRelayConfigMessage(obj) ? obj : null;
  }
  // Artifact events discriminate on `event` (server broadcast envelope), with
  // `type` accepted as the legacy alias — see coerceArtifactEvent.
  const artifact = coerceArtifactEvent(obj);
  if (artifact) return artifact;
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
    typeof m.ts === "number" &&
    (m.source === undefined ||
      m.source === "local_mic" ||
      m.source === "agent_stt" ||
      m.source === "captioner" ||
      m.source === "server" ||
      m.source === "agent")
  );
}

const UI_COMMAND_ACTIONS: ReadonlySet<string> = new Set<UiCommandAction>([
  "setViewMode",
  "toggleVideo",
  "toggleTranscript",
  "focusParticipant",
  "pinParticipant",
]);

const CALL_VIEW_MODES: ReadonlySet<string> = new Set<CallViewMode>([
  "compact",
  "focus",
  "grid",
  "sidebar",
  "spotlight",
  "screen",
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
      return (
        typeof args.participantId === "string" && args.participantId.length > 0
      );
    case "pinParticipant":
      // `null` clears the pin; a non-empty string pins that participant.
      return (
        args.participantId === null ||
        (typeof args.participantId === "string" &&
          args.participantId.length > 0)
      );
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
