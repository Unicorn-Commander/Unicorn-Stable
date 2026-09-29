import { useEffect, useRef, type RefObject } from "react";

/**
 * Elements a modal focus trap may land on. Visibility is filtered at query
 * time (offsetParent — same trick as useMenuKeyboard) so hidden-at-breakpoint
 * controls are skipped.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Baseline dialog accessibility for a modal panel. Attach the returned ref to
 * the panel element (the inner card, not the backdrop) and give the panel
 * `role="dialog" aria-modal="true"` plus a label in JSX. The hook provides:
 *
 *  - focus trap — Tab / Shift+Tab cycle within the panel's focusable elements
 *  - initial focus — first `[autofocus]`, else first focusable, else the
 *    panel itself (the hook stamps `tabindex="-1"` on the panel). If the
 *    component already moved focus inside the panel (e.g. a search input's
 *    own focus effect), the hook leaves it alone.
 *  - focus restore — on close/unmount, focus returns to whatever was focused
 *    before the modal opened
 *  - Escape → onClose. The listener lives on the panel (not window) and stops
 *    propagation, so with stacked modals one Esc closes exactly one layer:
 *    the trap keeps focus in the topmost panel, sibling panels underneath
 *    never see the event.
 *
 * Only Tab and Escape are intercepted — arrow keys etc. pass through, so
 * list-navigation modals (QuickSwitcher) keep working.
 *
 * `onClose` is read through a ref, so an inline-arrow prop won't retrigger
 * the effect (which would re-run initial focus) on every parent render.
 *
 * `target`: a panel whose ref the component already owns (a popover that
 * becomes a modal sheet on a phone) — the hook works on it instead of
 * handing out a ref of its own.
 */
export function useModalA11y(
  active: boolean,
  onClose: () => void,
  target?: RefObject<HTMLElement | null>,
) {
  const ownRef = useRef<HTMLDivElement>(null);
  const panelRef: RefObject<HTMLElement | null> = target ?? ownRef;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // The panel is the focus target of last resort — and clicking its
    // non-interactive content keeps focus inside it (so panel keydowns keep
    // reaching our listener) instead of falling out to <body>.
    if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");

    const focusables = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null); // visible only

    // Initial focus after paint (framer-motion mounts mid-animation). Skip if
    // the component already placed focus inside the panel itself.
    const raf = requestAnimationFrame(() => {
      if (panel.contains(document.activeElement)) return;
      const auto = panel.querySelector<HTMLElement>("[autofocus]");
      const target = auto && auto.offsetParent !== null ? auto : focusables()[0];
      (target ?? panel).focus();
    });

    // Arrow (not a hoisted function declaration) so TS carries the `panel`
    // non-null narrowing from above into the closure.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.isComposing) return; // IME cancel, not a dismiss
        // One Esc, one layer: never let the event reach window listeners or
        // anything beneath this panel.
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const current = document.activeElement;
      const outside = !(current instanceof HTMLElement) || !panel.contains(current);

      if (e.shiftKey) {
        if (outside || current === first || current === panel) {
          e.preventDefault();
          last.focus();
        }
      } else if (outside || current === last || current === panel) {
        e.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      panel.removeEventListener("keydown", onKeyDown);
      // Restore focus to wherever the user was before the modal opened —
      // with stacked modals that's inside the modal underneath, which puts
      // the next Esc in *its* panel.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active, panelRef]);

  return ownRef;
}
