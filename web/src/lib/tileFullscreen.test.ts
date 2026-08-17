import { describe, expect, it, vi } from "vitest";
import {
  enterTileFullscreen,
  exitTileFullscreen,
  fullscreenElementOf,
  isTileFullscreen,
  tileFullscreenMode,
  toggleTileFullscreen,
  type TileFullscreenContainer,
  type TileFullscreenDoc,
  type TileFullscreenVideo,
} from "./tileFullscreen";

/* ------------------------------------------------------------------ *
 * Browser stand-ins. The engine reads documents/elements it is HANDED
 * (never globals), which is what lets these run in the node test env.
 * ------------------------------------------------------------------ */

/** Desktop Chrome/Firefox/Edge: standard Fullscreen API, no prefixes. */
function desktopDoc(): TileFullscreenDoc {
  const doc: TileFullscreenDoc = {
    fullscreenEnabled: true,
    fullscreenElement: null,
    exitFullscreen: vi.fn(async () => {
      doc.fullscreenElement = null;
    }),
  };
  return doc;
}

/** Older desktop/iPad Safari: webkit-prefixed element fullscreen only. */
function legacyWebkitDoc(): TileFullscreenDoc {
  const doc: TileFullscreenDoc = {
    webkitFullscreenEnabled: true,
    webkitFullscreenElement: null,
    webkitExitFullscreen: vi.fn(() => {
      doc.webkitFullscreenElement = null;
    }),
  };
  return doc;
}

/** iPhone Safari: NO element fullscreen on the document at all. */
function iphoneDoc(): TileFullscreenDoc {
  return {};
}

/** A tile container whose requestFullscreen succeeds and updates the doc. */
function standardContainer(doc: TileFullscreenDoc) {
  const el: TileFullscreenContainer = {
    requestFullscreen: vi.fn(async function (this: unknown) {
      doc.fullscreenElement = this as Element;
    }),
  };
  return el;
}

/** A container with only the webkit-prefixed element request. */
function webkitContainer(doc: TileFullscreenDoc) {
  const el: TileFullscreenContainer = {
    webkitRequestFullscreen: vi.fn(function (this: unknown) {
      doc.webkitFullscreenElement = this as Element;
    }),
  };
  return el;
}

/** An iPhone-style <video>: only the video-tag pipeline exists. */
function iphoneVideo(): TileFullscreenVideo {
  const video: TileFullscreenVideo = {
    webkitSupportsFullscreen: true,
    webkitDisplayingFullscreen: false,
    webkitEnterFullscreen: vi.fn(() => {
      video.webkitDisplayingFullscreen = true;
    }),
    webkitExitFullscreen: vi.fn(() => {
      video.webkitDisplayingFullscreen = false;
    }),
  };
  return video;
}

/* ------------------------------------------------------------------ *
 * tileFullscreenMode — the button's per-tile render decision.
 * ------------------------------------------------------------------ */

describe("tileFullscreenMode", () => {
  it("is 'element' on a standard-API document (any tile, video or not)", () => {
    expect(tileFullscreenMode(desktopDoc(), null)).toBe("element");
    expect(tileFullscreenMode(desktopDoc(), iphoneVideo())).toBe("element");
  });

  it("is 'element' on a webkit-prefixed document (older Safari)", () => {
    expect(tileFullscreenMode(legacyWebkitDoc(), null)).toBe("element");
  });

  it("is 'video' on iPhone when the tile HAS a <video> (camera / screen-share tile)", () => {
    expect(tileFullscreenMode(iphoneDoc(), iphoneVideo())).toBe("video");
  });

  it("is 'none' on iPhone for an avatar-only tile — no video, no button", () => {
    expect(tileFullscreenMode(iphoneDoc(), null)).toBe("none");
    expect(tileFullscreenMode(iphoneDoc(), undefined)).toBe("none");
  });

  it("is 'none' when the video denies webkitSupportsFullscreen", () => {
    const video = iphoneVideo();
    video.webkitSupportsFullscreen = false;
    expect(tileFullscreenMode(iphoneDoc(), video)).toBe("none");
  });

  it("is 'none' when the video lacks webkitEnterFullscreen entirely", () => {
    expect(tileFullscreenMode(iphoneDoc(), {})).toBe("none");
  });

  it("survives a missing document (SSR-shaped call)", () => {
    expect(tileFullscreenMode(null, null)).toBe("none");
    expect(tileFullscreenMode(undefined, iphoneVideo())).toBe("video");
  });
});

/* ------------------------------------------------------------------ *
 * enterTileFullscreen — the request ladder.
 * ------------------------------------------------------------------ */

describe("enterTileFullscreen", () => {
  it("prefers the standard element API and never touches the video", async () => {
    const doc = desktopDoc();
    const container = standardContainer(doc);
    const video = iphoneVideo();
    const mode = await enterTileFullscreen({ doc, container, video });
    expect(mode).toBe("element");
    expect(container.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(video.webkitEnterFullscreen).not.toHaveBeenCalled();
    expect(doc.fullscreenElement).toBe(container);
  });

  it("falls back to webkitRequestFullscreen when the standard API is missing", async () => {
    const doc = legacyWebkitDoc();
    const container = webkitContainer(doc);
    const mode = await enterTileFullscreen({ doc, container });
    expect(mode).toBe("element");
    expect(container.webkitRequestFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.webkitFullscreenElement).toBe(container);
  });

  it("falls back to video.webkitEnterFullscreen on iPhone (no element API)", async () => {
    const doc = iphoneDoc();
    const video = iphoneVideo();
    const mode = await enterTileFullscreen({ doc, container: {}, video });
    expect(mode).toBe("video");
    expect(video.webkitEnterFullscreen).toHaveBeenCalledTimes(1);
    expect(video.webkitDisplayingFullscreen).toBe(true);
  });

  it("falls through to the video rung when the element request REJECTS", async () => {
    const doc = desktopDoc();
    const container: TileFullscreenContainer = {
      requestFullscreen: vi.fn(async () => {
        throw new TypeError("fullscreen error");
      }),
    };
    const video = iphoneVideo();
    const mode = await enterTileFullscreen({ doc, container, video });
    expect(mode).toBe("video");
    expect(video.webkitEnterFullscreen).toHaveBeenCalledTimes(1);
  });

  it("returns 'none' when no pipeline exists (and does not throw)", async () => {
    await expect(
      enterTileFullscreen({ doc: iphoneDoc(), container: {}, video: null }),
    ).resolves.toBe("none");
  });

  it("returns 'none' when webkitEnterFullscreen throws (no metadata yet)", async () => {
    const video = iphoneVideo();
    video.webkitEnterFullscreen = vi.fn(() => {
      throw new DOMException("not ready", "InvalidStateError");
    });
    await expect(
      enterTileFullscreen({ doc: iphoneDoc(), container: {}, video }),
    ).resolves.toBe("none");
  });
});

/* ------------------------------------------------------------------ *
 * isTileFullscreen / exit / toggle — state truth and the exit paths.
 * ------------------------------------------------------------------ */

describe("isTileFullscreen", () => {
  it("is true only for the tile's OWN container, not another tile's", () => {
    const doc = desktopDoc();
    const mine = standardContainer(doc);
    const other = standardContainer(doc);
    doc.fullscreenElement = other as unknown as Element;
    expect(isTileFullscreen({ doc, container: mine })).toBe(false);
    doc.fullscreenElement = mine as unknown as Element;
    expect(isTileFullscreen({ doc, container: mine })).toBe(true);
  });

  it("reads the webkit element slot too", () => {
    const doc = legacyWebkitDoc();
    const el = webkitContainer(doc);
    doc.webkitFullscreenElement = el as unknown as Element;
    expect(isTileFullscreen({ doc, container: el })).toBe(true);
  });

  it("is true while the iPhone native player is presenting the video", () => {
    const video = iphoneVideo();
    video.webkitDisplayingFullscreen = true;
    expect(
      isTileFullscreen({ doc: iphoneDoc(), container: {}, video }),
    ).toBe(true);
  });

  it("is false when nothing is fullscreen", () => {
    expect(
      isTileFullscreen({
        doc: desktopDoc(),
        container: {},
        video: iphoneVideo(),
      }),
    ).toBe(false);
  });
});

describe("exitTileFullscreen", () => {
  it("dismisses the native player first when the video pipeline is up", async () => {
    const doc = desktopDoc();
    const video = iphoneVideo();
    video.webkitDisplayingFullscreen = true;
    await exitTileFullscreen({ doc, container: {}, video });
    expect(video.webkitExitFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it("uses document.exitFullscreen for element fullscreen", async () => {
    const doc = desktopDoc();
    const el = standardContainer(doc);
    doc.fullscreenElement = el as unknown as Element;
    await exitTileFullscreen({ doc, container: el });
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.fullscreenElement).toBeNull();
  });

  it("uses the webkit document exit when that is all there is", async () => {
    const doc = legacyWebkitDoc();
    const el = webkitContainer(doc);
    doc.webkitFullscreenElement = el as unknown as Element;
    await exitTileFullscreen({ doc, container: el });
    expect(doc.webkitExitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a document", async () => {
    await expect(
      exitTileFullscreen({ doc: null, container: {} }),
    ).resolves.toBeUndefined();
  });
});

describe("toggleTileFullscreen", () => {
  it("enters when the tile is not fullscreen", async () => {
    const doc = desktopDoc();
    const el = standardContainer(doc);
    await expect(toggleTileFullscreen({ doc, container: el })).resolves.toBe(
      "element",
    );
    expect(doc.fullscreenElement).toBe(el);
  });

  it("exits when the tile IS fullscreen (same button, Escape-equivalent)", async () => {
    const doc = desktopDoc();
    const el = standardContainer(doc);
    doc.fullscreenElement = el as unknown as Element;
    await expect(toggleTileFullscreen({ doc, container: el })).resolves.toBe(
      "exit",
    );
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.fullscreenElement).toBeNull();
  });

  it("swaps fullscreen to THIS tile when a different tile holds it", async () => {
    const doc = desktopDoc();
    const mine = standardContainer(doc);
    const other = standardContainer(doc);
    doc.fullscreenElement = other as unknown as Element;
    await expect(toggleTileFullscreen({ doc, container: mine })).resolves.toBe(
      "element",
    );
    expect(doc.fullscreenElement).toBe(mine);
  });

  it("round-trips the iPhone video pipeline", async () => {
    const doc = iphoneDoc();
    const video = iphoneVideo();
    const target = { doc, container: {}, video };
    await expect(toggleTileFullscreen(target)).resolves.toBe("video");
    expect(video.webkitDisplayingFullscreen).toBe(true);
    await expect(toggleTileFullscreen(target)).resolves.toBe("exit");
    expect(video.webkitDisplayingFullscreen).toBe(false);
  });
});

describe("fullscreenElementOf", () => {
  it("prefers the standard slot, falls back to webkit, and handles null docs", () => {
    const standard = desktopDoc();
    const el = {} as Element;
    standard.fullscreenElement = el;
    expect(fullscreenElementOf(standard)).toBe(el);

    const legacy = legacyWebkitDoc();
    legacy.webkitFullscreenElement = el;
    expect(fullscreenElementOf(legacy)).toBe(el);

    expect(fullscreenElementOf(null)).toBeNull();
    expect(fullscreenElementOf(iphoneDoc())).toBeNull();
  });
});
