import { create } from "zustand";
import type {
  CallViewMode,
  TranscriptMessage,
  UiCommandMessage,
} from "@/lib/roomDataProtocol";

/**
 * Call-UI store — modular, agent-drivable call surface state.
 *
 * Kept SEPARATE from the big {@link useAppStore} so that:
 *   - the audio path (VoiceProvider) never depends on it, and
 *   - the transcript firehose (potentially many updates/sec) re-renders only
 *     the panel that subscribes to it, not the whole app.
 *
 * Responsibilities:
 *   1. `callViewMode` per room (persisted to localStorage, audio-call default
 *      = "compact"), plus the global show-video + show-transcript toggles and
 *      per-tile hidden set.
 *   2. The `uiCommandBus` — imperative actions (`setViewMode`, `toggleVideo`,
 *      `toggleTranscript`, `focusParticipant`) the UI and AGENTS both call.
 *   3. Transcript ingest: interim lines update in place per speaker; final
 *      lines commit. Cheap to keep empty when the panel is closed.
 */

const VIEW_MODE_KEY = "stable.call-view-modes.v1";
export const DEFAULT_CALL_VIEW_MODE: CallViewMode = "compact";

function readPersistedViewModes(): Record<string, CallViewMode> {
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CallViewMode>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistViewModes(modes: Record<string, CallViewMode>): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, JSON.stringify(modes));
  } catch {
    // Private mode / quota — in-memory state still works for the session.
  }
}

/** A committed or in-flight transcript line, as held in the panel buffer. */
export interface TranscriptLine {
  /** Stable key: producer segmentId if present, else `${participantId}:${ts}`. */
  id: string;
  participantId: string;
  name: string;
  text: string;
  isFinal: boolean;
  ts: number;
}

/** Cap the buffer so a long call can't grow memory unbounded. */
const MAX_TRANSCRIPT_LINES = 500;

interface CallUiState {
  /** Per-room persisted view mode. Missing key ⇒ DEFAULT_CALL_VIEW_MODE. */
  viewModes: Record<string, CallViewMode>;
  /** Global: render participant video at all (optional video). */
  showVideo: boolean;
  /** Global: transcript panel open. Kept cheap when false (no ingest cost). */
  showTranscript: boolean;
  /** Participant identities whose video tile the user hid individually. */
  hiddenTileIds: Set<string>;
  /** The participant identity to feature in "focus" mode (active speaker pin). */
  focusedParticipantId: string | null;
  /** Auto-prompt latch: we surfaced "someone turned video on" once already. */
  videoPrompted: boolean;
  /** Transcript buffer (final + the current interim line per speaker). */
  transcript: TranscriptLine[];

  getViewMode: (roomId: string) => CallViewMode;
  setViewMode: (roomId: string, mode: CallViewMode) => void;
  toggleVideo: (on?: boolean) => void;
  toggleTranscript: (on?: boolean) => void;
  setTileHidden: (participantId: string, hidden: boolean) => void;
  focusParticipant: (participantId: string | null) => void;
  setVideoPrompted: (v: boolean) => void;

  ingestTranscript: (msg: TranscriptMessage) => void;
  clearTranscript: () => void;
  resetForServer: () => void;
}

export const useCallUiStore = create<CallUiState>((set, get) => ({
  viewModes: typeof window !== "undefined" ? readPersistedViewModes() : {},
  showVideo: true,
  // Default ON: talking to an agent, you want to SEE what it says. The CC
  // button in the call controls still toggles it off per session.
  showTranscript: true,
  hiddenTileIds: new Set(),
  focusedParticipantId: null,
  videoPrompted: false,
  transcript: [],

  getViewMode: (roomId) => get().viewModes[roomId] ?? DEFAULT_CALL_VIEW_MODE,

  setViewMode: (roomId, mode) =>
    set((state) => {
      const next = { ...state.viewModes, [roomId]: mode };
      persistViewModes(next);
      return { viewModes: next };
    }),

  toggleVideo: (on) =>
    set((state) => ({ showVideo: on === undefined ? !state.showVideo : on })),

  toggleTranscript: (on) =>
    set((state) => ({
      showTranscript: on === undefined ? !state.showTranscript : on,
    })),

  setTileHidden: (participantId, hidden) =>
    set((state) => {
      const next = new Set(state.hiddenTileIds);
      if (hidden) next.add(participantId);
      else next.delete(participantId);
      return { hiddenTileIds: next };
    }),

  focusParticipant: (participantId) =>
    set({ focusedParticipantId: participantId }),

  setVideoPrompted: (v) => set({ videoPrompted: v }),

  ingestTranscript: (msg) =>
    set((state) => {
      const id = msg.segmentId ?? `${msg.participantId}:${msg.ts}`;
      const line: TranscriptLine = {
        id,
        participantId: msg.participantId,
        name: msg.name,
        text: msg.text,
        isFinal: msg.isFinal,
        ts: msg.ts,
      };

      // Collapse the rolling interim line for a speaker: while a speaker is
      // mid-utterance we keep exactly ONE non-final line for them and replace
      // it in place; a final line for that speaker supersedes their interim.
      const lines = state.transcript.slice();
      const interimIdx = lines.findIndex(
        (l) => !l.isFinal && l.participantId === msg.participantId,
      );

      if (msg.isFinal) {
        if (interimIdx !== -1) lines.splice(interimIdx, 1);
        lines.push(line);
      } else if (interimIdx !== -1) {
        lines[interimIdx] = line;
      } else {
        lines.push(line);
      }

      // Trim from the front (oldest) if we blew past the cap.
      const trimmed =
        lines.length > MAX_TRANSCRIPT_LINES
          ? lines.slice(lines.length - MAX_TRANSCRIPT_LINES)
          : lines;

      return { transcript: trimmed };
    }),

  clearTranscript: () => set({ transcript: [] }),
  // Drop per-call visual state on a server switch. View-mode prefs and the
  // show-video/show-transcript toggles are user preferences, so they're kept.
  resetForServer: () =>
    set({
      hiddenTileIds: new Set(),
      focusedParticipantId: null,
      videoPrompted: false,
      transcript: [],
    }),
}));

/**
 * The room a ui_command applies to. The VoiceProvider keeps this in sync with
 * the connected call so the bus (which agents drive without a React context)
 * knows which room's view mode to mutate. Set to null when no call is active.
 */
let activeRoomIdForCommands: string | null = null;
export function setActiveCallRoom(roomId: string | null): void {
  activeRoomIdForCommands = roomId;
}

/**
 * The `uiCommandBus` — a stable, imperative facade over the call-UI store that
 * the AG-UI seam dispatches validated agent commands into (and that UI controls
 * can call directly). Reads `getState()` so it's safe to call from non-React
 * code (the VoiceProvider data handler) without stale closures.
 *
 * View-mode is per room, so `setViewMode` takes a `roomId`; the other actions
 * are global. The data handler passes the active call's room.
 */
export const uiCommandBus = {
  setViewMode(roomId: string, mode: CallViewMode) {
    useCallUiStore.getState().setViewMode(roomId, mode);
  },
  toggleVideo(on?: boolean) {
    useCallUiStore.getState().toggleVideo(on);
  },
  toggleTranscript(on?: boolean) {
    useCallUiStore.getState().toggleTranscript(on);
  },
  focusParticipant(participantId: string) {
    const store = useCallUiStore.getState();
    store.focusParticipant(participantId);
    // Focusing someone only has a visible effect in "focus" mode; switch the
    // active call's room there so the agent's intent is actually shown.
    if (activeRoomIdForCommands) {
      store.setViewMode(activeRoomIdForCommands, "focus");
    }
  },
};

/**
 * Dispatch a validated {@link UiCommandMessage} (already confirmed to come from
 * an agent + structurally valid) onto the bus. `roomId` is the active call's
 * room. Unknown actions are ignored defensively even though the message was
 * pre-validated.
 */
export function dispatchUiCommand(
  msg: UiCommandMessage,
  roomId: string | null,
): void {
  switch (msg.action) {
    case "setViewMode":
      if (roomId) uiCommandBus.setViewMode(roomId, msg.args.mode);
      break;
    case "toggleVideo":
      uiCommandBus.toggleVideo(msg.args.on);
      break;
    case "toggleTranscript":
      uiCommandBus.toggleTranscript(msg.args.on);
      break;
    case "focusParticipant":
      uiCommandBus.focusParticipant(msg.args.participantId);
      break;
    default:
      // Exhaustiveness guard — unreachable for valid messages.
      break;
  }
}
