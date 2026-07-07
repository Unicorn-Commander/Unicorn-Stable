/**
 * Theme control — light / dark / system.
 *
 * The whole visual system flips by re-declaring the design tokens under
 * `:root[data-theme="light"]` in globals.css. This module is the single source
 * of truth for *which* theme is active: it reads/writes the stored preference,
 * resolves "system" against the OS, stamps `document.documentElement.dataset
 * .theme`, and keeps the browser chrome `<meta theme-color>` in sync.
 *
 * Pre-paint stamping also happens inline in index.html so there's no flash;
 * this module re-applies at runtime and owns the live "system" listener.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "stable.theme.v1";

const META_LIGHT = "#ffffff";
const META_DARK = "#0b0b15";

const systemMql = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/** Read the stored choice, defaulting to "system". */
export function getStoredTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* ignore */
  }
  return "system";
}

/** Resolve a choice to a concrete light/dark value. */
export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === "light" || choice === "dark") return choice;
  return systemMql()?.matches ? "dark" : "light";
}

/** Stamp the DOM + theme-color meta for a concrete resolved theme. */
function stamp(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "light" ? META_LIGHT : META_DARK);
}

/**
 * Persist + apply a theme choice. Returns the resolved value. Pass persist=
 * false to apply without writing (used on boot).
 */
export function applyTheme(choice: ThemeChoice, persist = true): ResolvedTheme {
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, choice);
    } catch {
      /* ignore */
    }
  }
  const resolved = resolveTheme(choice);
  stamp(resolved);
  return resolved;
}

/**
 * Start the OS-theme listener so a "system" preference live-updates. Returns an
 * unsubscribe fn. No-ops (and stays inert) unless the stored choice is
 * "system" at the moment the OS flips.
 */
export function initSystemThemeWatcher(): () => void {
  const mql = systemMql();
  if (!mql) return () => {};
  const onChange = () => {
    if (getStoredTheme() === "system") stamp(mql.matches ? "dark" : "light");
  };
  // addEventListener is the modern API; older Safari used addListener.
  if (mql.addEventListener) mql.addEventListener("change", onChange);
  else mql.addListener(onChange);
  return () => {
    if (mql.removeEventListener) mql.removeEventListener("change", onChange);
    else mql.removeListener(onChange);
  };
}
