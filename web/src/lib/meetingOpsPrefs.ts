/**
 * Meeting-Ops transcript preferences.
 *
 * Two layers:
 *   1. Default preference (localStorage) — "always send call transcripts to
 *      Meeting-Ops by default" when a call starts.
 *   2. Per-session toggle (callUiStore.sendToMeetingOps) — can flip mid-call
 *      without changing the default.
 *
 * Kept client-side only: the preference is a local UX default, not a
 * server-side account setting (avoids a schema migration for a single bool).
 */

const DEFAULT_KEY = "stable.meeting-ops.transcript.default.v1";

export interface MeetingOpsTranscriptPrefs {
  /** When true, new calls start with "Send to Meeting-Ops" ON. */
  sendByDefault: boolean;
}

const DEFAULT_PREFS: MeetingOpsTranscriptPrefs = {
  // Product default: always send unless the user opts out.
  sendByDefault: true,
};

export function loadMeetingOpsPrefs(): MeetingOpsTranscriptPrefs {
  try {
    const raw = localStorage.getItem(DEFAULT_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<MeetingOpsTranscriptPrefs>;
    return {
      sendByDefault:
        typeof parsed.sendByDefault === "boolean"
          ? parsed.sendByDefault
          : DEFAULT_PREFS.sendByDefault,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveMeetingOpsPrefs(prefs: MeetingOpsTranscriptPrefs): void {
  try {
    localStorage.setItem(DEFAULT_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode / quota — in-memory session toggle still works.
  }
}

export function getSendByDefault(): boolean {
  return loadMeetingOpsPrefs().sendByDefault;
}

export function setSendByDefault(value: boolean): void {
  saveMeetingOpsPrefs({ ...loadMeetingOpsPrefs(), sendByDefault: value });
}
