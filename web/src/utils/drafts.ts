/**
 * Per-room message drafts. Persisted in localStorage so the unsent text
 * survives reloads, room switches, and tab restores. Keyed by roomId.
 *
 * Sidebar rows subscribe via `subscribeDrafts` so the draft pencil appears
 * the moment text is typed anywhere and disappears when it's sent/cleared.
 */

const KEY = "stable.drafts.v1";

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function write(map: Record<string, string>): void {
  localStorage.setItem(KEY, JSON.stringify(map));
}

// ── Change notification (for the sidebar draft pencil) ────────────────────
type DraftListener = () => void;
const listeners = new Set<DraftListener>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to draft changes; returns an unsubscribe function. */
export function subscribeDrafts(listener: DraftListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDraft(roomId: string): string {
  return read()[roomId] ?? "";
}

export function hasDraft(roomId: string): boolean {
  return !!getDraft(roomId);
}

export function saveDraft(roomId: string, text: string): void {
  const map = read();
  const trimmed = text.trim();
  if (trimmed) {
    if (map[roomId] === trimmed) return;
    map[roomId] = trimmed;
  } else {
    if (!map[roomId]) return;
    delete map[roomId];
  }
  write(map);
  notify();
}

export function clearDraft(roomId: string): void {
  const map = read();
  if (!map[roomId]) return;
  delete map[roomId];
  write(map);
  notify();
}
