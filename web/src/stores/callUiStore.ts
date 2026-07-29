import { create } from "zustand";
import type {
  CallViewMode,
  TranscriptMessage,
  UiCommandMessage,
} from "@/lib/roomDataProtocol";
import { getSendByDefault } from "@/lib/meetingOpsPrefs";

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
 *   2. `pinnedParticipantId` per room (persisted): the DURABLE spotlight pin —
 *      sticky across active-speaker changes, and it wins over the transient
 *      `focusedParticipantId`. This is what "Spotlight" mode + the per-tile pin
 *      button drive.
 *   3. `popout` — transient state describing which room's video surface is
 *      currently detached into a pop-out window (never persisted; a window can't
 *      survive a reload).
 *   4. The `uiCommandBus` — imperative actions (`setViewMode`, `toggleVideo`,
 *      `toggleTranscript`, `focusParticipant`, `pinParticipant`) the UI and
 *      AGENTS both call.
 *   5. Transcript ingest: interim lines update in place per speaker; final
 *      lines commit. Cheap to keep empty when the panel is closed.
 */

const VIEW_MODE_KEY = "stable.call-view-modes.v1";
const PIN_KEY = "stable.call-pins.v1";
export const DEFAULT_CALL_VIEW_MODE: CallViewMode = "compact";

function readPersistedRecord<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistRecord<T>(key: string, value: Record<string, T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
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

/** Which room's video surface is detached into a pop-out window (transient). */
export interface PopoutState {
  open: boolean;
  ownerRoomId: string | null;
}

/** Cap the buffer so a long call can't grow memory unbounded. */
const MAX_TRANSCRIPT_LINES = 500;

interface CallUiState {
  /** Per-room persisted view mode. Missing key ⇒ DEFAULT_CALL_VIEW_MODE. */
  viewModes: Record<string, CallViewMode>;
  /**
   * Per-room persisted spotlight pin (participant identity, or "local"). The
   * DURABLE pin: survives active-speaker changes and wins over
   * `focusedParticipantId`. `null`/missing ⇒ auto active-speaker.
   */
  pinnedParticipantId: Record<string, string | null>;
  /** Global: render participant video at all (optional video). */
  showVideo: boolean;
  /** Global: transcript panel open. Kept cheap when false (no ingest cost). */
  showTranscript: boolean;
  /**
   * Global: the chat pane is collapsed while video is the star (the user's
   * "hide chat → give video the whole screen" toggle). Drives the videoMain
   * SplitPane's controlled collapse so the in-call button and the divider
   * chevron stay in sync. `showVideo=false` is the mirror-image "hide video".
   */
  chatCollapsed: boolean;
  /** Participant identities whose video tile the user hid individually. */
  hiddenTileIds: Set<string>;
  /**
   * The participant identity to feature — the TRANSIENT active-speaker override
   * an agent sets via `focusParticipant`. Lower priority than a durable pin.
   */
  focusedParticipantId: string | null;
  /** Which room's video is currently popped out (transient — never persisted). */
  popout: PopoutState;
  /**
   * The room whose call is currently LIVE. The call now persists across
   * navigation, so this — not the viewed room — is what the call surface keys
   * off: the full call UI renders only in this room, and a floating CallDock
   * shows everywhere else. Kept in sync by VoiceProvider via
   * {@link setActiveCallRoom}. `null` ⇒ no active call.
   */
  activeCallRoomId: string | null;
  /** Auto-prompt latch: we surfaced "someone turned video on" once already. */
  videoPrompted: boolean;
  /** Transcript buffer (final + the current interim line per speaker). */
  transcript: TranscriptLine[];
  /**
   * Per-session: when true, hang-up (and the manual Send control) will POST the
   * call transcript to Stable's export endpoint, which may forward it to
   * Meeting-Ops. Seeded from the "always by default" preference on call start.
   */
  sendToMeetingOps: boolean;
  /** Epoch ms when the current call's transcript buffer was opened (connect). */
  callStartedAt: number | null;

  getViewMode: (roomId: string) => CallViewMode;
  setViewMode: (roomId: string, mode: CallViewMode) => void;
  getPinnedParticipant: (roomId: string) => string | null;
  setPinnedParticipant: (roomId: string, id: string | null) => void;
  toggleVideo: (on?: boolean) => void;
  toggleTranscript: (on?: boolean) => void;
  setChatCollapsed: (v?: boolean) => void;
  setTileHidden: (participantId: string, hidden: boolean) => void;
  focusParticipant: (participantId: string | null) => void;
  setPopoutOpen: (roomId: string, open: boolean) => void;
  setVideoPrompted: (v: boolean) => void;
  setSendToMeetingOps: (on: boolean) => void;
  /** Seed session Meeting-Ops flag + call start clock when a call connects. */
  beginCallTranscriptSession: () => void;

  ingestTranscript: (msg: TranscriptMessage) => void;
  clearTranscript: () => void;
  resetForServer: () => void;
}

export const useCallUiStore = create<CallUiState>((set, get) => ({
  viewModes:
    typeof window !== "undefined" ? readPersistedRecord<CallViewMode>(VIEW_MODE_KEY) : {},
  pinnedParticipantId:
    typeof window !== "undefined" ? readPersistedRecord<string | null>(PIN_KEY) : {},
  showVideo: true,
  // Default ON: talking to an agent, you want to SEE what it says. The CC
  // button in the call controls still toggles it off per session.
  showTranscript: true,
  chatCollapsed: false,
  hiddenTileIds: new Set(),
  focusedParticipantId: null,
  popout: { open: false, ownerRoomId: null },
  activeCallRoomId: null,
  videoPrompted: false,
  transcript: [],
  sendToMeetingOps:
    typeof window !== "undefined" ? getSendByDefault() : true,
  callStartedAt: null,

  getViewMode: (roomId) => get().viewModes[roomId] ?? DEFAULT_CALL_VIEW_MODE,

  setViewMode: (roomId, mode) =>
    set((state) => {
      const next = { ...state.viewModes, [roomId]: mode };
      persistRecord(VIEW_MODE_KEY, next);
      return { viewModes: next };
    }),

  getPinnedParticipant: (roomId) => get().pinnedParticipantId[roomId] ?? null,

  setPinnedParticipant: (roomId, id) =>
    set((state) => {
      const next = { ...state.pinnedParticipantId, [roomId]: id };
      // Drop the key entirely when clearing so the persisted map stays lean.
      if (id === null) delete next[roomId];
      persistRecord(PIN_KEY, next);
      return { pinnedParticipantId: next };
    }),

  toggleVideo: (on) =>
    set((state) => ({ showVideo: on === undefined ? !state.showVideo : on })),

  toggleTranscript: (on) =>
    set((state) => ({
      showTranscript: on === undefined ? !state.showTranscript : on,
    })),

  setChatCollapsed: (v) =>
    set((state) => ({
      chatCollapsed: v === undefined ? !state.chatCollapsed : v,
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

  setPopoutOpen: (roomId, open) =>
    set({ popout: { open, ownerRoomId: open ? roomId : null } }),

  setVideoPrompted: (v) => set({ videoPrompted: v }),

  setSendToMeetingOps: (on) => set({ sendToMeetingOps: on }),

  beginCallTranscriptSession: () =>
    set({
      // Re-read the default each call so a settings change mid-session applies
      // to the *next* call without forcing a reload.
      sendToMeetingOps: getSendByDefault(),
      callStartedAt: Date.now(),
      transcript: [],
    }),

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
  // Pins are cleared (a pinned identity from another server is meaningless) and
  // the transient pop-out state is reset.
  resetForServer: () =>
    set({
      pinnedParticipantId: {},
      hiddenTileIds: new Set(),
      focusedParticipantId: null,
      popout: { open: false, ownerRoomId: null },
      videoPrompted: false,
      transcript: [],
      callStartedAt: null,
      sendToMeetingOps: getSendByDefault(),
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
  // Also mirror into reactive store state so React surfaces (the floating
  // CallDock, the call-is-here gate in CallRoomLayout) can subscribe. Guarded
  // against a redundant set so this is a no-op when the room is unchanged.
  if (useCallUiStore.getState().activeCallRoomId !== roomId) {
    useCallUiStore.setState({ activeCallRoomId: roomId });
  }
}

/**
 * The `uiCommandBus` — a stable, imperative facade over the call-UI store that
 * the AG-UI seam dispatches validated agent commands into (and that UI controls
 * can call directly). Reads `getState()` so it's safe to call from non-React
 * code (the VoiceProvider data handler) without stale closures.
 *
 * View-mode + pin are per room, so those take a `roomId`; the other actions are
 * global. The data handler passes the active call's room.
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
    // Focusing someone only has a visible effect in a big-stage mode; switch the
    // active call's room to "focus" so the agent's intent is actually shown.
    if (activeRoomIdForCommands) {
      store.setViewMode(activeRoomIdForCommands, "focus");
    }
  },
  /**
   * Durable spotlight pin. A non-null id also switches the room to `spotlight`
   * so the agent's intent is visible (mirrors focusParticipant → focus). A null
   * id clears the pin and leaves the mode alone (returns to auto active-speaker).
   * Safe for UI controls to call directly (the per-tile pin button does).
   */
  pinParticipant(roomId: string, participantId: string | null) {
    const store = useCallUiStore.getState();
    store.setPinnedParticipant(roomId, participantId);
    if (participantId) store.setViewMode(roomId, "spotlight");
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
    case "pinParticipant":
      if (roomId) uiCommandBus.pinParticipant(roomId, msg.args.participantId);
      break;
    default:
      // Exhaustiveness guard — unreachable for valid messages.
      break;
  }
}
