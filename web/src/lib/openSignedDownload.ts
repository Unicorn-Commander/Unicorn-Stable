/**
 * Open a user-activated download target before waiting for its signed URL.
 *
 * The browser surface is passed in so this stays independent of React and can
 * be tested without rendering a component. `open` is deliberately the first
 * side effect: a later await would lose the click's user activation in Safari.
 */
export async function openSignedDownload(
  loadSignedUrl: () => Promise<{ url: string }>,
  browser: Pick<Window, "open" | "document">,
): Promise<void> {
  const tab = browser.open("about:blank", "_blank");
  if (tab) tab.opener = null;

  try {
    const result = await loadSignedUrl();
    if (tab) {
      tab.location.replace(result.url);
      return;
    }

    const anchor = browser.document.createElement("a");
    anchor.href = result.url;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    const body = browser.document.body;
    if (!body) throw new Error("Document body is unavailable");
    body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}
