import { useEffect, type RefObject } from "react";

/**
 * Minimal WAI-ARIA keyboard support for a simple disclosure menu (a button that
 * toggles a `role="menu"` popup of `role="menuitem"` buttons):
 *
 *  - on open, focus moves to the first *visible* item
 *  - Arrow Up/Down cycle through items, Home/End jump to first/last
 *  - Escape closes the menu and returns focus to the trigger
 *
 * Click-outside dismissal is left to each menu (they already have it). Items
 * that are hidden at the current breakpoint (`display:none`, e.g. the mobile-
 * only entries in the room ⋮ menu) are skipped so focus never lands on them.
 */
export function useMenuKeyboard(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;

    const items = () =>
      Array.from(
        menu.querySelectorAll<HTMLElement>(
          '[role="menuitem"], button:not([disabled])',
        ),
      ).filter((el) => el.offsetParent !== null); // visible only

    // Focus item `i` (with wrap-around; -1 → last). Safe on an empty list.
    const focusAt = (i: number) => {
      const list = items();
      if (list.length === 0) return;
      const n = ((i % list.length) + list.length) % list.length;
      list[n]?.focus();
    };

    // Focus the first item once the menu is open.
    const id = requestAnimationFrame(() => focusAt(0));

    function onKey(e: KeyboardEvent) {
      const list = items();
      if (list.length === 0) return;
      const idx = list.indexOf(document.activeElement as HTMLElement);
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusAt(idx + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusAt(idx - 1);
          break;
        case "Home":
          e.preventDefault();
          focusAt(0);
          break;
        case "End":
          e.preventDefault();
          focusAt(-1);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          triggerRef.current?.focus();
          break;
      }
    }

    menu.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      menu.removeEventListener("keydown", onKey);
    };
  }, [open, menuRef, triggerRef, onClose]);
}
