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
 * Window-position persistence
 *
 * The user's monitor placement is worth keeping across reloads (that's the
 * whole point of a detached window on a multi-monitor desk), but SCREEN
 * coordinates are only meaningful while the monitor that hosted them is still
 * attached. So every restore is validated:
 *
 *   • the stored value must parse to four finite numbers,
 *   • the size must be sane (240..10000px — a 0×0 or 40000px window is junk),
 *   • the position must be within a generous virtual-desktop bound
 *     (±20000px, which covers any realistic multi-monitor arrangement).
 *
 * Anything else falls back to centering on the opener's screen. We deliberately
 * do NOT try to prove the coordinate lands on a live monitor — we can only see
 * the opener's screen (the Window Management API needs a permission prompt), so
 * a "is it visible?" test would wrongly yank legitimately-placed windows back
 * from a second monitor. Browsers already clamp popup coordinates onto an
 * existing screen; {@link healDegenerateGeometry} covers the residual case
 * where the result comes back degenerate.
 * ------------------------------------------------------------------ */

const GEOMETRY_KEY = "stable.call-popout-geometry.v1";
/** Sane content-size bounds for a restored window. */
const MIN_DIM = 240;
const MAX_DIM = 10000;
/** Generous virtual-desktop coordinate bound (multi-monitor, incl. negative). */
const MAX_COORD = 20000;

function isPlausibleGeometry(value: unknown): value is PopoutGeometry {
  if (!value || typeof value !== "object") return false;
  const { left, top, width, height } = value as Record<string, unknown>;
  if (
    ![left, top, width, height].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    )
  ) {
    return false;
  }
  const w = width as number;
  const h = height as number;
  if (w < MIN_DIM || w > MAX_DIM || h < MIN_DIM || h > MAX_DIM) return false;
  if (Math.abs(left as number) > MAX_COORD) return false;
  if (Math.abs(top as number) > MAX_COORD) return false;
  return true;
}

/** The last validated pop-out geometry, or null when absent/invalid. */
export function readPopoutGeometry(): PopoutGeometry | null {
  try {
    const raw = localStorage.getItem(GEOMETRY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPlausibleGeometry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Forget the stored placement (next open centers again). */
export function clearPopoutGeometry(): void {
  try {
    localStorage.removeItem(GEOMETRY_KEY);
  } catch {
    /* private mode / quota */
  }
}

function savePopoutGeometry(geom: PopoutGeometry): void {
  if (!isPlausibleGeometry(geom)) return;
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(geom));
  } catch {
    /* private mode / quota — placement is a nicety, never a hard failure */
  }
}

/** Read a live window's on-screen rect, or null when it reads back as junk. */
function readWindowGeometry(win: Window): PopoutGeometry | null {
  try {
    const geom: PopoutGeometry = {
      left: Math.round(win.screenX ?? win.screenLeft ?? 0),
      top: Math.round(win.screenY ?? win.screenTop ?? 0),
      width: Math.round(win.outerWidth || 0),
      height: Math.round(win.outerHeight || 0),
    };
    return isPlausibleGeometry(geom) ? geom : null;
  } catch {
    // Cross-window access can throw once the window is gone.
    return null;
  }
}

/**
 * Post-open self-heal: if the window came back DEGENERATE (unreadable or a junk
 * rect — e.g. the restored coordinates belonged to a monitor that is no longer
 * attached and the browser did not clamp), recentre + resize it on the opener's
 * screen and drop the stored placement so the next open starts clean.
 *
 * Only degeneracy triggers this. A window that legitimately landed on another
 * monitor reads back as a perfectly plausible rect and is left alone.
 */
function healDegenerateGeometry(win: Window, width: number, height: number): void {
  if (readWindowGeometry(win)) return;
  clearPopoutGeometry();
  try {
    if (win.closed) return;
    const { left, top } = centeredPosition(width, height);
    win.resizeTo(width, height);
    win.moveTo(left, top);
  } catch {
    /* the browser may refuse move/resize — the window is still usable */
  }
}

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
 * Popup window features string. Restores `saved` placement when it passed
 * validation; otherwise centres on the opener's screen.
 */
function popupFeatures(
  width: number,
  height: number,
  saved: PopoutGeometry | null,
): string {
  let left = 0;
  let top = 0;
  if (saved) {
    left = saved.left;
    top = saved.top;
  } else {
    const c = centeredPosition(width, height);
    left = c.left;
    top = c.top;
  }
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
  const saved = readPopoutGeometry();
  const {
    title = "Stable — call",
    width = saved?.width ?? 960,
    height = saved?.height ?? 600,
    onClose,
  } = opts ?? {};

  const win = window.open(
    "about:blank",
    "_blank",
    popupFeatures(width, height, saved),
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
  const base = doc.createElement("style");
  base.setAttribute(BASE_MARK, "");
  base.textContent =
    `html,body{height:100%;margin:0;padding:0;}` +
    `#${POPOUT_ROOT_ID}{height:100%;min-height:100vh;display:flex;` +
    `flex-direction:column;overflow:hidden;}`;
  doc.head.appendChild(base);

  mirrorTheme(document, doc);
  cloneStyles(document, doc);
  mirrorBody(document, doc);
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

  // Last rect we saw while the window was alive. Sampled by the watchdog (so a
  // close via the OS chrome still leaves us a good value — by the time we learn
  // the window is gone its geometry is unreadable) and persisted on teardown.
  let lastGeometry: PopoutGeometry | null = null;

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    // Persist the freshest rect: read live first (a `.close()` from our own UI
    // still has the window), else fall back to the last watchdog sample.
    const geom = readWindowGeometry(win) ?? lastGeometry;
    if (geom) savePopoutGeometry(geom);
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

  // Self-heal a degenerate window (restored coords from a detached monitor that
  // the browser did not clamp). Deferred one frame so the browser has applied
  // the requested placement before we read it back.
  if (typeof win.requestAnimationFrame === "function") {
    win.requestAnimationFrame(() => {
      if (!closed) healDegenerateGeometry(win, width, height);
    });
  } else {
    win.setTimeout(() => {
      if (!closed) healDegenerateGeometry(win, width, height);
    }, 32);
  }

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
