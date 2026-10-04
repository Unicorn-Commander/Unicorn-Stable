import { afterEach, describe, expect, it, vi } from "vitest";
import { openSignedDownload } from "./openSignedDownload";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("openSignedDownload", () => {
  it("navigates the opened tab without touching the app location", async () => {
    const url = "https://signed.example/recording.ogg?sig=test";
    const location = { replace: vi.fn() };
    const close = vi.fn();
    const tab = { opener: window, location, close };
    const opened = tab as unknown as Window;
    const open = vi.fn(() => opened);
    const browser = { open, document } as unknown as Pick<Window, "open" | "document">;
    const loadSignedUrl = vi.fn(async () => ({ url }));
    const appLocation = window.location.href;

    await openSignedDownload(loadSignedUrl, browser);

    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    expect(location.replace).toHaveBeenCalledWith(url);
    expect(close).not.toHaveBeenCalled();
    expect(window.location.href).toBe(appLocation);
    expect(document.body.querySelector("a")).toBeNull();
  });

  it("closes the opened tab when fetching the signed URL fails", async () => {
    const error = new Error("signed URL unavailable");
    const tab = {
      opener: window,
      location: { replace: vi.fn() },
      close: vi.fn(),
    };
    const open = vi.fn(() => tab as unknown as Window);
    const browser = { open, document } as unknown as Pick<Window, "open" | "document">;

    await expect(
      openSignedDownload(() => Promise.reject(error), browser),
    ).rejects.toBe(error);

    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it("uses an attached transient anchor when the popup is blocked", async () => {
    const url = "https://signed.example/recording.ogg?sig=test";
    const open = vi.fn(() => null);
    const browser = { open, document } as unknown as Pick<Window, "open" | "document">;
    const clickedAnchors: HTMLAnchorElement[] = [];
    let wasAttachedDuringClick = false;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      const anchor = document.body.querySelector("a");
      if (anchor) clickedAnchors.push(anchor);
      wasAttachedDuringClick = anchor !== null;
    });

    await openSignedDownload(async () => ({ url }), browser);

    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(clickedAnchors).toHaveLength(1);
    expect(wasAttachedDuringClick).toBe(true);
    const clickedAnchor = clickedAnchors[0]!;
    expect(clickedAnchor.getAttribute("href")).toBe(url);
    expect(clickedAnchor.target).toBe("_blank");
    expect(clickedAnchor.rel).toBe("noopener");
    expect(document.body.contains(clickedAnchor)).toBe(false);
  });
});
