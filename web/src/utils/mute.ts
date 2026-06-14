/**
 * Per-channel mute. Stored client-side in localStorage as a Set of room ids.
 * When a room is muted: notifications hook skips toasts AND email opt-out is
 * advised (but client can't enforce email — backend respects user prefs only).
 */

const KEY = "stable.muted-rooms.v1";

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function write(s: Set<string>): void {
  localStorage.setItem(KEY, JSON.stringify([...s]));
  window.dispatchEvent(new Event("stable.muted-changed"));
}

export function isMuted(roomId: string): boolean {
  return read().has(roomId);
}

export function toggleMute(roomId: string): boolean {
  const s = read();
  if (s.has(roomId)) {
    s.delete(roomId);
  } else {
    s.add(roomId);
  }
  write(s);
  return s.has(roomId);
}

export function getMuted(): string[] {
  return [...read()];
}

export function onMutedChange(cb: () => void): () => void {
  window.addEventListener("stable.muted-changed", cb);
  return () => window.removeEventListener("stable.muted-changed", cb);
}
