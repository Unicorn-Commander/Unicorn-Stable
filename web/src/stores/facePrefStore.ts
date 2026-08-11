/**
 * Face-style preference store — persistence + reactivity for
 * `lib/facePreference.ts`.
 *
 * Deliberately the same shape as `stores/themeStore.ts` (the palette store),
 * because it answers the same class of question — a per-user cosmetic choice
 * that must survive reloads and must not leak between two people on one
 * machine. The stored key is namespaced by user id with an anonymous fallback,
 * and `scopeToUser()` re-applies the signed-in user's saved choice once
 * identity is known (wired in AppShell, right next to the palette scoping).
 *
 * Unlike the palette there is no DOM stamp: consumers are React components
 * (AgentPresenceFace, the settings row, the per-tile cycle button) that
 * subscribe to the store, so a change re-renders the live call tiles without a
 * reload — which is the whole point of the per-tile control.
 */
import { create } from "zustand";
import {
  DEFAULT_FACE_STYLE,
  FACE_PREF_KEY,
  isFaceStyle,
  nextFaceStyle,
  type FaceStyle,
} from "@/lib/facePreference";

const anonKey = () => FACE_PREF_KEY;
const userKey = (userId: string) => `${FACE_PREF_KEY}::${userId}`;

function readKey(key: string): FaceStyle | null {
  try {
    const raw = localStorage.getItem(key);
    return isFaceStyle(raw) ? raw : null;
  } catch {
    return null; // private mode / storage disabled — fall back to the default.
  }
}

function writeKey(key: string, value: FaceStyle) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-fatal: the choice still applies for this session */
  }
}

interface FacePrefState {
  style: FaceStyle;
  /** User id the current value is scoped to; null while signed out. */
  scopedUserId: string | null;
  setStyle: (style: FaceStyle) => void;
  /** Per-tile control: advance the cycle and return the NEW style (for the
   *  transient "Face: …" label the tile flashes). */
  cycleStyle: () => FaceStyle;
  /** Bind the store to a signed-in user — same contract as the palette:
   *  load their saved style, or adopt the currently-showing one. */
  scopeToUser: (userId: string | null) => void;
}

export const useFacePrefStore = create<FacePrefState>((set, get) => ({
  style: readKey(anonKey()) ?? DEFAULT_FACE_STYLE,
  scopedUserId: null,

  setStyle: (style) => {
    if (!isFaceStyle(style)) return;
    const { scopedUserId } = get();
    if (scopedUserId) writeKey(userKey(scopedUserId), style);
    // Mirror to the unscoped key so a cold start before sign-in resolves shows
    // the same style (paint hint, exactly like the palette's anon mirror).
    writeKey(anonKey(), style);
    set({ style });
  },

  cycleStyle: () => {
    const next = nextFaceStyle(get().style);
    get().setStyle(next);
    return next;
  },

  scopeToUser: (userId) => {
    if (!userId) {
      set({ scopedUserId: null });
      return;
    }
    const saved = readKey(userKey(userId));
    const next = saved ?? get().style;
    if (!saved) writeKey(userKey(userId), next);
    writeKey(anonKey(), next);
    set({ style: next, scopedUserId: userId });
  },
}));

/**
 * Non-React read for imperative code paths. Components must subscribe via the
 * hook instead — this does not notify.
 */
export function currentFaceStyle(): FaceStyle {
  return useFacePrefStore.getState().style;
}
