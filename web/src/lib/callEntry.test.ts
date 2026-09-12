import { describe, expect, it } from "vitest";
import { DEFAULT_CALL_ENTRY_PREFS, resolveCallEntry } from "./callEntry";

describe("resolveCallEntry", () => {
  it("a voice call connects straight in, camera off — no preference can bring the dialog back", () => {
    expect(resolveCallEntry({ kind: "voice" })).toEqual({
      kind: "voice",
      video: false,
      skipDeviceCheck: true,
    });
    expect(
      resolveCallEntry({ kind: "voice" }, { checkDevicesBeforeVideo: true }),
    ).toEqual({ kind: "voice", video: false, skipDeviceCheck: true });
    // Even a stale explicit "show the check" can't make a voice call ask.
    expect(
      resolveCallEntry({ kind: "voice", skipDeviceCheck: false }).skipDeviceCheck,
    ).toBe(true);
  });

  it("the bare phone button (no kind) is a voice call", () => {
    expect(resolveCallEntry(undefined)).toEqual({
      kind: "voice",
      video: false,
      skipDeviceCheck: true,
    });
    expect(resolveCallEntry({})).toEqual({
      kind: "voice",
      video: false,
      skipDeviceCheck: true,
    });
  });

  it("a video call connects straight in by default, camera on", () => {
    expect(resolveCallEntry({ kind: "video" })).toEqual({
      kind: "video",
      video: true,
      skipDeviceCheck: true,
    });
    expect(DEFAULT_CALL_ENTRY_PREFS.checkDevicesBeforeVideo).toBe(false);
  });

  it("only the video-check preference brings the pre-join dialog back, and only for video", () => {
    const prefs = { checkDevicesBeforeVideo: true };
    expect(resolveCallEntry({ kind: "video" }, prefs).skipDeviceCheck).toBe(false);
    expect(resolveCallEntry({ kind: "voice" }, prefs).skipDeviceCheck).toBe(true);
  });

  it("a deep link's explicit flags win over the preference", () => {
    const prefs = { checkDevicesBeforeVideo: true };
    expect(
      resolveCallEntry({ kind: "video", skipDeviceCheck: true }, prefs),
    ).toEqual({ kind: "video", video: true, skipDeviceCheck: true });
    // `video=1` without a kind is a video call; `video=0` on a video call still joins camera-off.
    expect(resolveCallEntry({ video: true }).kind).toBe("video");
    expect(resolveCallEntry({ kind: "video", video: false }).video).toBe(false);
  });
});
