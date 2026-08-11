/**
 * Face-style preference — WHAT KIND of face the user wants on agent call tiles.
 *
 * This module is the pure vocabulary: the four styles, their order, their
 * user-facing copy, and the cycle step the per-tile control uses. Persistence
 * and React wiring live in `stores/facePrefStore.ts` (same split as
 * lib/theme ↔ stores/themeStore); the selection consequences live in
 * `lib/presenceFace.ts` (`faceMountPlan`), so preference × availability ×
 * physics stays a total function that tests can enumerate.
 *
 * The preference is a STYLE request, never a physics override: WebGL support,
 * the stage-surface gate, MIN_FACE_BOX_PX and the agent-face context budget all
 * still apply, and an unavailable style falls down the existing ladder rather
 * than rendering a blank tile (see faceMountPlan for the exact fallbacks).
 *
 * v1 is ONE GLOBAL preference per user, deliberately: the field ask was "let me
 * choose which style I see", and a single switch answers it without inventing a
 * per-agent preference matrix. Per-agent overrides are the obvious v2 — the
 * store key is versioned (`stable.facePref.v1`) so that migration has a seam.
 */

export type FaceStyle = "auto" | "puppet" | "vrm" | "portrait";

/** Cycle order for the per-tile control — matches the settings row order. */
export const FACE_STYLE_ORDER: readonly FaceStyle[] = [
  "auto",
  "puppet",
  "vrm",
  "portrait",
];

export const DEFAULT_FACE_STYLE: FaceStyle = "auto";

/** localStorage key prefix. Per-user scoping appends `::<userId>`. */
export const FACE_PREF_KEY = "stable.facePref.v1";

export function isFaceStyle(value: unknown): value is FaceStyle {
  return (
    typeof value === "string" &&
    (FACE_STYLE_ORDER as readonly string[]).includes(value)
  );
}

/** auto → puppet → vrm → portrait → auto. Total: unknown input restarts at auto. */
export function nextFaceStyle(current: FaceStyle): FaceStyle {
  const idx = FACE_STYLE_ORDER.indexOf(current);
  const next = FACE_STYLE_ORDER[(idx + 1) % FACE_STYLE_ORDER.length];
  return next ?? DEFAULT_FACE_STYLE;
}

export interface FaceStyleMeta {
  /** Short name — settings radio label and the per-tile transient toast. */
  label: string;
  /** One line under the label in Settings → Appearance. */
  blurb: string;
}

/**
 * User-facing copy. "VRM" and "procedural" are internal words; users get
 * "2D puppet" / "3D model" / "Portrait", matching what the tile actually shows.
 */
export const FACE_STYLE_META: Record<FaceStyle, FaceStyleMeta> = {
  auto: {
    label: "Auto",
    blurb: "Best available — the branded 2D puppet when the agent has one.",
  },
  puppet: {
    label: "2D puppet",
    blurb: "The branded animated portrait. Falls back to a still picture.",
  },
  vrm: {
    label: "3D model",
    blurb: "A rigged 3D head when one exists; otherwise the 2D puppet.",
  },
  portrait: {
    label: "Portrait",
    blurb: "A still picture — no animation, lightest on the battery.",
  },
};
