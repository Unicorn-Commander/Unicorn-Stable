import { create } from "zustand";
import { presenterQueryValue } from "@/lib/presenterMode";

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

/**
 * `?present=1` (or `=0`) is read here, before the first render, so a page
 * opened with it never paints one frame of the unfiltered app. AppShell strips
 * the parameter from the address bar afterwards.
 */
function urlChoice(): boolean | null {
  try {
    return presenterQueryValue(window.location.search);
  } catch {
    return null;
  }
}

const stored = readKey(anonKey()) ?? { enabled: false, safeRoomIds: [] };
const fromUrl = urlChoice();
const initial = fromUrl === null ? stored : { ...stored, enabled: fromUrl };

/**
 * True when the mode was chosen on this page before we knew who is signed in
 * (the URL parameter, or a toggle on the sign-in screen). That choice is the
 * newest fact, so the first `scopeToUser` keeps it instead of loading an older
 * saved value over it.
 */
let decidedBeforeIdentity = fromUrl !== null;

export const usePresenterStore = create<PresenterState>((set, get) => ({
  enabled: initial.enabled === true,
  safeRoomIds: initial.safeRoomIds ?? [],
  scopedUserId: null,

  setEnabled: (enabled) => {
    if (get().scopedUserId === null) decidedBeforeIdentity = true;
    set({ enabled });
    writeForState(get());
  },

  toggleEnabled: () => {
    if (get().scopedUserId === null) decidedBeforeIdentity = true;
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
    const current = get();
    const fromAnonymous = current.scopedUserId === null;
    const keepChoice = decidedBeforeIdentity && fromAnonymous;
    decidedBeforeIdentity = false;
    set({
      // A choice made on this page before sign-in wins. Otherwise the user's
      // saved value; with none saved, whatever the device is doing now (if it
      // is hiding, it keeps hiding).
      enabled: keepChoice
        ? current.enabled
        : saved
          ? saved.enabled === true
          : current.enabled,
      // "Safe to show" is one person's decision about their own rooms. A user
      // with nothing saved inherits the list only from the signed-out state of
      // this page, never from the previous person on the device.
      safeRoomIds: saved?.safeRoomIds ?? (fromAnonymous ? current.safeRoomIds : []),
      scopedUserId: userId,
    });
    writeForState(get());
  },
}));


/** Test seam: forget a pre-sign-in choice between cases. */
export function resetPresenterSessionForTests(decided = false): void {
  decidedBeforeIdentity = decided;
}
