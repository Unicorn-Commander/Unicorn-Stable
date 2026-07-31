import { create } from "zustand";

/**
 * Instance-scoped human presence for the People directory / drawer.
 *
 * Room presence still lives on appStore member rows (patched by usePresence
 * from room-scoped WS events). This store is the GLOBAL view: online/offline
 * for anyone on the active Stable instance, including people you do not share
 * a room with.
 *
 * Security: only ever filled from THIS instance's directory snapshot and its
 * WS fanout. On a federated server switch, reset() must run so presence from
 * server A never paints on server B's people list.
 */

export interface PresenceEntry {
  isOnline: boolean;
  updatedAt: number;
}

export interface DirectoryPresenceInput {
  id: string;
  is_online: boolean;
}

interface PresenceState {
  byId: Record<string, PresenceEntry>;
  /** Seed / refresh from GET /users/directory (or any roster with is_online). */
  setFromDirectory: (entries: DirectoryPresenceInput[]) => void;
  /** Apply a live WS presence delta for one participant. */
  applyEvent: (participantId: string, isOnline: boolean) => void;
  /** Wipe on active-instance change — no cross-server bleed. */
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  byId: {},

  setFromDirectory: (entries) => {
    if (entries.length === 0) return;
    const now = Date.now();
    set((state) => {
      const next = { ...state.byId };
      for (const entry of entries) {
        if (!entry.id) continue;
        next[entry.id] = { isOnline: Boolean(entry.is_online), updatedAt: now };
      }
      return { byId: next };
    });
  },

  applyEvent: (participantId, isOnline) => {
    if (!participantId) return;
    const now = Date.now();
    set((state) => ({
      byId: {
        ...state.byId,
        [participantId]: { isOnline, updatedAt: now },
      },
    }));
  },

  reset: () => set({ byId: {} }),
}));

/**
 * Read one person's online bit. Prefer live store over a static directory
 * flag when present; fall back to `fallback` (e.g. last directory poll).
 */
export function usePersonOnline(
  participantId: string | null | undefined,
  fallback = false,
): boolean {
  const isOnline = usePresenceStore((s) =>
    participantId ? s.byId[participantId]?.isOnline : undefined,
  );
  if (typeof isOnline === "boolean") return isOnline;
  return fallback;
}

/** Non-hook lookup for non-React call sites (drawer sorts, etc.). */
export function isPersonOnline(
  participantId: string,
  fallback = false,
): boolean {
  const entry = usePresenceStore.getState().byId[participantId];
  if (entry) return entry.isOnline;
  return fallback;
}
