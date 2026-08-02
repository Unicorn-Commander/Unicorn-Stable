/**
 * Mouth shaping — turning "how loud is this participant right now" into "how far
 * open is the jaw", and finding the morph to drive on an arbitrary rig.
 *
 * Phase 1 is a muppet mouth: one degree of freedom, driven from LiveKit's
 * `audioLevel`, with no agent-runtime involvement at all. Phase 2 replaces the
 * INPUT with a phoneme-timed viseme schedule off the data channel; the OUTPUT
 * half (alias resolution, clamping, smoothing) is the same code, which is why it
 * lives here rather than inside the renderer.
 *
 * All of it is pure, so the interesting parts are testable without a GPU.
 */

/**
 * Morph names we will accept for "open the jaw", best first.
 *
 * `jawOpen` is the ARKit name and what our own rigs will use. `aa`/`A` are the
 * VRM viseme presets (VRM 1.0 spec name / VRM 0.x name) — every VTuber rig on
 * earth has one of those two even when it has no ARKit shapes. `mouthOpen` is
 * the common hand-authored spelling.
 */
export const MOUTH_MORPH_ALIASES = [
  "jawOpen",
  "aa",
  "A",
  "mouthOpen",
  "vrc.v_aa",
] as const;

/**
 * Pick the morph to drive from the names a loaded rig actually exposes.
 *
 * Exact alias first (case-insensitively — exporters disagree about `A` vs `a`),
 * then a substring sweep for anything jaw/mouth-ish, which is what rescues a rig
 * whose author called it `Fcl_MTH_A` or `head_jaw_open`. Returns null when the
 * rig has no mouth at all; the caller then renders a still face rather than
 * pretending.
 */
export function resolveMouthMorph(
  available: readonly string[] | null | undefined,
): string | null {
  if (!available || available.length === 0) return null;
  for (const alias of MOUTH_MORPH_ALIASES) {
    const hit = available.find((n) => n.toLowerCase() === alias.toLowerCase());
    if (hit) return hit;
  }
  const fuzzy = available.find((n) => {
    const lower = n.toLowerCase();
    return lower.includes("jaw") || lower.includes("mouth");
  });
  return fuzzy ?? null;
}

/** Exponential smoothing toward `raw`. `alpha` 0..1; higher = snappier. */
export function smoothLevel(previous: number, raw: number, alpha = 0.25): number {
  const safeRaw = Number.isFinite(raw) ? raw : 0;
  const safePrev = Number.isFinite(previous) ? previous : 0;
  const a = Math.min(1, Math.max(0, alpha));
  return safePrev + (safeRaw - safePrev) * a;
}

/**
 * `audioLevel` (0..1, and in practice 0..~0.3 for speech) → jaw open (0..1).
 *
 * Three things this has to do that a bare pass-through does not:
 *
 *   * GAIN. LiveKit's level for normal speech sits around 0.05–0.2. Feeding
 *     that straight to a morph gives a mouth that twitches by a pixel — the
 *     "it's technically working" failure. NORMAL_SPEECH is the level that should
 *     read as a fully open mouth.
 *   * A NOISE FLOOR. Line noise and the tail of a word sit just above zero; a
 *     mouth that never fully closes reads as a gormless slack jaw.
 *   * A CURVE. Speech energy is roughly logarithmic, so a square root spends
 *     more of the morph's range on the quiet part where the consonants are.
 */
export const MOUTH_NOISE_FLOOR = 0.012;
export const MOUTH_NORMAL_SPEECH = 0.16;

export function mouthOpenFromLevel(level: number): number {
  if (!Number.isFinite(level) || level <= MOUTH_NOISE_FLOOR) return 0;
  const span = MOUTH_NORMAL_SPEECH - MOUTH_NOISE_FLOOR;
  const normalized = (level - MOUTH_NOISE_FLOOR) / span;
  const curved = Math.sqrt(Math.min(1, Math.max(0, normalized)));
  return Math.min(1, Math.max(0, curved));
}

/**
 * Idle life. A face frozen at exactly 0 reads as a crash, so the jaw breathes a
 * hair when nobody is talking. Amplitude is deliberately below what a viewer
 * consciously notices — it is there to prove the loop is alive.
 */
export function idleMouthOpen(elapsedMs: number): number {
  return 0.03 + 0.02 * Math.sin(elapsedMs / 900);
}

/** Blink envelope: 1 = eye fully shut. One blink per `periodMs`. */
export function blinkAmount(elapsedMs: number, periodMs = 4200): number {
  const phase = elapsedMs % periodMs;
  const CLOSE_MS = 130;
  if (phase > CLOSE_MS) return 0;
  return Math.sin((phase / CLOSE_MS) * Math.PI);
}
