/**
 * "Join calls immediately" — the per-user, per-browser preference that skips
 * the pre-join "Check your devices" dialog and drops straight into the call.
 *
 * Stored beside the device preferences (same per-user keying as
 * `mediaDevices.ts`) so a studio machine remembers both "which mic" and
 * "don't ask me" together. Missing/unparseable → defaults (dialog shown).
 */

export interface CallJoinPrefs {
  /** Skip the pre-join device check and connect on the first click. */
  skipDeviceCheck: boolean;
}

export const DEFAULT_CALL_JOIN_PREFS: CallJoinPrefs = { skipDeviceCheck: false };

const KEY = "stable.call-join.v1";

function userKey(userId?: string | null): string {
  return userId || "anonymous";
}

export function readCallJoinPrefs(userId?: string | null): CallJoinPrefs {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<
      string,
      Partial<CallJoinPrefs>
    >;
    const mine = all[userKey(userId)] || {};
    return {
      ...DEFAULT_CALL_JOIN_PREFS,
      skipDeviceCheck: mine.skipDeviceCheck === true,
    };
  } catch {
    return { ...DEFAULT_CALL_JOIN_PREFS };
  }
}

export function saveCallJoinPrefs(
  userId: string | null | undefined,
  patch: Partial<CallJoinPrefs>,
): CallJoinPrefs {
  const next = { ...readCallJoinPrefs(userId), ...patch };
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<
      string,
      Partial<CallJoinPrefs>
    >;
    all[userKey(userId)] = next;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable — the in-memory value still applies this session.
  }
  return next;
}
