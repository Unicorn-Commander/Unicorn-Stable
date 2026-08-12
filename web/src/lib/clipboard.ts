/**
 * Copy text to the clipboard, with the fallback a self-hosted Stable actually
 * needs.
 *
 * `navigator.clipboard` is undefined in an INSECURE CONTEXT, and Stable is
 * routinely reached over plain HTTP on a LAN (the same reason main.tsx installs
 * a crypto shim before anything else boots). A bare `navigator.clipboard
 * .writeText(...)` there throws a TypeError, and the usual `.catch(() => {})`
 * turns that into the worst outcome available: a button that reports nothing
 * and does nothing.
 *
 * Returns whether the text made it, so callers can tell the user the truth —
 * and hand them the string to copy by hand when it didn't.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied permission, or an insecure context that exposes the API but
    // rejects. Fall through to the legacy path rather than giving up.
  }

  try {
    const el = document.createElement("textarea");
    el.value = text;
    // Off-screen but focusable: display:none / visibility:hidden are not
    // selectable, and execCommand("copy") copies the SELECTION.
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-1000px";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
