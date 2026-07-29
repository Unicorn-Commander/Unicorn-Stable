import type {
  CallPopoutHandle,
  OpenCallPopoutOptions,
  OpenCallPopoutResult,
  PopoutGeometry,
} from "./types";

/**
 * callPopout — the imperative detached-window primitive.
 *
 * `openCallPopout()` opens a real second browser window (`window.open`), builds
 * a themed blank document in it, and returns a {@link CallPopoutHandle}. The
 * actual tiles are rendered into the window by {@link CallPopoutHost} (a React
 * portal), so their existing LiveKit attach refs run in the CHILD document and
 * `track.attach(childVideoEl)` re-homes the surface there — LiveKit's
 * `Track.attach(element)` accepts a media element from any document.
 *
 * This file is deliberately framework-light (no React) so the window lifecycle,
 * stylesheet cloning and theme mirroring are testable on their own.
 *
 * MUST be called synchronously from a user gesture — `window.open` returns null
 * when a popup is blocked, and that only reliably happens inside a real click.
 */

const POPOUT_ROOT_ID = "stable-popout-root";
/** Marks cloned <style>/<link> nodes so they can be re-synced wholesale. */
const CLONE_MARK = "data-stable-popout-clone";
/** Marks the persistent base <style> (never removed by a re-clone). */
const BASE_MARK = "data-stable-popout-base";

/**
 * Feature-detect the detached-window capability. This does NOT capture popup
 * blocking or mobile (where popups don't meaningfully exist) — gate the control
 * additionally on `useIsDesktop()` and treat a null return from
 * {@link openCallPopout} as "blocked", degrading to no button.
 */
export function isPopoutSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.open === "function" &&
    typeof document !== "undefined"
  );
}

/** Get (or lazily create) the portal mount node inside a pop-out document. */
export function getPopoutRoot(doc: Document): HTMLElement {
  let root = doc.getElementById(POPOUT_ROOT_ID);
  if (!root) {
    root = doc.createElement("div");
    root.id = POPOUT_ROOT_ID;
    doc.body.appendChild(root);
  }
  return root as HTMLElement;
}

/* ------------------------------------------------------------------ *
 * Window-POSITION persistence
 *
 * The user's monitor placement is worth keeping across reloads (that's the
 * whole point of a detached window on a multi-monitor desk).
 *
 * WE PERSIST POSITION ONLY, NEVER SIZE — and that is a correctness decision,
 * not a scope cut. `window.open`'s `width`/`height` features are CONTENT
 * dimensions, but the only size an opener can read back from a child window is
 * `outerWidth`/`outerHeight`, which INCLUDE the title bar and borders. Feeding
 * one into the other adds the chrome size on every single open/close cycle, so
 * the window grows without bound (a few dozen px taller each time). There is no
 * portable way to measure a child popup's chrome, so the only honest fix is not
 * to round-trip size at all. Size always comes from the caller's options.
 *
 * Position has no such unit mismatch: the `left`/`top` features and
 * `screenX`/`screenY` both address the window frame's top-left corner. Where a
 * browser does apply a small offset, {@link calibrate} MEASURES it once per
 * window (observed − requested) and cancels it out on save, so it cannot
 * accumulate either.
 *
 * Every restore is validated:
 *
 *   • the stored value must parse to two finite numbers,
 *   • within an absolute virtual-desktop bound (±20000px), and
 *   • within a generous envelope around the CURRENTLY attached screen
 *     ({@link isOnCurrentDesktop}) — this is what recovers a coordinate saved
 *     on a monitor that is no longer plugged in.
 *
 * The envelope is deliberately loose (several screens out in every direction,
 * including negative) because we can only see the OPENER's screen — the
 * Window Management API needs a permission prompt — and a tight "is it
 * visible?" test would wrongly yank legitimately-placed windows back from a
 * second monitor. It only rejects coordinates that no plausible arrangement of
 * the current display could contain.
 * ------------------------------------------------------------------ */

const GEOMETRY_KEY = "stable.call-popout-position.v2";

/**
 * Storage key for one window's position.
 *
 * MULTI-WINDOW: each pop-out gets its OWN slot, namespaced by a caller-supplied
 * `geometryKey` (the feed id — `cam:local`, `screen:PA_abc…`). Without this every
 * window would share one coordinate and a 4-monitor layout would collapse to a
 * single remembered spot. Passing no key keeps the ORIGINAL slot, so the
 * whole-stage pop-out's saved position survives this change.
 *
 * The key is sanitised: LiveKit identities are user-influenced strings and this
 * lands in localStorage, so anything outside a conservative charset is escaped
 * rather than concatenated raw.
 */
function geometryStorageKey(geometryKey?: string): string {
  if (!geometryKey) return GEOMETRY_KEY;
  const safe = geometryKey.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120);
  return `${GEOMETRY_KEY}.${safe}`;
}
/** Absolute virtual-desktop coordinate bound (multi-monitor, incl. negative). */
const MAX_COORD = 20000;
/** How many screen-widths/heights out from the current screen we still trust. */
const DESKTOP_SPAN_FACTOR = 3;
/**
 * Largest observed−requested offset we treat as this browser's chrome offset
 * rather than a relocation. Title bars are tens of px; a clamp onto a different
 * monitor moves the window by hundreds or thousands.
 */
const MAX_CALIBRATION_OFFSET = 400;
/** Below this, a presented window is junk rather than merely small. */
const MIN_PRESENTED_DIM = 100;

function isPlausibleGeometry(value: unknown): value is PopoutGeometry {
  if (!value || typeof value !== "object") return false;
  const { left, top } = value as Record<string, unknown>;
  if (
    ![left, top].every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return false;
  }
  if (Math.abs(left as number) > MAX_COORD) return false;
  if (Math.abs(top as number) > MAX_COORD) return false;
  return true;
}

/**
 * Could this coordinate belong to the display setup we can see RIGHT NOW?
 *
 * Answers the "saved on a monitor that is no longer attached" case. We measure
 * a box {@link DESKTOP_SPAN_FACTOR} screens out from the current screen in
 * every direction; anything outside it cannot be reached by any realistic
 * arrangement of this display and is treated as stale.
 */
function isOnCurrentDesktop(geom: PopoutGeometry): boolean {
  try {
    const scr = typeof window !== "undefined" ? window.screen : undefined;
    const w = scr?.width;
    const h = scr?.height;
    // No screen metrics (SSR / exotic embed) — do not reject on ignorance.
    if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return true;
    const spanX = w * DESKTOP_SPAN_FACTOR;
    const spanY = h * DESKTOP_SPAN_FACTOR;
    return (
      geom.left >= -spanX &&
      geom.left <= spanX &&
      geom.top >= -spanY &&
      geom.top <= spanY
    );
  } catch {
    return true;
  }
}

/**
 * The last validated pop-out position, or null when absent/invalid/stale.
 *
 * Self-healing: a stored value that fails validation is DELETED here rather
 * than merely ignored, so a coordinate stranded on a detached monitor cannot
 * sit in localStorage forever waiting for a re-plug that never comes. This is
 * one of {@link clearPopoutGeometry}'s live call sites.
 */
export function readPopoutGeometry(geometryKey?: string): PopoutGeometry | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(geometryStorageKey(geometryKey));
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearPopoutGeometry(geometryKey);
    return null;
  }
  if (!isPlausibleGeometry(parsed)) {
    clearPopoutGeometry(geometryKey);
    return null;
  }
  if (!isOnCurrentDesktop(parsed)) {
    // Saved against a display that is not attached any more — forget it and
    // centre on the screen we can actually see.
    clearPopoutGeometry(geometryKey);
    return null;
  }
  // Normalise to exactly {left, top}. A payload written by an older build also
  // carried width/height; returning it verbatim would let a stale SIZE leak
  // back into a caller, which is the whole bug this module now refuses to have.
  return { left: parsed.left, top: parsed.top };
}

/** Forget the stored placement (next open centers again). */
export function clearPopoutGeometry(geometryKey?: string): void {
  try {
    localStorage.removeItem(geometryStorageKey(geometryKey));
  } catch {
    /* private mode / quota */
  }
}

function savePopoutGeometry(geom: PopoutGeometry, geometryKey?: string): void {
  if (!isPlausibleGeometry(geom)) return;
  try {
    // Write exactly {left, top} — never let a size field into the payload.
    localStorage.setItem(
      geometryStorageKey(geometryKey),
      JSON.stringify({ left: geom.left, top: geom.top }),
    );
  } catch {
    /* private mode / quota — placement is a nicety, never a hard failure */
  }
}

/**
 * Read a live window's on-screen POSITION, or null when the window is not
 * (yet) presented.
 *
 * A freshly-opened `about:blank` popup routinely reports `outerWidth`/
 * `outerHeight` of 0 before the OS has actually put it on screen, and its
 * `screenX`/`screenY` are meaningless until then. Requiring non-zero outer
 * dimensions is how we tell "not presented yet" from "really at 0,0" — the
 * dimensions are used ONLY as this liveness signal and are never persisted.
 */
function readWindowGeometry(win: Window): PopoutGeometry | null {
  try {
    if (win.closed) return null;
    if (!(win.outerWidth > 0) || !(win.outerHeight > 0)) return null;
    const geom: PopoutGeometry = {
      left: Math.round(win.screenX ?? win.screenLeft ?? 0),
      top: Math.round(win.screenY ?? win.screenTop ?? 0),
    };
    return isPlausibleGeometry(geom) ? geom : null;
  } catch {
    // Cross-window access can throw once the window is gone.
    return null;
  }
}

/**
 * Run `onPresented` once the child window is genuinely on screen.
 *
 * This exists because the previous implementation self-healed inside the
 * child's FIRST `requestAnimationFrame`, where `outerWidth`/`outerHeight` are
 * still commonly 0 — so the geometry read failed, the "degenerate" branch fired
 * on every single open, and it WIPED the stored placement. Position persistence
 * silently degraded to a permanent no-op.
 *
 * So: poll until the window reports stable non-zero outer dimensions twice in a
 * row (one sample can catch a transient 1×1 frame mid-presentation). If the
 * budget expires without that ever happening, we do NOTHING — an unreadable
 * window is INCONCLUSIVE, never evidence that the stored placement is bad.
 * Returns a cancel function; teardown must call it.
 */
function whenPresented(win: Window, onPresented: () => void): () => void {
  const POLL_MS = 50;
  const DEADLINE_MS = 4000;
  const started = Date.now();
  let timer = 0;
  let cancelled = false;
  let lastW = -1;
  let lastH = -1;

  const tick = (): void => {
    if (cancelled) return;
    let w = 0;
    let h = 0;
    try {
      if (win.closed) return;
      w = win.outerWidth || 0;
      h = win.outerHeight || 0;
    } catch {
      return; // window gone — inconclusive, leave storage alone
    }
    // Two consecutive identical non-zero samples ⇒ actually presented.
    if (w > 0 && h > 0 && w === lastW && h === lastH) {
      onPresented();
      return;
    }
    lastW = w;
    lastH = h;
    if (Date.now() - started >= DEADLINE_MS) return; // give up silently
    timer = window.setTimeout(tick, POLL_MS);
  };

  timer = window.setTimeout(tick, POLL_MS);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

/**
 * Cascade step for the Nth simultaneously-open window that has no SAVED
 * position yet. Without it, popping out four feeds for the first time centres
 * all four on the identical pixel and looks like only one opened.
 *
 * This offsets a DEFAULT only — it is never derived from, nor fed back into,
 * persisted geometry, so it cannot accumulate the way the old size round-trip
 * did. Once a window has a saved position, the saved value wins outright.
 */
const CASCADE_STEP_PX = 36;
/** Wrap the cascade so a 10th window doesn't march off the bottom-right. */
const CASCADE_WRAP = 6;

/** Centre a `width`×`height` window on the opener's screen. */
function centeredPosition(width: number, height: number): { left: number; top: number } {
  try {
    const dualLeft = window.screenLeft ?? window.screenX ?? 0;
    const dualTop = window.screenTop ?? window.screenY ?? 0;
    const ow =
      window.outerWidth || document.documentElement.clientWidth || width;
    const oh =
      window.outerHeight || document.documentElement.clientHeight || height;
    return {
      left: Math.max(0, Math.round(dualLeft + (ow - width) / 2)),
      top: Math.max(0, Math.round(dualTop + (oh - height) / 2)),
    };
  } catch {
    /* screen geometry unavailable — open at the default position */
    return { left: 0, top: 0 };
  }
}

/**
 * Popup window features string for an already-decided position. `width`/
 * `height` are CONTENT dimensions and always come from the caller's options —
 * they are never restored from storage (see the persistence note above).
 */
function popupFeatures(
  width: number,
  height: number,
  left: number,
  top: number,
): string {
  return [
    "popup=1",
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    "menubar=no",
    "toolbar=no",
    "location=no",
    "status=no",
    "resizable=yes",
    "scrollbars=yes",
  ].join(",");
}


/**
 * Clone every <style> and <link rel="stylesheet"> from the opener's <head> into
 * the child's <head>. Removes prior clones first (whole-sale re-sync). Both
 * removal and re-add happen in one synchronous pass, so no unstyled flash.
 */
function cloneStyles(src: Document, dst: Document): void {
  dst.head.querySelectorAll(`[${CLONE_MARK}]`).forEach((n) => n.remove());
  const nodes = src.head.querySelectorAll<HTMLElement>(
    'style, link[rel="stylesheet"]',
  );
  nodes.forEach((node) => {
    const clone = node.cloneNode(true) as HTMLElement;
    clone.setAttribute(CLONE_MARK, "");
    dst.head.appendChild(clone);
  });
}

/** Mirror the opener's root theme state (`data-theme`, class, color-scheme). */
function mirrorTheme(src: Document, dst: Document): void {
  const s = src.documentElement;
  const d = dst.documentElement;
  const theme = s.getAttribute("data-theme");
  if (theme) d.setAttribute("data-theme", theme);
  else d.removeAttribute("data-theme");
  if (d.className !== s.className) d.className = s.className;
  d.style.colorScheme = theme === "light" ? "light" : "dark";
  d.lang = s.lang || "en";
}

/** Mirror the opener's <body> class (reset + base look). */
function mirrorBody(src: Document, dst: Document): void {
  if (dst.body && dst.body.className !== src.body.className) {
    dst.body.className = src.body.className;
  }
}

/**
 * Open a themed pop-out window and report WHY it failed when it did.
 *
 * A popup blocker is the common failure and it is silent at the browser level —
 * `window.open` just returns null. Callers must surface `failure === "blocked"`
 * to the user (see {@link useCallPopout}, which turns it into a visible,
 * actionable banner) rather than degrading to nothing.
 *
 * Call synchronously from a user gesture.
 */
export function openCallPopoutWithResult(
  opts?: OpenCallPopoutOptions,
): OpenCallPopoutResult {
  if (!isPopoutSupported()) return { handle: null, failure: "unsupported" };
  const {
    title = "Stable — call",
    width = 960,
    height = 600,
    geometryKey,
    cascadeIndex = 0,
    onClose,
  } = opts ?? {};

  // Size ALWAYS comes from the options — never from storage. Only the position
  // is restored, and only after validating it against the current display.
  // MULTI-WINDOW: the slot is namespaced per feed (see `geometryStorageKey`), so
  // each pop-out remembers its OWN monitor placement.
  const saved = readPopoutGeometry(geometryKey);
  let requested: { left: number; top: number };
  if (saved) {
    requested = saved;
  } else {
    const c = centeredPosition(width, height);
    const step = (Math.max(0, cascadeIndex) % CASCADE_WRAP) * CASCADE_STEP_PX;
    requested = { left: c.left + step, top: c.top + step };
  }

  const win = window.open(
    "about:blank",
    "_blank",
    popupFeatures(width, height, requested.left, requested.top),
  );
  // Popup blocked (or not called from a user gesture) — the ONLY signal the
  // browser gives us. Never swallow this.
  if (!win) return { handle: null, failure: "blocked" };

  const doc = win.document;
  doc.title = title;

  // --- scaffold the blank document ---
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const viewport = doc.createElement("meta");
  viewport.setAttribute("name", "viewport");
  viewport.setAttribute(
    "content",
    "width=device-width, initial-scale=1.0, viewport-fit=cover",
  );
  doc.head.appendChild(charset);
  doc.head.appendChild(viewport);

  // Persistent base layout so the portal root fills the window. Tagged with a
  // DIFFERENT marker than the clones so a stylesheet re-sync never removes it.
  //
  // CHROME BAR: a native (non-React) top strip with Close. When a shared
  // desktop freezes or LiveKit reconnect stalls, React portal updates can lag
  // or the hover-only tile controls become unreachable under a frozen frame.
  // This chrome is plain DOM + a click handler wired at open time, so Close
  // still works even when the portalled React tree is stuck. z-index is maxed
  // so a reconnecting banner cloned into styles cannot cover it.
  const CHROME_ID = "stable-popout-chrome";
  const base = doc.createElement("style");
  base.setAttribute(BASE_MARK, "");
  base.textContent =
    `html,body{height:100%;margin:0;padding:0;display:flex;flex-direction:column;}` +
    `#${CHROME_ID}{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;` +
    `gap:8px;padding:6px 10px;font:600 12px/1.2 system-ui,sans-serif;` +
    `color:#e2e8f0;background:rgba(15,23,42,0.92);border-bottom:1px solid rgba(148,163,184,0.25);` +
    `backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);` +
    `position:relative;z-index:2147483647;user-select:none;}` +
    `#${CHROME_ID} button{appearance:none;border:0;cursor:pointer;border-radius:8px;` +
    `padding:6px 10px;font:600 12px/1 system-ui,sans-serif;color:#f8fafc;` +
    `background:rgba(168,85,247,0.35);}` +
    `#${CHROME_ID} button:hover{background:rgba(168,85,247,0.55);}` +
    `#${CHROME_ID} button[data-kind="close"]{background:rgba(244,63,94,0.35);}` +
    `#${CHROME_ID} button[data-kind="close"]:hover{background:rgba(244,63,94,0.55);}` +
    `#${CHROME_ID} .stable-popout-chrome-title{opacity:0.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}` +
    `#${POPOUT_ROOT_ID}{flex:1 1 auto;min-height:0;display:flex;` +
    `flex-direction:column;overflow:hidden;}`;
  doc.head.appendChild(base);

  mirrorTheme(document, doc);
  cloneStyles(document, doc);
  mirrorBody(document, doc);

  // Native chrome BEFORE the portal root so it's never covered by portalled tiles.
  const chrome = doc.createElement("div");
  chrome.id = CHROME_ID;
  chrome.setAttribute("role", "toolbar");
  chrome.setAttribute("aria-label", "Pop-out window controls");
  const titleEl = doc.createElement("span");
  titleEl.className = "stable-popout-chrome-title";
  titleEl.textContent = title;
  const actions = doc.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "6px";
  actions.style.flexShrink = "0";
  const focusBtn = doc.createElement("button");
  focusBtn.type = "button";
  focusBtn.textContent = "Focus main";
  focusBtn.title = "Bring the main Stable tab to the front";
  focusBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      window.focus();
    } catch {
      /* ignore */
    }
  });
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.setAttribute("data-kind", "close");
  closeBtn.textContent = "Close";
  closeBtn.title = "Close this pop-out and return the video to the main window";
  // Wired after teardown is defined — placeholder; reassigned below.
  let closeChrome = (): void => {
    try {
      if (!win.closed) win.close();
    } catch {
      /* ignore */
    }
  };
  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeChrome();
  });
  actions.appendChild(focusBtn);
  actions.appendChild(closeBtn);
  chrome.appendChild(titleEl);
  chrome.appendChild(actions);
  doc.body.appendChild(chrome);

  getPopoutRoot(doc);

  // --- lifecycle wiring ---
  let closed = false;
  let resyncScheduled = false;

  // Re-mirror theme when the opener flips `data-theme`/class on <html> or <body>.
  const themeObserver = new MutationObserver(() => {
    if (closed) return;
    mirrorTheme(document, doc);
    mirrorBody(document, doc);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style", "lang"],
  });
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });

  // Re-clone stylesheets when the opener's <head> changes (Vite HMR injects
  // <style> tags at runtime). Production CSS is static → this never fires.
  const headObserver = new MutationObserver(() => {
    if (closed || resyncScheduled) return;
    resyncScheduled = true;
    const run = () => {
      resyncScheduled = false;
      if (!closed) cloneStyles(document, doc);
    };
    if (typeof win.requestAnimationFrame === "function") {
      win.requestAnimationFrame(run);
    } else {
      win.setTimeout(run, 16);
    }
  });
  headObserver.observe(document.head, { childList: true });

  // Last position we saw while the window was alive. Sampled by the watchdog
  // (so a close via the OS chrome still leaves us a good value — by the time we
  // learn the window is gone its geometry is unreadable) and persisted on
  // teardown.
  let lastGeometry: PopoutGeometry | null = null;
  /**
   * This browser's (observed − requested) placement offset, measured once the
   * window is actually presented. Subtracted on save so a browser that offsets
   * `left`/`top` by the chrome does not walk the window across the screen a
   * little further on every open/close cycle. `null` until measured — and while
   * it is null we do NOT persist a position, because we cannot yet tell a real
   * coordinate from an offset one.
   */
  let calibration: { dx: number; dy: number } | null = null;

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    cancelPresentationWatch();
    // Persist the freshest position: read live first (a `.close()` from our own
    // UI still has the window), else fall back to the last watchdog sample.
    // Only ever with a measured calibration — see `calibration`.
    const geom = readWindowGeometry(win) ?? lastGeometry;
    if (geom && calibration) {
      savePopoutGeometry(
        {
          left: geom.left - calibration.dx,
          top: geom.top - calibration.dy,
        },
        geometryKey,
      );
    }
    window.clearInterval(watchdog);
    themeObserver.disconnect();
    headObserver.disconnect();
    window.removeEventListener("pagehide", onOpenerHide);
    try {
      win.removeEventListener("pagehide", teardown);
      win.removeEventListener("beforeunload", teardown);
    } catch {
      /* cross-window access can throw once the window is gone */
    }
    try {
      if (!win.closed) win.close();
    } catch {
      /* already gone */
    }
    try {
      onClose?.();
    } catch (e) {
      console.error("openCallPopout onClose threw", e);
    }
  };

  // Chrome Close runs the same teardown path as handle.close() so React state
  // (feed registry / stage pop-out) always clears — not just win.close(), which
  // on some browsers fails to fire pagehide promptly when the content is frozen.
  closeChrome = () => teardown();

  // Opener navigating/closing must not orphan the pop-out. Use `pagehide` only
  // on the opener (fires on tab-close/navigate/bfcache) — a `beforeunload`
  // listener here would disable the MAIN app's back/forward cache. The child is
  // disposable, so it keeps both events plus the watchdog for max reliability.
  const onOpenerHide = (): void => teardown();

  win.addEventListener("pagehide", teardown);
  win.addEventListener("beforeunload", teardown);
  window.addEventListener("pagehide", onOpenerHide);

  // Backstop: not every browser fires unload when a popup is closed via its OS
  // chrome, so poll `win.closed` to guarantee teardown (→ onClose → React
  // unmount → track detach) always runs.
  // Also doubles as the geometry sampler — see `lastGeometry`.
  const watchdog = window.setInterval(() => {
    if (win.closed) {
      teardown();
      return;
    }
    const geom = readWindowGeometry(win);
    if (geom) lastGeometry = geom;
  }, 500);

  /**
   * Once the window is GENUINELY presented (not merely one frame old — see
   * {@link whenPresented}), do two things:
   *
   *   1. Measure this browser's placement offset so saves round-trip exactly.
   *   2. Self-heal the two failure modes we can actually detect — a window the
   *      browser relocated wholesale (the restored coordinate was unusable,
   *      e.g. a monitor that is no longer attached) and a degenerate frame.
   *      Both drop the stored placement so the next open starts clean; these
   *      are {@link clearPopoutGeometry}'s other live call sites.
   *
   * Anything we cannot read stays untouched: an inconclusive measurement must
   * never delete a placement that may be perfectly good.
   */
  const cancelPresentationWatch = whenPresented(win, () => {
    if (closed) return;
    const observed = readWindowGeometry(win);
    if (!observed) return; // inconclusive — leave storage alone

    let degenerate = false;
    try {
      degenerate =
        win.outerWidth < MIN_PRESENTED_DIM || win.outerHeight < MIN_PRESENTED_DIM;
    } catch {
      return;
    }

    const dx = observed.left - requested.left;
    const dy = observed.top - requested.top;
    const relocated =
      Math.abs(dx) > MAX_CALIBRATION_OFFSET ||
      Math.abs(dy) > MAX_CALIBRATION_OFFSET;

    if (relocated || degenerate) {
      // The requested placement did not survive: forget it, and treat the
      // window's actual position as truth from here on (offset 0), so the next
      // cycle calibrates cleanly against a coordinate that does work.
      clearPopoutGeometry(geometryKey);
      calibration = { dx: 0, dy: 0 };
    } else {
      calibration = { dx, dy };
    }

    if (degenerate) {
      try {
        if (win.closed) return;
        const c = centeredPosition(width, height);
        win.resizeTo(width, height);
        win.moveTo(c.left, c.top);
      } catch {
        /* the browser may refuse move/resize — the window is still usable */
      }
    }
  });

  const handle: CallPopoutHandle = {
    get window() {
      return closed || win.closed ? null : win;
    },
    get isOpen() {
      return !closed && !win.closed;
    },
    focus() {
      if (!closed && !win.closed) {
        try {
          win.focus();
        } catch {
          /* ignore */
        }
      }
    },
    close() {
      teardown();
    },
  };

  return { handle, failure: null };
}

/**
 * Open a themed pop-out window and return a handle, or null when unsupported or
 * blocked. Thin wrapper over {@link openCallPopoutWithResult} for callers that
 * do not need to distinguish the two failures — prefer the result form so a
 * blocked popup can be SURFACED instead of silently doing nothing.
 */
export function openCallPopout(
  opts?: OpenCallPopoutOptions,
): CallPopoutHandle | null {
  return openCallPopoutWithResult(opts).handle;
}
