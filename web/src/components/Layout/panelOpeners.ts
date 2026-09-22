/**
 * Gesture-safe openers for room panels.
 *
 * `window.open` has to run inside the click or keydown that the user just
 * made. PanelHost registers its portal opener on mount; the call bar and the
 * shortcuts call it synchronously. Nothing here navigates a second app.
 */
import type { RoomPanelId } from "@/stores/panelRegistry";

export interface PanelOpener {
  open: () => boolean;
  close: () => void;
  /** True while this panel's browser window is still open. */
  isOpen: () => boolean;
}

export type OpenPanelResult = "opened" | "blocked" | "unmounted";

const openers = new Map<string, PanelOpener>();

function key(roomId: string, id: RoomPanelId): string {
  return `${roomId}:${id}`;
}

export function registerPanelOpener(
  roomId: string,
  id: RoomPanelId,
  opener: PanelOpener,
): () => void {
  const k = key(roomId, id);
  openers.set(k, opener);
  return () => {
    if (openers.get(k) === opener) openers.delete(k);
  };
}

export function isPanelWindowOpen(roomId: string, id: RoomPanelId): boolean {
  const opener = openers.get(key(roomId, id));
  if (!opener) return false;
  return opener.isOpen();
}

export function openPanelWindow(
  roomId: string,
  id: RoomPanelId,
): OpenPanelResult {
  const opener = openers.get(key(roomId, id));
  if (!opener) return "unmounted";
  return opener.open() ? "opened" : "blocked";
}

export function closePanelWindow(roomId: string, id: RoomPanelId): void {
  openers.get(key(roomId, id))?.close();
}
