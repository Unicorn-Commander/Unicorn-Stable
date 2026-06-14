/**
 * Per-room message drafts. Persisted in localStorage so the unsent text
 * survives reloads, room switches, and tab restores. Keyed by roomId.
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

export function getDraft(roomId: string): string {
  return read()[roomId] ?? "";
}

export function saveDraft(roomId: string, text: string): void {
  const map = read();
  if (text.trim()) {
    map[roomId] = text;
  } else {
    delete map[roomId];
  }
  write(map);
}

export function clearDraft(roomId: string): void {
  const map = read();
  delete map[roomId];
  write(map);
}
