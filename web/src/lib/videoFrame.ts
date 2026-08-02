/**
 * "Is there a picture in this video?" — asked of the pixels, not of the API.
 *
 * `videoWidth > 0 && readyState >= 2` only tells you frames are ARRIVING. On
 * dogfood the agent worker's always-on face track satisfies all of that and
 * every frame is one flat colour: measured 640x360, readyState 4, and at a
 * 32x18 sample luma min 17.3 / max 17.3 / spread 0.0. A tile that trusts the
 * API renders a black rectangle and calls it a video.
 *
 * Pure and separate from the component so the thresholds are testable against
 * the numbers actually measured, rather than against a guess.
 */

/** Rec.601 luma, the cheap one. Precision is irrelevant here; we want structure. */
function luma(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

export interface FrameStats {
  min: number;
  max: number;
  mean: number;
  /** max - min. Zero means every sampled pixel is identical. */
  spread: number;
}

/** Luma statistics over RGBA bytes (as returned by `getImageData().data`). */
export function frameLumaStats(data: ArrayLike<number>): FrameStats {
  const pixels = Math.floor(data.length / 4);
  if (pixels === 0) return { min: 0, max: 0, mean: 0, spread: 0 };
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    const l = luma(data[i]!, data[i + 1]!, data[i + 2]!);
    if (l < min) min = l;
    if (l > max) max = l;
    sum += l;
  }
  return { min, max, mean: sum / pixels, spread: max - min };
}

/**
 * Minimum luma range for a frame to count as showing something. A real camera
 * feed — even of a dim room, even of a blank wall with a shadow on it — clears
 * this trivially. A synthesised flat frame scores exactly 0.
 */
export const MIN_PICTURE_SPREAD = 4;

/**
 * ...or a frame bright enough that it is plausibly a real, genuinely flat
 * subject (a lit wall, a whiteboard). Without this a legitimate feed pointed at
 * something uniform and bright would be judged empty.
 */
export const MIN_PICTURE_MEAN = 40;

export function frameHasPicture(stats: FrameStats): boolean {
  return stats.spread >= MIN_PICTURE_SPREAD || stats.mean >= MIN_PICTURE_MEAN;
}
