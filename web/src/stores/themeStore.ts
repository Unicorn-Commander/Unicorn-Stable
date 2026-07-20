/**
 * Palette store — the SECOND theme axis.
 *
 * `lib/theme.ts` owns light/dark (`data-theme`). This owns *which palette*
 * (`data-palette`). They are orthogonal on purpose: every palette ships a light
 * and a dark form, so "Ember + light" and "Ember + dark" are both real. See the
 * PALETTES block in styles/globals.css for the specificity contract.
 *
 * Persistence is per user. Two people on one machine (or one person on a shared
 * box) should not inherit each other's palette, so the stored key is namespaced
 * by user id, with an anonymous key used before sign-in. `scopeToUser()` is
 * called once identity is known and re-applies that user's saved choice.
 */
import { create } from "zustand";

export type PaletteId = "aurora" | "prism" | "ember" | "grove" | "beacon";

export interface PaletteMeta {
  id: PaletteId;
  name: string;
  /** One line, shown under the name in the picker. */
  blurb: string;
  /**
   * Representative swatches for the picker chip, dark form then light form.
   * These are literals rather than var() reads because the picker renders every
   * palette's preview simultaneously — only one palette's vars are live at a
   * time, so a var() would make all five previews look identical.
   */
  preview: { dark: string[]; light: string[] };
}

export const PALETTES: PaletteMeta[] = [
  {
    id: "aurora",
    name: "Aurora",
    blurb: "The original. Violet and cyan over deep indigo.",
    preview: {
      dark: ["#0a0a13", "#8b5cf6", "#22d3ee", "#34d399", "#fbbf24"],
      light: ["#ffffff", "#7c3aed", "#0891b2", "#059669", "#d97706"],
    },
  },
  {
    id: "prism",
    name: "Prism",
    blurb: "Every section its own hue. The most colour separation.",
    preview: {
      dark: ["#0b0d12", "#818cf8", "#22d3ee", "#34d399", "#f472b6"],
      light: ["#ffffff", "#4f46e5", "#0e7490", "#047857", "#db2777"],
    },
  },
  {
    id: "ember",
    name: "Ember",
    blurb: "Warm amber and rust, with one cool rail for contrast.",
    preview: {
      dark: ["#100b0a", "#f97316", "#38bdf8", "#4ade80", "#fbbf24"],
      light: ["#fffdfb", "#c2410c", "#0369a1", "#047857", "#b45309"],
    },
  },
  {
    id: "grove",
    name: "Grove",
    blurb: "Green and teal. Low glare for long sessions.",
    preview: {
      dark: ["#080f0c", "#10b981", "#2dd4bf", "#a3e635", "#fbbf24"],
      light: ["#fbfefc", "#047857", "#0f766e", "#4d7c0f", "#b45309"],
    },
  },
  {
    id: "beacon",
    name: "Beacon",
    blurb: "Maximum contrast, no decorative wash. Built for legibility.",
    preview: {
      dark: ["#000000", "#b39dff", "#5ee7ff", "#6ee7b7", "#fcd34d"],
      light: ["#ffffff", "#5b21b6", "#155e75", "#065f46", "#854d0e"],
    },
  },
];

export const DEFAULT_PALETTE: PaletteId = "aurora";

const VALID = new Set<string>(PALETTES.map((p) => p.id));

const KEY_PREFIX = "stable.palette.v1";
const anonKey = () => KEY_PREFIX;
const userKey = (userId: string) => `${KEY_PREFIX}::${userId}`;

function readKey(key: string): PaletteId | null {
  try {
    const raw = localStorage.getItem(key);
    return raw && VALID.has(raw) ? (raw as PaletteId) : null;
  } catch {
    return null; // private mode / storage disabled — fall back to the default.
  }
}

function writeKey(key: string, value: PaletteId) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-fatal: the palette still applies for this session */
  }
}

/** Stamp the DOM. The CSS keys entirely off this attribute. */
function stamp(palette: PaletteId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.palette = palette;
}

interface ThemeState {
  palette: PaletteId;
  /** User id the current value is scoped to; null while signed out. */
  scopedUserId: string | null;
  setPalette: (p: PaletteId) => void;
  /**
   * Bind the store to a signed-in user: loads that user's saved palette, or —
   * if they have none yet — adopts whatever is currently showing (so a choice
   * made on the sign-in screen carries into the session rather than snapping
   * back to the default).
   */
  scopeToUser: (userId: string | null) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  palette: readKey(anonKey()) ?? DEFAULT_PALETTE,
  scopedUserId: null,

  setPalette: (p) => {
    if (!VALID.has(p)) return;
    const { scopedUserId } = get();
    if (scopedUserId) writeKey(userKey(scopedUserId), p);
    // Always mirror to the unscoped key. That key is what index.html's
    // pre-paint script reads, and it cannot know who is signed in — so without
    // this mirror, every reload after a palette change repaints in the default
    // palette for a frame before AppShell re-scopes. The per-user key above
    // stays authoritative; this one is only a paint hint.
    writeKey(anonKey(), p);
    stamp(p);
    set({ palette: p });
  },

  scopeToUser: (userId) => {
    if (!userId) {
      set({ scopedUserId: null });
      return;
    }
    const saved = readKey(userKey(userId));
    const next = saved ?? get().palette;
    if (!saved) writeKey(userKey(userId), next);
    // Same paint hint as setPalette — so the next cold start opens on this
    // user's palette rather than the default.
    writeKey(anonKey(), next);
    stamp(next);
    set({ palette: next, scopedUserId: userId });
  },
}));

/**
 * Apply the stored palette at runtime. Called explicitly from main.tsx, not as
 * a module side effect — a side effect only runs if something imports the
 * module, and this store had no importers at all for a while, which meant
 * data-palette was never stamped and none of the palettes could apply.
 *
 * index.html stamps the same value before first paint so there is no flash;
 * this is the runtime re-apply, and scopeToUser() supersedes it once the
 * signed-in user is known.
 */
export function initPalette(): PaletteId {
  const p = readKey(anonKey()) ?? DEFAULT_PALETTE;
  stamp(p);
  return p;
}
