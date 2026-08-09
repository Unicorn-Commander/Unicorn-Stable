/**
 * Audio-first call intent — "not all audio calls need to go to video with the
 * agents."
 *
 * Every Stable call starts audio-only, but two things used to force the video
 * stage anyway: the mobile intent defaulted to "video" (full-bleed stage of
 * agent-face tiles), and a stage mode persisted from an earlier VIDEO call in
 * the room reopened the stage for a later AUDIO call. These tests pin the
 * store half of the fix: the split default, the in-memory audio hold, its
 * auto-restore when real video appears, and explicit-choice precedence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveCallRoom, useCallUiStore } from "./callUiStore";

const ROOM = "room-1";

function resetStore(): void {
  setActiveCallRoom(null);
  useCallUiStore.setState({
    viewModes: {},
    anyVideoLive: false,
    audioIntentHold: null,
    audioHoldConsumed: false,
    mobileCallMode: "split",
    mobileCallModeUserOverride: false,
  });
}

describe("mobile intent default", () => {
  beforeEach(resetStore);

  it("a fresh call starts in split (audio layout with chat), not video", () => {
    setActiveCallRoom(ROOM);
    expect(useCallUiStore.getState().mobileCallMode).toBe("split");
    expect(useCallUiStore.getState().mobileCallModeUserOverride).toBe(false);
  });

  it("resetMobileCallUi returns to split", () => {
    useCallUiStore.getState().setMobileCallMode("video", { user: true });
    useCallUiStore.getState().resetMobileCallUi();
    expect(useCallUiStore.getState().mobileCallMode).toBe("split");
  });
});

describe("applyAudioIntentHold", () => {
  beforeEach(resetStore);

  it("holds a persisted video-stage mode at compact and remembers it", () => {
    useCallUiStore.getState().setViewMode(ROOM, "grid");
    setActiveCallRoom(ROOM);

    useCallUiStore.getState().applyAudioIntentHold(ROOM, true);

    const s = useCallUiStore.getState();
    expect(s.viewModes[ROOM]).toBe("compact");
    expect(s.audioIntentHold).toEqual({ roomId: ROOM, priorMode: "grid" });
    expect(s.audioHoldConsumed).toBe(true);
  });

  it("does not persist the held compact to localStorage", () => {
    // The vitest env has no localStorage (the store try/catches around it),
    // so observe persistence through a stub for this one test.
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    });
    try {
      useCallUiStore.getState().setViewMode(ROOM, "grid");
      setActiveCallRoom(ROOM);
      useCallUiStore.getState().applyAudioIntentHold(ROOM, true);

      const raw = backing.get("stable.call-view-modes.v1");
      expect(raw).toBeDefined();
      expect((JSON.parse(raw!) as Record<string, string>)[ROOM]).toBe("grid");
      expect(useCallUiStore.getState().viewModes[ROOM]).toBe("compact");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is a decision, not a write, when the room is already audio-friendly", () => {
    setActiveCallRoom(ROOM);
    useCallUiStore.getState().applyAudioIntentHold(ROOM, false);
    const s = useCallUiStore.getState();
    expect(s.audioIntentHold).toBeNull();
    expect(s.audioHoldConsumed).toBe(true);
    expect(s.viewModes[ROOM]).toBeUndefined();
  });

  it("decides only once per call — video dropping mid-call can't re-collapse", () => {
    useCallUiStore.getState().setViewMode(ROOM, "grid");
    setActiveCallRoom(ROOM);
    useCallUiStore.getState().applyAudioIntentHold(ROOM, true);
    useCallUiStore.getState().liftAudioIntentHold(ROOM);
    expect(useCallUiStore.getState().viewModes[ROOM]).toBe("grid");

    // camera turned off mid-call → a second apply must be a no-op
    useCallUiStore.getState().applyAudioIntentHold(ROOM, true);
    expect(useCallUiStore.getState().viewModes[ROOM]).toBe("grid");
    expect(useCallUiStore.getState().audioIntentHold).toBeNull();
  });
});

describe("hold release", () => {
  beforeEach(resetStore);

  it("liftAudioIntentHold restores the prior stage mode when video arrives", () => {
    useCallUiStore.getState().setViewMode(ROOM, "spotlight");
    setActiveCallRoom(ROOM);
    useCallUiStore.getState().applyAudioIntentHold(ROOM, true);
    expect(useCallUiStore.getState().viewModes[ROOM]).toBe("compact");

    useCallUiStore.getState().liftAudioIntentHold(ROOM);
    const s = useCallUiStore.getState();
    expect(s.viewModes[ROOM]).toBe("spotlight");
    expect(s.audioIntentHold).toBeNull();
  });

  it("an explicit setViewMode (user click or agent ui_command) cancels the hold", () => {
    useCallUiStore.getState().setViewMode(ROOM, "grid");
    setActiveCallRoom(ROOM);
    useCallUiStore.getState().applyAudioIntentHold(ROOM, true);

    // The human opts the stage in from the switcher (or Majik sends a
    // setViewMode ui_command) — the hold must not fight it later.
    useCallUiStore.getState().setViewMode(ROOM, "spotlight");
    expect(useCallUiStore.getState().audioIntentHold).toBeNull();

    // Video arriving later must NOT yank the mode anywhere.
    useCallUiStore.getState().liftAudioIntentHold(ROOM);
    expect(useCallUiStore.getState().viewModes[ROOM]).toBe("spotlight");
  });

  it("hang-up unwinds an unlifted hold back to the persisted preference", () => {
    useCallUiStore.getState().setViewMode(ROOM, "grid");
    setActiveCallRoom(ROOM);
    useCallUiStore.getState().applyAudioIntentHold(ROOM, true);
    expect(useCallUiStore.getState().viewModes[ROOM]).toBe("compact");

    setActiveCallRoom(null); // hang up — call stayed audio the whole time
    const s = useCallUiStore.getState();
    expect(s.viewModes[ROOM]).toBe("grid");
    expect(s.audioIntentHold).toBeNull();
    expect(s.audioHoldConsumed).toBe(false); // re-armed for the next call
  });
});

describe("anyVideoLive mirror", () => {
  beforeEach(resetStore);

  it("setAnyVideoLive stores the signal and call change clears it", () => {
    setActiveCallRoom(ROOM);
    useCallUiStore.getState().setAnyVideoLive(true);
    expect(useCallUiStore.getState().anyVideoLive).toBe(true);

    setActiveCallRoom(null);
    expect(useCallUiStore.getState().anyVideoLive).toBe(false);
  });
});
