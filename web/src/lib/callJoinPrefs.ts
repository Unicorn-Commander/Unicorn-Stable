/**
 * Call-entry preferences, cached per user in this browser.
 *
 * The SOURCE OF TRUTH is the server (`users/me/preferences.call_prefs`) so a
 * choice made at the desk follows the phone; this file is the offline cache
 * and the pre-login fallback, keyed per user like `mediaDevices.ts`.
 *
 * History: v1 stored `skipDeviceCheck` (default false = every call asked).
 * That default is what kept a voice call from ever connecting on a phone, so
 * the model flipped: voice calls never ask, and the only stored choice is
 * whether VIDEO calls get the pre-join check (default off). A v1 record is
 * read as "no check" whatever it said — nobody who set the old toggle wanted
 * more dialogs.
 */
import {
  DEFAULT_CALL_ENTRY_PREFS,
  type CallEntryPrefs,
} from "@/lib/callEntry";

export type CallJoinPrefs = CallEntryPrefs;

export const DEFAULT_CALL_JOIN_PREFS: CallJoinPrefs = {
  ...DEFAULT_CALL_ENTRY_PREFS,
};

const KEY = "stable.call-join.v2";
const LEGACY_KEY = "stable.call-join.v1";

function userKey(userId?: string | null): string {
  return userId || "anonymous";
}

function readAll(): Record<string, Partial<CallJoinPrefs>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}") as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, Partial<CallJoinPrefs>>)
      : {};
  } catch {
    return {};
  }
}

export function readCallJoinPrefs(userId?: string | null): CallJoinPrefs {
  const mine = readAll()[userKey(userId)] || {};
  return {
    ...DEFAULT_CALL_JOIN_PREFS,
    checkDevicesBeforeVideo: mine.checkDevicesBeforeVideo === true,
  };
}

export function saveCallJoinPrefs(
  userId: string | null | undefined,
  patch: Partial<CallJoinPrefs>,
): CallJoinPrefs {
  const next = { ...readCallJoinPrefs(userId), ...patch };
  try {
    const all = readAll();
    all[userKey(userId)] = next;
    localStorage.setItem(KEY, JSON.stringify(all));
    // The v1 record has no meaning any more; drop it so it can't be misread.
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage unavailable — the in-memory value still applies this session.
  }
  return next;
}
