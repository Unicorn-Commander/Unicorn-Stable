import { create } from "zustand";

export const PRESENTER_PREF_KEY = "stable.presenter.v1";

interface StoredPresenterPrefs {
  enabled?: boolean;
  safeRoomIds?: string[];
}

interface PresenterState {
  enabled: boolean;
  safeRoomIds: string[];
  scopedUserId: string | null;
  setEnabled: (enabled: boolean) => void;
  toggleEnabled: () => void;
  toggleSafeRoom: (roomId: string) => void;
  setSafeRoom: (roomId: string, safe: boolean) => void;
  scopeToUser: (userId: string | null) => void;
}

const anonKey = () => PRESENTER_PREF_KEY;
const userKey = (userId: string) => `${PRESENTER_PREF_KEY}::${userId}`;

function readKey(key: string): StoredPresenterPrefs | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPresenterPrefs;
    return {
      enabled: parsed.enabled === true,
      safeRoomIds: Array.isArray(parsed.safeRoomIds)
        ? parsed.safeRoomIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function writeKey(key: string, prefs: StoredPresenterPrefs): void {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // Private mode / blocked storage: the state still applies for this session.
  }
}

function prefsOf(state: Pick<PresenterState, "enabled" | "safeRoomIds">): StoredPresenterPrefs {
  return { enabled: state.enabled, safeRoomIds: [...state.safeRoomIds] };
}

function writeForState(
  state: Pick<PresenterState, "enabled" | "safeRoomIds" | "scopedUserId">,
): void {
  const prefs = prefsOf(state);
  writeKey(anonKey(), prefs);
  if (state.scopedUserId) writeKey(userKey(state.scopedUserId), prefs);
}

const initial = readKey(anonKey()) ?? { enabled: false, safeRoomIds: [] };

export const usePresenterStore = create<PresenterState>((set, get) => ({
  enabled: initial.enabled === true,
  safeRoomIds: initial.safeRoomIds ?? [],
  scopedUserId: null,

  setEnabled: (enabled) => {
    set({ enabled });
    writeForState(get());
  },

  toggleEnabled: () => {
    const enabled = !get().enabled;
    set({ enabled });
    writeForState(get());
  },

  toggleSafeRoom: (roomId) => {
    const ids = new Set(get().safeRoomIds);
    if (ids.has(roomId)) ids.delete(roomId);
    else ids.add(roomId);
    set({ safeRoomIds: [...ids] });
    writeForState(get());
  },

  setSafeRoom: (roomId, safe) => {
    const ids = new Set(get().safeRoomIds);
    if (safe) ids.add(roomId);
    else ids.delete(roomId);
    set({ safeRoomIds: [...ids] });
    writeForState(get());
  },

  scopeToUser: (userId) => {
    if (!userId) {
      set({ scopedUserId: null });
      return;
    }
    const saved = readKey(userKey(userId));
    const next = saved ?? prefsOf(get());
    set({
      enabled: next.enabled === true,
      safeRoomIds: next.safeRoomIds ?? [],
      scopedUserId: userId,
    });
    writeForState(get());
  },
}));

