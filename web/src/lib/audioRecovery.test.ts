import { it, expect, vi } from "vitest";
import { enterDuplexSession, recoverCallAudio } from "./audioRecovery";
it("restores the audio session after leaving", () => {
  const nav = { audioSession: { type: "auto" } };
  const leave = enterDuplexSession(nav);
  expect(nav.audioSession.type).toBe("play-and-record");
  leave();
  expect(nav.audioSession.type).toBe("auto");
});
it("does not overwrite another audio-session owner", () => {
  const nav = { audioSession: { type: "auto" } };
  const leave = enterDuplexSession(nav);
  nav.audioSession.type = "playback";
  leave();
  expect(nav.audioSession.type).toBe("playback");
});
it("works without the optional API", () =>
  expect(() => enterDuplexSession({})()).not.toThrow());
it.each([true, false])(
  "recaptures only enabled microphones (%s)",
  async (enabled) => {
    const restartTrack = vi.fn(async () => {});
    const startAudio = vi.fn(async () => {});
    await recoverCallAudio(
      {
        localParticipant: {
          isMicrophoneEnabled: enabled,
          getTrackPublication: () => ({ track: { restartTrack } }),
        },
        startAudio,
      },
      "microphone",
    );
    expect(restartTrack).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) expect(restartTrack).toHaveBeenCalledWith({ deviceId: "default" });
    expect(startAudio).toHaveBeenCalledOnce();
  },
);
