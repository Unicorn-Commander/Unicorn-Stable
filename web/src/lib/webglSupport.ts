/**
 * Can this browser give us a WebGL context at all?
 *
 * Answered ONCE and cached. Probing costs a real context, and browsers cap how
 * many a document may hold (~16 in Chrome) — asking per tile would spend the
 * budget on the question instead of on the answer. The probe context is
 * explicitly released via WEBGL_lose_context so it is not still counted against
 * that cap while the actual face renderer is trying to get one.
 *
 * "false" here is a normal outcome, not an error: software-rendering blocklists,
 * a GPU process that has crashed, Lockdown Mode, and old Androids all land here,
 * and all of them must fall through to the 2D ladder rather than to a black box.
 */

let cached: boolean | null = null;

export function isWebglAvailable(): boolean {
  if (cached !== null) return cached;
  if (typeof document === "undefined") {
    cached = false;
    return cached;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ??
      canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) {
      cached = false;
      return cached;
    }
    const lose = gl.getExtension("WEBGL_lose_context");
    lose?.loseContext();
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

/** Tests only. */
export function __resetWebglSupportCache(): void {
  cached = null;
}
