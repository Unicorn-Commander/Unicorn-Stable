/**
 * Put the cursor in `el` now or, when it has no box yet, the first time it
 * gets one.
 *
 * A room's chat mounts inside a slot that PanelHost parks in a hidden
 * element until the room's dock exists, one render later. A hidden box
 * cannot take the focus, so the composer's "the cursor is in the box when a
 * room opens" never took, from Home or from the list (review 2, P2-3).
 * Waiting for the box keeps that promise without knowing about the park.
 *
 * The focus is only taken from where it was when this was asked, or from
 * nowhere: never from something the user moved it to in the meantime.
 *
 * Returns what stops the wait (for an effect's cleanup).
 */
export function focusWhenShown(el: HTMLElement): () => void {
  const from = document.activeElement;
  el.focus();
  if (document.activeElement === el || typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => {
    if (!el.isConnected) {
      observer.disconnect();
      return;
    }
    if (el.getClientRects().length === 0) return;
    observer.disconnect();
    const now = document.activeElement;
    if (now === from || now === null || now === document.body) el.focus();
  });
  observer.observe(el);
  return () => observer.disconnect();
}
