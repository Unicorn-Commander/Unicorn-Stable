/**
 * Server-worded system lines, drawn from their metadata.
 *
 * The server writes a system line from a closed vocabulary — "Audio
 * recording started", "Hub thread started" — because a seat reads those
 * lines as `[system] …` and a name or a title somebody chose must never
 * ride in them. The people-facing facts live in `metadata`: who started the
 * recording and why, the thread's title and its starter. The web puts them
 * back together here, for the member room and the guest room alike.
 *
 * Pure: a guest gets no members' availability and only `{kind}` on agent
 * rows, and may resolve no name at all — every helper then says less,
 * never something wrong, and never throws.
 */

export interface NameSource {
  participant_id?: string | null;
  id?: string | null;
  user_id?: string | null;
  display_name?: string | null;
  username?: string | null;
}

export interface SystemLineMessage {
  content: string;
  sender_type?: string | null;
  content_type?: string | null;
  sender_name?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** A participant id → the name the room's roster has for it, or null. */
export function memberName(
  id: string | null | undefined,
  members: readonly NameSource[] | null | undefined,
): string | null {
  if (!id) return null;
  const match = members?.find(
    (member) => member.participant_id === id || member.id === id || member.user_id === id,
  );
  return match?.display_name?.trim() || match?.username?.trim() || null;
}

/** A line the server (or the client, for a local receipt) wrote as "system". */
export function isSystemLine(message: {
  sender_type?: string | null;
  content_type?: string | null;
}): boolean {
  return message.sender_type === "system" || message.content_type === "system";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---- Recording notices -------------------------------------------------------

export type RecordingEvent = "started" | "stopped" | "failed";

export interface RecordingNotice {
  event: RecordingEvent;
  recordingKind: string | null;
  recordingId: string | null;
  /** A participant id. */
  startedBy: string | null;
  /**
   * On a start: user, policy always, record_my_calls. On a stop:
   * stop_requested, room_idle, room_finished, ended, failed. On a failure:
   * an error string.
   */
  reason: string | null;
}

export function recordingNoticeOf(message: {
  metadata?: Record<string, unknown> | null;
}): RecordingNotice | null {
  const meta = message.metadata;
  if (!meta || meta.kind !== "recording") return null;
  const event = meta.event;
  if (event !== "started" && event !== "stopped" && event !== "failed") return null;
  return {
    event,
    recordingKind: str(meta.recording_kind),
    recordingId: str(meta.recording_id),
    startedBy: str(meta.started_by),
    reason: str(meta.reason),
  };
}

const START_REASON: Record<string, (name: string | null) => string | null> = {
  // Somebody pressed Record: the starter's name is the whole story.
  user: () => null,
  manual: () => null,
  "policy always": () => "this room always records",
  policy_always: () => "this room always records",
  record_my_calls: (name) => (name ? `${name} records their calls` : "record my calls is on"),
};

const STOP_REASON: Record<string, string> = {
  stop_requested: "on request",
  room_idle: "the room went idle",
  room_finished: "the call ended",
  ended: "the call ended",
  failed: "the recorder failed",
};

function humanize(reason: string): string {
  return reason.replace(/_/g, " ");
}

/**
 * "Audio recording started · by Aaron", "Audio recording stopped · the room
 * went idle · started by Aaron", "Recording failed · <the error>".
 * The starter is named only when the roster resolves the id; the reason is
 * said in words, next to the word it explains; an unknown reason is shown
 * as written.
 */
export function recordingNoticeText(
  message: SystemLineMessage,
  members: readonly NameSource[] | null | undefined,
): string | null {
  const notice = recordingNoticeOf(message);
  if (!notice) return null;
  const name = memberName(notice.startedBy, members);
  const parts: string[] = [message.content.trim() || "Recording"];
  if (notice.event === "failed") {
    if (notice.reason) parts.push(notice.reason.slice(0, 200));
    return parts.join(" · ");
  }
  if (notice.event === "started") {
    const words = notice.reason
      ? (START_REASON[notice.reason]?.(name) ?? (notice.reason in START_REASON ? null : humanize(notice.reason)))
      : null;
    // "Aaron records their calls" already names the starter.
    if (name && !(words && words.startsWith(name))) parts.push(`by ${name}`);
    if (words) parts.push(words);
    return parts.join(" · ");
  }
  if (notice.reason) parts.push(STOP_REASON[notice.reason] ?? humanize(notice.reason));
  if (name) parts.push(`started by ${name}`);
  return parts.join(" · ");
}

// ---- The parent's "thread started" line ---------------------------------------

export interface ThreadStarted {
  title: string | null;
  /** A participant id. */
  createdBy: string | null;
  threadRoomId: string | null;
}

export function threadStartedOf(message: {
  metadata?: Record<string, unknown> | null;
}): ThreadStarted | null {
  const meta = message.metadata;
  if (!meta) return null;
  const marked = meta.kind === "thread_started";
  const title = str(meta.thread_title);
  const createdBy = str(meta.created_by);
  // Older lines carry the two keys without a kind.
  if (!marked && !(title && createdBy)) return null;
  return { title, createdBy, threadRoomId: str(meta.thread_room_id) };
}

/** "Aaron started a thread: Launch checklist" from `thread_title` and `created_by`. */
export function threadStartedText(
  message: SystemLineMessage,
  members: readonly NameSource[] | null | undefined,
): string | null {
  const line = threadStartedOf(message);
  if (!line) return null;
  const name = memberName(line.createdBy, members) ?? str(message.sender_name);
  if (name && line.title) return `${name} started a thread: ${line.title}`;
  if (name) return `${name} started a thread`;
  if (line.title) return `Thread started: ${line.title}`;
  return null;
}

/**
 * The sentence for a server-worded system line, or null to draw the
 * content as it is (any other system line, an old server's line).
 */
export function systemLineText(
  message: SystemLineMessage,
  members: readonly NameSource[] | null | undefined,
): string | null {
  return recordingNoticeText(message, members) ?? threadStartedText(message, members);
}

/**
 * A room's last message as one preview line. A system line has no "name:"
 * before it — its sentence already says who — and reads the way the room
 * draws it, as far as that goes without a roster.
 */
export function lastLinePreview(message: SystemLineMessage): {
  sender: string | null;
  text: string;
} {
  if (isSystemLine(message)) {
    return { sender: null, text: systemLineText(message, null) ?? message.content };
  }
  return { sender: str(message.sender_name), text: message.content };
}

// ---- The local recording receipt yields to the persisted notice ---------------

/** The client's own receipt, drawn from the socket's `recording_state` frame. */
export function localReceiptTransition(message: {
  id?: string | null;
  metadata?: Record<string, unknown> | null;
}): "start" | "stop" | null {
  const id = message.id ?? "";
  if (!id.startsWith("recording:")) return null;
  if (id.includes(":start:")) return "start";
  if (id.includes(":stop:")) return "stop";
  return null;
}

export const RECEIPT_WINDOW_MS = 90_000;

/** The `recording_id` a socket frame (or a receipt drawn from one) carries. */
export function recordingIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  return str((raw as Record<string, unknown>).recording_id);
}

/**
 * Is there a persisted notice for this transition of this recording? Then
 * the local receipt is the same fact twice and is not drawn (the two used
 * to match on their text; the server's line names nobody now).
 *
 * Matched on the recording's id when both sides carry one — exact, and
 * indifferent to a client clock that is minutes off. Otherwise on time: a
 * notice of the same transition within the window.
 */
export function hasPersistedRecordingNotice(
  messages: readonly (SystemLineMessage & { id?: string | null })[] | null | undefined,
  transition: "start" | "stop",
  at: number,
  recordingId: string | null = null,
  windowMs = RECEIPT_WINDOW_MS,
): boolean {
  const event: RecordingEvent = transition === "start" ? "started" : "stopped";
  return (messages ?? []).some((message) => {
    const notice = recordingNoticeOf(message);
    if (notice?.event !== event) return false;
    if (localReceiptTransition(message)) return false;
    if (recordingId && notice.recordingId) return notice.recordingId === recordingId;
    const stamp = Date.parse(message.created_at ?? "");
    return !Number.isFinite(stamp) || !Number.isFinite(at) || Math.abs(stamp - at) <= windowMs;
  });
}

/** A local receipt that a persisted notice already covers. */
export function isSupersededReceipt(
  message: SystemLineMessage & { id?: string | null },
  messages: readonly (SystemLineMessage & { id?: string | null })[] | null | undefined,
): boolean {
  const transition = localReceiptTransition(message);
  if (!transition) return false;
  return hasPersistedRecordingNotice(
    messages,
    transition,
    Date.parse(message.created_at ?? ""),
    recordingIdOf(message.metadata),
  );
}

/**
 * The list without the local receipts `incoming` makes redundant. Returns
 * the SAME array when there is nothing to drop, so a store can call it on
 * every message it adds and pay nothing for the usual case.
 */
export function dropSupersededReceipts<T extends SystemLineMessage & { id?: string | null }>(
  items: readonly T[],
  incoming: SystemLineMessage & { id?: string | null },
): readonly T[] {
  const event = recordingNoticeOf(incoming)?.event;
  if (event !== "started" && event !== "stopped") return items;
  if (localReceiptTransition(incoming)) return items;
  const transition = event === "started" ? "start" : "stop";
  const kept = items.filter(
    (item) =>
      localReceiptTransition(item) !== transition || !isSupersededReceipt(item, [incoming]),
  );
  return kept.length === items.length ? items : kept;
}
