/**
 * Alt+↑/↓ — the keyboard walk down the sidebar, one room per press.
 *
 * The order comes from the same model RoomList draws (see
 * sidebarRoomOrder). Two things make a walk more than "the next row":
 *
 * - Every step opens a room, which clears its unread, and the list is
 *   unread-first: the row just visited moves. A walk that re-read the order
 *   on every press skipped rows and looped (review 2, P1-3: general →
 *   thread → Jason → dev → general …, ops and war-room never reached). So a
 *   walk keeps the order it started with, for as long as Alt is held, or
 *   while presses come less than KEYBOARD_WALK_FREEZE_MS apart.
 * - Home puts the cursor in its composer. Alt+arrows are word and line
 *   motions while typing, so a field normally keeps them — but an empty
 *   message box has nothing to move through, and there the walk goes on
 *   (as in Slack).
 */

/** A walk keeps its order while presses come closer together than this. */
export const KEYBOARD_WALK_FREEZE_MS = 1500;

export interface KeyboardWalk {
  /** The order the walk started with: one entry per row, room ids. */
  entries: readonly (readonly string[])[];
  /** When the walk last stepped (ms). */
  at: number;
  /** Alt has been held down since that step. */
  held: boolean;
}

/**
 * The order for this press: the walk's own while it is still going (Alt
 * held, or the last press was recent), else a fresh one from `fresh()`.
 */
export function continueWalk(
  walk: KeyboardWalk | null,
  fresh: () => readonly (readonly string[])[],
  now: number,
  freezeMs = KEYBOARD_WALK_FREEZE_MS,
): KeyboardWalk {
  const going =
    walk !== null && walk.entries.length > 0 && (walk.held || now - walk.at < freezeMs);
  return { entries: going ? walk.entries : fresh(), at: now, held: true };
}

/** Alt came up: the walk now lives only as long as the freeze window. */
export function releaseWalk(walk: KeyboardWalk | null): KeyboardWalk | null {
  return walk ? { ...walk, held: false } : null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

/** A message box (MessageInput marks its textarea) with nothing typed in it. */
export function isEmptyMessageBox(target: EventTarget | null): boolean {
  const el = target as HTMLTextAreaElement | null;
  if (!el || el.tagName !== "TEXTAREA") return false;
  return el.dataset?.composer === "message" && el.value.trim() === "";
}

/** Typing in a field keeps Alt+arrows for itself, except in an empty message box. */
export function walkBlockedBy(target: EventTarget | null): boolean {
  return isEditableTarget(target) && !isEmptyMessageBox(target);
}

/**
 * The room the address bar shows, or null (Home, a directory page). Read
 * from the URL rather than the store: navigate() changes the URL at once,
 * the store's active room a render later, and a fast second press must
 * step from where the first one went.
 */
export function roomIdFromPath(pathname: string): string | null {
  const match = /^\/c\/([^/?#]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}
