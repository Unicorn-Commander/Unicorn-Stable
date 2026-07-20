import type { CallPopoutHandle, OpenCallPopoutOptions } from "./types";

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

/** Centered popup window features string. */
function popupFeatures(width: number, height: number): string {
  let left = 0;
  let top = 0;
  try {
    const dualLeft = window.screenLeft ?? window.screenX ?? 0;
    const dualTop = window.screenTop ?? window.screenY ?? 0;
    const ow =
      window.outerWidth || document.documentElement.clientWidth || width;
    const oh =
      window.outerHeight || document.documentElement.clientHeight || height;
    left = Math.max(0, Math.round(dualLeft + (ow - width) / 2));
    top = Math.max(0, Math.round(dualTop + (oh - height) / 2));
  } catch {
    /* screen geometry unavailable — open at the default position */
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
 * Open a themed pop-out window and return a handle. Returns null when
 * unsupported or the popup was blocked. Call synchronously from a user gesture.
 */
export function openCallPopout(
  opts?: OpenCallPopoutOptions,
): CallPopoutHandle | null {
  if (!isPopoutSupported()) return null;
  const {
    title = "Stable — call",
    width = 960,
    height = 600,
    onClose,
  } = opts ?? {};

  const win = window.open("about:blank", "_blank", popupFeatures(width, height));
  if (!win) return null; // popup blocked (or not a user gesture)

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

  const teardown = (): void => {
    if (closed) return;
    closed = true;
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
  const watchdog = window.setInterval(() => {
    if (win.closed) teardown();
  }, 500);

  return {
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
}
