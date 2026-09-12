/**
 * How a call is ENTERED — the one policy that every "start a call" button,
 * menu item and deep link goes through.
 *
 * Two kinds of call, two verbs, no shared "phone button that might ask":
 *   * a VOICE call connects the instant it is asked for, with the phone's /
 *     browser's chosen microphone and the camera off. It never shows the
 *     "Check your devices" dialog. Ever. (Aaron, 2026-09-12, from the car:
 *     the dialog was the reason a voice call from an iPhone never connected —
 *     the server saw no token request at all.)
 *   * a VIDEO call also connects immediately by default, camera on. One
 *     opt-in preference — "check devices before video calls" — brings the
 *     pre-join dialog back for video only; it follows the user across
 *     devices (server-side) so a phone never asks what the desk didn't.
 *
 * Kept pure (no React, no window) so the rule is a unit-tested fact.
 */

export type CallKind = "voice" | "video";

export interface CallEntryPrefs {
  /** Show the pre-join device check before VIDEO calls. Default off. */
  checkDevicesBeforeVideo: boolean;
}

export const DEFAULT_CALL_ENTRY_PREFS: CallEntryPrefs = {
  checkDevicesBeforeVideo: false,
};

export interface CallEntryRequest {
  /** Missing kind = the legacy bare phone button = a voice call. */
  kind?: CallKind | null;
  /** Explicit override (deep link `join=1` always joins straight in). */
  skipDeviceCheck?: boolean;
  /** Explicit camera flag (deep link `video=1`); kind decides when absent. */
  video?: boolean;
}

export interface CallEntry {
  kind: CallKind;
  /** Publish the camera on join. */
  video: boolean;
  /** Skip the pre-join device check. */
  skipDeviceCheck: boolean;
}

export function resolveCallEntry(
  req: CallEntryRequest | undefined,
  prefs: CallEntryPrefs = DEFAULT_CALL_ENTRY_PREFS,
): CallEntry {
  const kind: CallKind = req?.kind ?? (req?.video === true ? "video" : "voice");
  if (kind === "voice") {
    // A voice call NEVER asks and never publishes the camera — not for the
    // preference, not for a stale override, not for a contradictory flag.
    return { kind, video: false, skipDeviceCheck: true };
  }
  const video = req?.video ?? true;
  const skipDeviceCheck =
    req?.skipDeviceCheck ?? !prefs.checkDevicesBeforeVideo;
  return { kind, video, skipDeviceCheck };
}

/** Human labels shared by every entry point so the two verbs read the same everywhere. */
export const CALL_KIND_LABEL: Record<CallKind, string> = {
  voice: "Voice call",
  video: "Video call",
};
