/**
 * Per-channel notification level. Stored client-side in localStorage.
 *
 * Three levels (Discord-style):
 *   - "all"      → notify on every message (default)
 *   - "mentions" → still shows an unread badge, but only pings (sound/toast/OS
 *                  notification) when the message @-mentions you (or @here /
 *                  @channel)
 *   - "muted"    → fully silent: no badge, no ping (same as the old "muted")
 *
 * Backward-compatible: the legacy `stable.muted-rooms.v1` set of muted room ids
 * is still read and treated as level "muted", so existing mutes survive. New
 * writes go to `stable.notify-levels.v1` as a Record<roomId, level>. `isMuted()`
 * keeps its old meaning (level === "muted") so existing callers are unchanged.
 */

const KEY = "stable.muted-rooms.v1"; // legacy: string[] of muted room ids
const LKEY = "stable.notify-levels.v1"; // new: Record<roomId, NotifyLevel>

export type NotifyLevel = "all" | "mentions" | "muted";

function readLevels(): Record<string, NotifyLevel> {
  const out: Record<string, NotifyLevel> = {};
  // Legacy muted set first (lowest precedence)…
  try {
    const legacy = localStorage.getItem(KEY);
    if (legacy) {
      for (const id of JSON.parse(legacy) as string[]) out[id] = "muted";
    }
  } catch {
    /* ignore malformed legacy value */
  }
  // …then the new per-room level map wins.
  try {
    const raw = localStorage.getItem(LKEY);
    if (raw) Object.assign(out, JSON.parse(raw) as Record<string, NotifyLevel>);
  } catch {
    /* ignore malformed value */
  }
  return out;
}

function writeLevels(m: Record<string, NotifyLevel>): void {
  // Only persist non-default levels to keep the record small.
  const pruned: Record<string, NotifyLevel> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v !== "all") pruned[k] = v;
  }
  localStorage.setItem(LKEY, JSON.stringify(pruned));
  window.dispatchEvent(new Event("stable.muted-changed"));
}

export function getNotifyLevel(roomId: string): NotifyLevel {
  return readLevels()[roomId] ?? "all";
}

export function setNotifyLevel(roomId: string, level: NotifyLevel): void {
  const m = readLevels();
  m[roomId] = level;
  writeLevels(m);
}

/** True only when the room is fully muted (level "muted"). */
export function isMuted(roomId: string): boolean {
  return getNotifyLevel(roomId) === "muted";
}

/** Legacy toggle kept for compatibility: flips between muted ↔ all. */
export function toggleMute(roomId: string): boolean {
  const next: NotifyLevel =
    getNotifyLevel(roomId) === "muted" ? "all" : "muted";
  setNotifyLevel(roomId, next);
  return next === "muted";
}

export function getMuted(): string[] {
  const m = readLevels();
  return Object.keys(m).filter((k) => m[k] === "muted");
}

export function onMutedChange(cb: () => void): () => void {
  window.addEventListener("stable.muted-changed", cb);
  return () => window.removeEventListener("stable.muted-changed", cb);
}
