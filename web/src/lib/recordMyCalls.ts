/**
 * "Record calls I start" — a personal default.
 *
 * The account preference does not exist on the server yet (call_prefs only
 * stores the video device-check). This device remembers the choice until
 * that field lands. Default off: recording someone is an explicit opt-in.
 */

const KEY = "stable.record-my-calls.v1";

export function loadRecordMyCalls(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveRecordMyCalls(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode — the in-memory toggle still works for this page */
  }
}
