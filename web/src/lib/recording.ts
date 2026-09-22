/**
 * Recording receipts — design §8, web half.
 *
 * The pill, the Record menu, the room policy, and the guest consent line all
 * read this module. The live pill is a pure function of the `recording_state`
 * WebSocket payload (`active`, `kind`, `started_by`, `started_at`); nothing
 * here starts a recording by painting the pill.
 */

export type RecordingPolicy = "off" | "on_request" | "always";
export type RecordingKind = "audio" | "composite" | "track";
/** Kinds the call-bar menu can ask the server to start. `track` is later. */
export type RecordingStartKind = "audio" | "composite";

export const RECORDER_ROLE = "stable-recorder";

export interface RecordingState {
  active: boolean;
  kind: RecordingKind | null;
  startedBy: string | null;
  startedByName: string | null;
  startedAt: string | null;
}

export const IDLE_RECORDING: RecordingState = {
  active: false,
  kind: null,
  startedBy: null,
  startedByName: null,
  startedAt: null,
};

export type RecordingTransitionKind = "start" | "stop" | "none";

export interface RecordingTransition {
  prev: RecordingState;
  next: RecordingState;
  transition: RecordingTransitionKind;
}

export interface RecordingFrame {
  roomId: string | null;
  state: RecordingState;
}

const POLICIES: readonly RecordingPolicy[] = ["off", "on_request", "always"];
const KINDS: readonly RecordingKind[] = ["audio", "composite", "track"];

export function isRecordingPolicy(value: unknown): value is RecordingPolicy {
  return typeof value === "string" && (POLICIES as readonly string[]).includes(value);
}

export function isRecordingKind(value: unknown): value is RecordingKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

export function isRecordingStartKind(value: unknown): value is RecordingStartKind {
  return value === "audio" || value === "composite";
}

/** Server-side recording requires the Keycloak realm role `stable-recorder`. */
export function userMayRecord(roles: readonly string[] | null | undefined): boolean {
  return !!roles?.includes(RECORDER_ROLE);
}

/** `off` hides the control. Ask and Always both allow an entitled start. */
export function policyAllowsRecording(policy: RecordingPolicy | null | undefined): boolean {
  return policy === "on_request" || policy === "always";
}

export function showRecordControl(opts: {
  roles: readonly string[] | null | undefined;
  policy: RecordingPolicy | null | undefined;
}): boolean {
  return userMayRecord(opts.roles) && policyAllowsRecording(opts.policy);
}

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read one `recording_state` frame. Returns null when `active` is missing —
 * a frame we cannot trust must not paint a pill or play a chime.
 * `room_id` is optional; the caller falls back to the call they are in.
 */
export function parseRecordingFrame(raw: unknown): RecordingFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.active !== "boolean") return null;
  const kind = isRecordingKind(record.kind) ? record.kind : null;
  const state: RecordingState = {
    active: record.active,
    kind,
    startedBy: readString(record, "started_by"),
    startedByName: readString(record, "started_by_name"),
    startedAt: readString(record, "started_at"),
  };
  return { roomId: readString(record, "room_id"), state };
}

function sameRecording(a: RecordingState, b: RecordingState): boolean {
  if (a.kind !== b.kind && a.kind !== null && b.kind !== null) return false;
  if (a.startedBy && b.startedBy && a.startedBy !== b.startedBy) return false;
  if (a.startedAt && b.startedAt && a.startedAt !== b.startedAt) return false;
  return true;
}

function mergeActive(prev: RecordingState, next: RecordingState): RecordingState {
  return {
    active: true,
    kind: next.kind ?? prev.kind,
    startedBy: next.startedBy ?? prev.startedBy,
    startedByName: next.startedByName ?? prev.startedByName,
    startedAt: next.startedAt ?? prev.startedAt,
  };
}

/**
 * Fold one frame onto the room's current recording.
 * A repeat of the same recording is `none` (no second chime, no second line).
 * A refinement that only fills in a name or a start time is also `none`.
 */
export function reduceRecordingState(
  prev: RecordingState,
  incoming: RecordingState,
): RecordingTransition {
  if (!prev.active && incoming.active) {
    return { prev, next: mergeActive(IDLE_RECORDING, incoming), transition: "start" };
  }
  if (prev.active && !incoming.active) {
    return { prev, next: IDLE_RECORDING, transition: "stop" };
  }
  if (prev.active && incoming.active) {
    const next = mergeActive(prev, incoming);
    if (sameRecording(prev, incoming)) {
      return { prev, next, transition: "none" };
    }
    return { prev, next, transition: "start" };
  }
  return { prev, next: IDLE_RECORDING, transition: "none" };
}

export function formatClock(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/** Elapsed `MM:SS` (or `H:MM:SS`) since `startedAt`. Unknown start → `00:00`. */
export function formatRecElapsed(startedAt: string | null, nowMs: number): string {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(start)) return "00:00";
  return formatClock((nowMs - start) / 1000);
}

export function formatRecordingDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  return formatClock(seconds);
}

/**
 * `● REC 12:04 · started by Aaron`
 * The middle dot and the REC marker are the receipt everyone looks for.
 */
export function formatRecPill(
  state: Pick<RecordingState, "startedAt">,
  startedByName: string,
  nowMs: number,
): string {
  const who = startedByName.trim() || "someone";
  return `● REC ${formatRecElapsed(state.startedAt, nowMs)} · started by ${who}`;
}

export interface NameSource {
  id?: string | null;
  participant_id?: string | null;
  user_id?: string | null;
  display_name?: string | null;
  username?: string | null;
}

export function starterDisplayName(
  state: Pick<RecordingState, "startedBy" | "startedByName">,
  members: readonly NameSource[] | null | undefined,
): string {
  if (state.startedByName?.trim()) return state.startedByName.trim();
  if (!state.startedBy) return "someone";
  const match = members?.find(
    (member) =>
      member.participant_id === state.startedBy ||
      member.user_id === state.startedBy ||
      member.id === state.startedBy,
  );
  const name = match?.display_name?.trim() || match?.username?.trim();
  return name || "someone";
}

export function recordingKindLabel(kind: string | null | undefined): string {
  if (kind === "composite") return "Video";
  if (kind === "track") return "Tracks";
  if (kind === "audio") return "Audio";
  return "Recording";
}

export function recordingSystemLine(
  transition: RecordingTransitionKind,
  state: Pick<RecordingState, "kind">,
  startedByName: string,
): string | null {
  const who = startedByName.trim() || "someone";
  if (transition === "start") {
    return `Recording started · ${recordingKindLabel(state.kind).toLowerCase()} · started by ${who}`;
  }
  if (transition === "stop") {
    return `Recording stopped · started by ${who}`;
  }
  return null;
}

export interface PolicyOption {
  value: RecordingPolicy;
  label: string;
  /** What this choice does to the people in the room, in plain words. */
  consequence: string;
}

export const RECORDING_POLICY_OPTIONS: readonly PolicyOption[] = [
  {
    value: "off",
    label: "Off",
    consequence:
      "Calls in this room are not recorded. The Record button stays hidden, and no REC pill appears.",
  },
  {
    value: "on_request",
    label: "Ask",
    consequence:
      "Someone with the recorder role can start a recording during a call. Everyone sees a red REC pill, hears a chime, and a line in chat.",
  },
  {
    value: "always",
    label: "Always",
    consequence:
      "Every call in this room is recorded from the moment it starts. Everyone in the call sees the red REC pill.",
  },
];

export function policyOption(policy: RecordingPolicy): PolicyOption {
  const found = RECORDING_POLICY_OPTIONS.find((option) => option.value === policy);
  if (found) return found;
  return {
    value: "off",
    label: "Off",
    consequence:
      "Calls in this room are not recorded. The Record button stays hidden, and no REC pill appears.",
  };
}

/**
 * Personal default "Record calls I start".
 * Only Ask rooms, only an entitled person, and only a call they started
 * (a rejoin of people already on the line does not count).
 */
export function shouldAutoStartRecording(opts: {
  recordMyCalls: boolean;
  entitled: boolean;
  policy: RecordingPolicy | null | undefined;
  callResult: string;
}): boolean {
  if (!opts.recordMyCalls || !opts.entitled) return false;
  if (opts.policy !== "on_request") return false;
  return (
    opts.callResult === "joined_channel" ||
    opts.callResult === "joined_no_ring" ||
    opts.callResult === "joined_ringing" ||
    opts.callResult === "joined_unreachable" ||
    opts.callResult === "joined_ring_failed"
  );
}

export function autoStartKind(
  kind: RecordingKind | null | undefined,
): RecordingStartKind {
  return kind === "composite" ? "composite" : "audio";
}

/**
 * The join-screen line. Absent policy and an inactive room say nothing —
 * the server has not told us this room records.
 */
export function guestRecordingConsent(input: {
  policy: string | null | undefined;
  active: boolean | null | undefined;
}): string | null {
  if (input.active === true) {
    return "A recording is on in this room right now. Everyone in the call sees a red REC pill. Join only if that's okay.";
  }
  if (input.policy === "always") {
    return "This room records every call. Everyone sees a red REC pill while the recording is on.";
  }
  if (input.policy === "on_request") {
    return "This room can record calls. If someone starts one, everyone sees a red REC pill.";
  }
  return null;
}

export interface RecordingRowFacts {
  started_by?: string | null;
  started_by_name?: string | null;
  storage_url?: string | null;
  mo_session_id?: string | null;
  session_url?: string | null;
}

export function mayDownloadRecording(opts: {
  myRole: string | null | undefined;
  myParticipantId: string | null | undefined;
  startedBy: string | null | undefined;
  storageUrl: string | null | undefined;
}): boolean {
  if (!httpUrl(opts.storageUrl)) return false;
  if (opts.myRole === "owner" || opts.myRole === "admin") return true;
  return !!opts.myParticipantId && opts.myParticipantId === opts.startedBy;
}

export function httpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

/** A real Meeting-Ops link when the row carries one. An id alone is not a URL. */
export function meetingOpsHref(row: RecordingRowFacts): string | null {
  return httpUrl(row.session_url) ?? httpUrl(row.mo_session_id);
}

export function formatRecordingWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(t);
}

export function recordingWho(
  row: RecordingRowFacts,
  members: readonly NameSource[] | null | undefined,
): string {
  return starterDisplayName(
    {
      startedBy: row.started_by ?? null,
      startedByName: row.started_by_name ?? null,
    },
    members,
  );
}
