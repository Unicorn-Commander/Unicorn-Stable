import { create } from "zustand";
import type {
  CallViewMode,
  TalkGateMessage,
  TranscriptMessage,
  UiCommandMessage,
} from "@/lib/roomDataProtocol";
import { getSendByDefault } from "@/lib/meetingOpsPrefs";
import {
  CAPTION_IDLE_FACTS,
  reduceCaptionState,
  writeServerCaptionEnabled,
  type CaptionFacts,
  type CaptionState,
} from "@/lib/captionState";

/**
 * Mobile intent modes for in-call layout (phones / narrow viewports).
 * Separate from desktop {@link CallViewMode} (grid/focus/sidebar/…) so the
 * human-first switcher (Video / Split / Chat) never fights Gallery/Speaker.
 */
export type MobileCallMode = "video" | "split" | "chat";

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
 *      lines commit. The on-screen list stays capped. A separate export
 *      buffer keeps every accepted final for Meeting-Ops.
 *   6. Mobile intent mode (`mobileCallMode`: video | split | chat) + optional
 *      chat bottom sheet — session-scoped, not persisted; resets with the call.
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
  source?: TranscriptMessage["source"];
}

/** Which room's video surface is detached into a pop-out window (transient). */
export interface PopoutState {
  open: boolean;
  ownerRoomId: string | null;
}

/**
 * On-screen caption cap. Oldest lines drop off the panel. The export buffer
 * is separate so a long call does not lose its beginning in Meeting-Ops.
 */
export const MAX_TRANSCRIPT_LINES = 500;

/**
 * Memory ceiling for the export buffer. Compaction at export time, not this
 * cap, is what fits the 2000-line Meeting-Ops contract.
 */
export const MAX_EXPORT_TRANSCRIPT_LINES = 20_000;
const TRANSCRIPT_DEDUPE_WINDOW_MS = 12_000;

/**
 * How long an OPEN talk gate may stand without a close frame before the
 * indicator clears itself. The gate is broadcast-only (nothing is stored
 * server-side — see gateway.py /talk-gate), so a lost `open:false` frame
 * would otherwise pin "the agent can hear you" on screen forever, which is
 * exactly the kind of silent lie the indicator exists to prevent.
 */
export const TALK_GATE_SAFETY_TIMEOUT_MS = 120_000;

/** The live talk-gate signal ("the pedal is held right now"). */
export interface TalkGateState {
  open: boolean;
  /** Gateway principal holding the gate (an agent id), when open. */
  by: string | null;
  /**
   * The agent the pedal addresses (a username, e.g. "agent-grok"), when the
   * open frame named one. Absent = the room's relay persona.
   */
  target?: string;
}

const TALK_GATE_CLOSED: TalkGateState = { open: false, by: null };

// Safety-timeout handle for the open gate. Module-level (not store state):
// it is bookkeeping for the state transition, not itself renderable state.
let talkGateSafetyTimer: ReturnType<typeof setTimeout> | null = null;

function clearTalkGateSafetyTimer(): void {
  if (talkGateSafetyTimer !== null) {
    clearTimeout(talkGateSafetyTimer);
    talkGateSafetyTimer = null;
  }
}

function transcriptWords(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

/**
 * Browser and agent STT often segment the same utterance differently. Treat
 * lines as the same speech when one normalized string contains the other, or
 * when most words in the shorter line overlap.
 */
function isAgentEar(source: TranscriptMessage["source"] | undefined): boolean {
  return source === "agent_stt" || source === "captioner";
}

let lastCaptionFacts: CaptionFacts = { ...CAPTION_IDLE_FACTS };

function sameUtterance(a: string, b: string): boolean {
  const na = Array.from(transcriptWords(a)).join(" ");
  const nb = Array.from(transcriptWords(b)).join(" ");
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (Math.min(na.length, nb.length) >= 8 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }
  const aw = transcriptWords(a);
  const bw = transcriptWords(b);
  const shorter = Math.min(aw.size, bw.size);
  if (shorter === 0) return false;
  let overlap = 0;
  aw.forEach((word) => {
    if (bw.has(word)) overlap++;
  });
  return overlap / shorter >= 0.72;
}

/** Finals that scrolled off the panel but are still inside the echo window. */
function exportLinesInWindow(
  exportLines: readonly TranscriptLine[],
  ts: number,
  seen: ReadonlySet<string>,
): TranscriptLine[] {
  if (exportLines.length === 0) return [];
  const min = ts - TRANSCRIPT_DEDUPE_WINDOW_MS;
  const max = ts + TRANSCRIPT_DEDUPE_WINDOW_MS;
  const extra: TranscriptLine[] = [];
  for (const candidate of exportLines) {
    if (candidate.ts < min || candidate.ts > max) continue;
    if (seen.has(candidate.id)) continue;
    extra.push(candidate);
  }
  return extra;
}

function authorityPool(
  lines: TranscriptLine[],
  exportLines: readonly TranscriptLine[],
  ts: number,
): TranscriptLine[] {
  const seen = new Set<string>();
  for (const candidate of lines) seen.add(candidate.id);
  const extra = exportLinesInWindow(exportLines, ts, seen);
  return extra.length === 0 ? lines : lines.concat(extra);
}

function withoutMatches(
  lines: TranscriptLine[],
  predicate: (candidate: TranscriptLine) => boolean,
): TranscriptLine[] {
  let changed = false;
  const next: TranscriptLine[] = [];
  for (const candidate of lines) {
    if (predicate(candidate)) changed = true;
    else next.push(candidate);
  }
  return changed ? next : lines;
}

function capExportBuffer(lines: TranscriptLine[]): TranscriptLine[] {
  if (lines.length <= MAX_EXPORT_TRANSCRIPT_LINES) return lines;
  const dropped = lines.length - MAX_EXPORT_TRANSCRIPT_LINES;
  console.warn(
    `call transcript export buffer dropped ${dropped} oldest final ${
      dropped === 1 ? "line" : "lines"
    } past the ${MAX_EXPORT_TRANSCRIPT_LINES}-line safety cap`,
  );
  return lines.slice(lines.length - MAX_EXPORT_TRANSCRIPT_LINES);
}

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
   * Mobile intent mode for how video + chat coexist on phones. Independent of
   * desktop `viewModes` (grid/focus/sidebar). Session-scoped.
   *
   * Default "split" (call surface + chat), NOT "video": every Stable call
   * starts audio-only (mic only — VoiceProvider never auto-enables a camera),
   * and an audio call with an agent must stay in the audio layout with chat
   * visible rather than opening a full-bleed stage of agent faces. The moment
   * REAL video exists (`anyVideoLive`) the auto-lift in CallRoomLayout takes
   * the call to "video" exactly as before; picking Video by hand is the
   * explicit bring-the-stage-up gesture.
   */
  mobileCallMode: MobileCallMode;
  /**
   * Once the user picks Video/Split/Chat, auto-defaults (video presence,
   * screen-share presentation bias) stop overwriting their choice until the
   * call ends / {@link resetMobileCallUi}.
   */
  mobileCallModeUserOverride: boolean;
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
  /**
   * Someone in the call is ACTUALLY publishing video (a camera or a screen
   * share) right now. Mirrored from VoiceVideoBar's track state so layout
   * decisions (CallRoomLayout) can distinguish a real video call from an
   * audio call without reaching into LiveKit. This — not the `showVideo`
   * preference toggle — is what "video intent" keys off.
   */
  anyVideoLive: boolean;
  /**
   * Audio-first session hold. When a call starts with no live video, a room
   * whose PERSISTED view mode is a video-stage mode (a leftover from an
   * earlier video call) is held at "compact" for this session — in memory
   * only, never written to storage — so an audio call with an agent opens as
   * the slim bar + chat, not as a stage of agent faces. `priorMode` is
   * restored automatically the moment real video appears; any explicit
   * `setViewMode` (user click or agent ui_command) clears the hold instead.
   */
  audioIntentHold: { roomId: string; priorMode: CallViewMode } | null;
  /**
   * The hold decision has been made for the current call (applied or judged
   * unnecessary). One decision per call: without this latch, video dropping
   * mid-call (camera turned off) would re-trigger the hold and collapse a
   * stage the user is deliberately looking at.
   */
  audioHoldConsumed: boolean;
  /**
   * External talk gate (foot pedal / hotkey via the gateway). While open, the
   * call surface shows the "<agent> can hear you" chip — the ONLY feedback a
   * pedal-holder gets. Cleared by the close frame, by hang-up/call-switch
   * (setActiveCallRoom), and by {@link TALK_GATE_SAFETY_TIMEOUT_MS}.
   */
  talkGate: TalkGateState;
  /** On-screen transcript (finals + one interim per speaker), capped at {@link MAX_TRANSCRIPT_LINES}. */
  transcript: TranscriptLine[];
  /**
   * Accepted finals for Meeting-Ops export. Interims never enter. A later
   * final is appended, not written over an earlier one. Echo and authority
   * rules match the on-screen list, including lines that have scrolled off
   * it. Cleared when the transcript is cleared for a new call.
   */
  exportTranscript: TranscriptLine[];
  /** Which caption lane is live, and why it is off. */
  caption: CaptionState;
  /** Per-user "Caption my microphone (server)". Default off. Not a recording. */
  serverCaptionEnabled: boolean;
  /** Registered by VoiceProvider so the panel can select the default input. */
  useDefaultMic: (() => void) | null;
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
  /**
   * Set the mobile intent mode. Pass `{ user: true }` for explicit UI picks so
   * auto presentation / video defaults won't clobber the choice.
   */
  setMobileCallMode: (
    mode: MobileCallMode,
    opts?: { user?: boolean },
  ) => void;
  /** Clear mobile intent (call end, room leave, server switch). */
  resetMobileCallUi: () => void;
  setTileHidden: (participantId: string, hidden: boolean) => void;
  focusParticipant: (participantId: string | null) => void;
  setPopoutOpen: (roomId: string, open: boolean) => void;
  setVideoPrompted: (v: boolean) => void;
  /** Mirror of "someone is publishing camera/screen video right now". */
  setAnyVideoLive: (v: boolean) => void;
  /**
   * Decide (once per call) whether this session starts audio-first. If the
   * room's mode is a video-stage mode and no video is live, hold it at
   * "compact" in memory and remember the prior mode for auto-restore.
   */
  applyAudioIntentHold: (roomId: string, isStageMode: boolean) => void;
  /** Video arrived while held → put the room's chosen stage mode back. */
  liftAudioIntentHold: (roomId: string) => void;
  setSendToMeetingOps: (on: boolean) => void;
  /** Seed session Meeting-Ops flag + call start clock when a call connects. */
  beginCallTranscriptSession: () => void;
  /**
   * Set the talk-gate signal. Opening (re)arms the safety timeout — a
   * re-asserted open frame pushes the deadline out rather than stacking
   * timers; closing cancels it.
   */
  setTalkGate: (open: boolean, by?: string | null, target?: string | null) => void;

  ingestTranscript: (msg: TranscriptMessage) => void;
  clearTranscript: () => void;
  setCaptionFacts: (facts: CaptionFacts) => void;
  setServerCaptionEnabled: (on: boolean, userId?: string | null) => void;
  hydrateServerCaptionEnabled: (on: boolean) => void;
  setUseDefaultMic: (fn: (() => void) | null) => void;
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
  mobileCallMode: "split",
  mobileCallModeUserOverride: false,
  hiddenTileIds: new Set(),
  focusedParticipantId: null,
  popout: { open: false, ownerRoomId: null },
  activeCallRoomId: null,
  videoPrompted: false,
  anyVideoLive: false,
  audioIntentHold: null,
  audioHoldConsumed: false,
  talkGate: TALK_GATE_CLOSED,
  transcript: [],
  exportTranscript: [],
  caption: reduceCaptionState(CAPTION_IDLE_FACTS),
  serverCaptionEnabled: false,
  useDefaultMic: null,
  sendToMeetingOps:
    typeof window !== "undefined" ? getSendByDefault() : true,
  callStartedAt: null,

  getViewMode: (roomId) => get().viewModes[roomId] ?? DEFAULT_CALL_VIEW_MODE,

  setViewMode: (roomId, mode) =>
    set((state) => {
      const next = { ...state.viewModes, [roomId]: mode };
      persistRecord(VIEW_MODE_KEY, next);
      // Any EXPLICIT mode choice — a user click or an agent ui_command —
      // outranks the audio-first hold; auto-restore must not fight it later.
      return { viewModes: next, audioIntentHold: null };
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

  setMobileCallMode: (mode, opts) =>
    set((state) => ({
      mobileCallMode: mode,
      mobileCallModeUserOverride:
        opts?.user === true ? true : state.mobileCallModeUserOverride,
    })),

  resetMobileCallUi: () =>
    set({
      mobileCallMode: "split",
      mobileCallModeUserOverride: false,
    }),

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

  setAnyVideoLive: (v) =>
    set((state) => (state.anyVideoLive === v ? state : { anyVideoLive: v })),

  applyAudioIntentHold: (roomId, isStageMode) =>
    set((state) => {
      // One decision per call — see audioHoldConsumed.
      if (state.audioHoldConsumed) return state;
      if (!isStageMode) {
        // Nothing to hold (already an audio-friendly mode) — decision made.
        return { audioHoldConsumed: true };
      }
      const priorMode = state.viewModes[roomId] ?? DEFAULT_CALL_VIEW_MODE;
      // In-memory only: the user's persisted stage preference survives for
      // the next call that actually has video (persistRecord is NOT called).
      return {
        audioHoldConsumed: true,
        audioIntentHold: { roomId, priorMode },
        viewModes: { ...state.viewModes, [roomId]: "compact" },
      };
    }),

  liftAudioIntentHold: (roomId) =>
    set((state) => {
      const hold = state.audioIntentHold;
      if (!hold || hold.roomId !== roomId) return state;
      return {
        audioIntentHold: null,
        viewModes: { ...state.viewModes, [roomId]: hold.priorMode },
      };
    }),

  setSendToMeetingOps: (on) => set({ sendToMeetingOps: on }),

  beginCallTranscriptSession: () =>
    set({
      // Re-read the default each call so a settings change mid-session applies
      // to the *next* call without forcing a reload.
      sendToMeetingOps: getSendByDefault(),
      callStartedAt: Date.now(),
      transcript: [],
      exportTranscript: [],
    }),

  setTalkGate: (open, by, target) => {
    // One timer, always for the LATEST open. Clearing first makes a repeated
    // open frame extend the deadline instead of letting the oldest timer win.
    clearTalkGateSafetyTimer();
    if (open) {
      talkGateSafetyTimer = setTimeout(() => {
        talkGateSafetyTimer = null;
        // A lost close frame must not pin the chip forever.
        set({ talkGate: TALK_GATE_CLOSED });
      }, TALK_GATE_SAFETY_TIMEOUT_MS);
      set({
        talkGate: {
          open: true,
          by: by ?? null,
          ...(target ? { target } : {}),
        },
      });
    } else {
      set((state) =>
        state.talkGate.open || state.talkGate.by !== null
          ? { talkGate: TALK_GATE_CLOSED }
          : state,
      );
    }
  },

  ingestTranscript: (msg) =>
    set((state) => {
      // Drop agent STT that could not name a real LiveKit participant.
      const ear = isAgentEar(msg.source);
      if (
        ear &&
        (msg.participantId === "human" ||
          msg.name === "Unidentified speaker" ||
          msg.name === "Speaker")
      ) {
        return state;
      }

      const id = msg.segmentId ?? `${msg.participantId}:${msg.ts}`;
      const line: TranscriptLine = {
        id,
        participantId: msg.participantId,
        name: msg.name,
        text: msg.text,
        isFinal: msg.isFinal,
        ts: msg.ts,
        source: msg.source,
      };

      // Collapse the rolling interim line for a speaker: while a speaker is
      // mid-utterance we keep exactly ONE non-final line for them and replace
      // it in place; a final line for that speaker supersedes their interim.
      // The export buffer never holds that interim, so a final only appends.
      let lines = state.transcript.slice();
      let exportLines = state.exportTranscript;

      const within = (a: number, b: number) =>
        Math.abs(a - b) <= TRANSCRIPT_DEDUPE_WINDOW_MS;

      // ── Authority rules ─────────────────────────────────────────────
      // 1. local_mic is authoritative for WHO spoke (browser owns its mic).
      // 2. server clips are the same mic when Web Speech cannot follow it.
      //    A matching local_mic line still wins.
      // 3. agent_stt and captioner are fallbacks — never override a matching
      //    local_mic or server line, even with a different speaker guess.
      // 4. Acoustic echo: Web Speech often captions far-end audio as "local".
      //    If another participant already published the same words, drop the
      //    later echo copy. The export buffer is part of that lookback, so a
      //    line that has scrolled off the panel still suppresses its echo.

      const matches = (candidate: TranscriptLine) =>
        within(candidate.ts, msg.ts) && sameUtterance(candidate.text, msg.text);

      const dropEchoes = (candidate: TranscriptLine) =>
        (isAgentEar(candidate.source) || candidate.source === "server") &&
        matches(candidate);

      if (ear) {
        const humanWins = authorityPool(lines, exportLines, msg.ts).some(
          (candidate) =>
            (candidate.source === "local_mic" || candidate.source === "server") &&
            matches(candidate),
        );
        if (humanWins) return state;
      }

      if (msg.source === "server") {
        const browserWins = authorityPool(lines, exportLines, msg.ts).some(
          (candidate) => candidate.source === "local_mic" && matches(candidate),
        );
        if (browserWins) return state;
        const nextLines = lines.filter(
          (candidate) => !(isAgentEar(candidate.source) && matches(candidate)),
        );
        const nextExport = withoutMatches(
          exportLines,
          (candidate) => isAgentEar(candidate.source) && matches(candidate),
        );
        const earlierRemote = authorityPool(nextLines, nextExport, msg.ts).find(
          (candidate) =>
            (candidate.source === "local_mic" || candidate.source === "server") &&
            candidate.participantId !== msg.participantId &&
            matches(candidate) &&
            candidate.ts <= msg.ts,
        );
        if (earlierRemote) return state;
        lines = nextLines;
        exportLines = nextExport;
      }

      if (msg.source === "local_mic") {
        const nextLines = lines.filter((candidate) => !dropEchoes(candidate));
        const nextExport = withoutMatches(exportLines, dropEchoes);
        const earlierRemote = authorityPool(nextLines, nextExport, msg.ts).find(
          (candidate) =>
            candidate.source === "local_mic" &&
            candidate.participantId !== msg.participantId &&
            matches(candidate) &&
            candidate.ts <= msg.ts,
        );
        if (earlierRemote) return state;
        lines = nextLines;
        exportLines = nextExport;
      }
      const interimIdx = lines.findIndex(
        (l) => !l.isFinal && l.participantId === msg.participantId,
      );

      if (msg.isFinal) {
        if (interimIdx !== -1) lines.splice(interimIdx, 1);
        lines.push(line);
        // Blank finals stay on screen but are not an export line.
        if (line.text.trim()) {
          exportLines = capExportBuffer(exportLines.concat(line));
        }
      } else if (interimIdx !== -1) {
        lines[interimIdx] = line;
      } else {
        lines.push(line);
      }

      // Trim the on-screen list from the front. The export buffer is not
      // trimmed here; MAX_EXPORT_TRANSCRIPT_LINES is its only ceiling.
      const trimmed =
        lines.length > MAX_TRANSCRIPT_LINES
          ? lines.slice(lines.length - MAX_TRANSCRIPT_LINES)
          : lines;

      return { transcript: trimmed, exportTranscript: exportLines };
    }),

  clearTranscript: () => set({ transcript: [], exportTranscript: [] }),

  setCaptionFacts: (facts) => {
    lastCaptionFacts = facts;
    set({ caption: reduceCaptionState(facts) });
  },

  setServerCaptionEnabled: (on, userId) => {
    writeServerCaptionEnabled(userId, on);
    lastCaptionFacts = { ...lastCaptionFacts, serverCaptionEnabled: on };
    set({
      serverCaptionEnabled: on,
      caption: reduceCaptionState(lastCaptionFacts),
    });
  },

  hydrateServerCaptionEnabled: (on) => {
    lastCaptionFacts = { ...lastCaptionFacts, serverCaptionEnabled: on };
    set({
      serverCaptionEnabled: on,
      caption: reduceCaptionState(lastCaptionFacts),
    });
  },

  setUseDefaultMic: (fn) => set({ useDefaultMic: fn }),
  // Drop per-call visual state on a server switch. View-mode prefs and the
  // show-video/show-transcript toggles are user preferences, so they're kept.
  // Pins are cleared (a pinned identity from another server is meaningless) and
  // the transient pop-out state is reset.
  resetForServer: () => {
    clearTalkGateSafetyTimer();
    const serverCaptionEnabled = get().serverCaptionEnabled;
    lastCaptionFacts = { ...CAPTION_IDLE_FACTS, serverCaptionEnabled };
    set({
      pinnedParticipantId: {},
      hiddenTileIds: new Set(),
      focusedParticipantId: null,
      popout: { open: false, ownerRoomId: null },
      videoPrompted: false,
      anyVideoLive: false,
      audioIntentHold: null,
      audioHoldConsumed: false,
      talkGate: TALK_GATE_CLOSED,
      transcript: [],
      exportTranscript: [],
      caption: reduceCaptionState(lastCaptionFacts),
      callStartedAt: null,
      sendToMeetingOps: getSendByDefault(),
      mobileCallMode: "split",
      mobileCallModeUserOverride: false,
    });
  },
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
  const prev = useCallUiStore.getState().activeCallRoomId;
  if (prev !== roomId) {
    // Fresh call (or hang-up): reset the per-call intent state — mobile
    // intent back to its audio-first default, live-video mirror cleared, and
    // the audio-first hold re-armed for the next session. An unlifted hold is
    // unwound first so the room's real (persisted) preference is what the
    // next call starts from. The talk gate is a live per-call signal, so it
    // (and its safety timer) reset with the call too — a chip held open by
    // the OLD call must not survive into the next one.
    clearTalkGateSafetyTimer();
    useCallUiStore.setState((state) => {
      const hold = state.audioIntentHold;
      return {
        activeCallRoomId: roomId,
        anyVideoLive: false,
        audioIntentHold: null,
        audioHoldConsumed: false,
        talkGate: TALK_GATE_CLOSED,
        viewModes: hold
          ? { ...state.viewModes, [hold.roomId]: hold.priorMode }
          : state.viewModes,
      };
    });
    useCallUiStore.getState().resetMobileCallUi();
    // A new call (or hang-up) must not keep the previous lane's explanation.
    const enabled = useCallUiStore.getState().serverCaptionEnabled;
    useCallUiStore.getState().setCaptionFacts({
      ...CAPTION_IDLE_FACTS,
      serverCaptionEnabled: enabled,
    });
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
/**
 * Route a validated {@link TalkGateMessage} into the store. Safe from
 * non-React code (the VoiceProvider data handler) — the safety timeout and
 * per-call clearing live inside setTalkGate/setActiveCallRoom.
 */
export function dispatchTalkGate(msg: TalkGateMessage): void {
  useCallUiStore.getState().setTalkGate(msg.open, msg.by, msg.target);
}

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
