import { useEffect } from "react";

/**
 * Pins the CSS variable `--app-height` to the *visual* viewport height so the
 * app always fills exactly the visible area on mobile.
 *
 * Why not `100vh`/`100dvh`?
 *  - iOS Safari's `100vh` is the *largest* viewport (toolbar retracted), so the
 *    bottom of a 100vh app sits behind the browser's bottom toolbar — the
 *    message composer ends up hidden/unreachable. This is the #1 "mobile isn't
 *    usable" symptom.
 *  - `100dvh` tracks the toolbar but NOT the on-screen keyboard. When the
 *    keyboard opens, a 100dvh app stays full-height and the composer is covered.
 *  - `window.visualViewport.height` tracks BOTH the collapsing toolbar and the
 *    keyboard, so the app shrinks to the truly-visible region and the composer
 *    rides just above whatever is on screen.
 *
 * We only listen to `resize`/`orientationchange` (not `scroll`) to avoid
 * per-frame height churn while the toolbar collapses during a scroll. Falls
 * back to `100dvh` when visualViewport is unavailable (older browsers).
 */
export function useAppHeight() {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;

    if (!vv) {
      root.style.setProperty("--app-height", "100dvh");
      return;
    }

    const apply = () => {
      root.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
    };

    apply();
    // visualViewport `resize` already fires on rotation, toolbar collapse, and
    // keyboard show/hide. We deliberately do NOT also bind `orientationchange`:
    // on iOS it fires BEFORE the viewport settles, so it would read a stale
    // height — the trailing `resize` is the authoritative signal.
    vv.addEventListener("resize", apply);
    return () => {
      vv.removeEventListener("resize", apply);
    };
  }, []);
}
