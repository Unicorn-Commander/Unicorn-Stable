import { useEffect, useState } from "react";

/**
 * A visual viewport this much shorter than the layout viewport means an
 * on-screen keyboard (a collapsing browser toolbar is well under it).
 */
export const KEYBOARD_GAP_PX = 120;

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** A field that brings up the on-screen keyboard when it has the focus. */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase()) && !el.readOnly && !el.disabled;
  }
  return (el as HTMLElement).isContentEditable === true;
}

export interface KeyboardFacts {
  /** A touch screen: the only kind that brings up an on-screen keyboard. */
  coarse: boolean;
  focusedTextEntry: boolean;
  /** `visualViewport.height`, or null where the browser has none. */
  visualHeight: number | null;
  /** `visualViewport.scale`: zoomed in, the visual viewport shrinks too. */
  visualScale: number | null;
  innerHeight: number;
}

/**
 * Is the on-screen keyboard up? Either signal is enough (review 2, P1-4):
 * a text field has the focus on a touch screen — iOS never resizes the
 * layout viewport, so this is the only signal there — or the visual
 * viewport is well short of the layout viewport (Android, and iOS once it
 * reports).
 */
export function keyboardLikelyOpen(facts: KeyboardFacts): boolean {
  if (facts.coarse && facts.focusedTextEntry) return true;
  const zoomed = facts.visualScale !== null && Math.abs(facts.visualScale - 1) > 0.01;
  return (
    !zoomed && facts.visualHeight !== null && facts.visualHeight < facts.innerHeight - KEYBOARD_GAP_PX
  );
}

/**
 * True while the phone's keyboard is up. The tab bar hides and the shell
 * gives back the room it kept for the bar, so the composer sits on the
 * keyboard — not 56 px above it (iOS), nor with the bar between them
 * (Android).
 */
export function useSoftKeyboard(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia?.("(pointer: coarse)");
    const vv = window.visualViewport ?? null;
    const read = () =>
      setOpen(
        keyboardLikelyOpen({
          coarse: coarse?.matches === true,
          focusedTextEntry: isTextEntry(document.activeElement),
          visualHeight: vv ? vv.height : null,
          visualScale: vv ? vv.scale : null,
          innerHeight: window.innerHeight,
        }),
      );
    let pending: ReturnType<typeof setTimeout> | undefined;
    // Focus moving between two fields passes through <body>: read after it
    // lands, or the bar flashes back for a frame.
    const later = () => {
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(read, 0);
    };
    read();
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", later);
    vv?.addEventListener("resize", read);
    window.addEventListener("resize", read);
    coarse?.addEventListener?.("change", read);
    return () => {
      if (pending !== undefined) clearTimeout(pending);
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", later);
      vv?.removeEventListener("resize", read);
      window.removeEventListener("resize", read);
      coarse?.removeEventListener?.("change", read);
    };
  }, []);
  return open;
}
