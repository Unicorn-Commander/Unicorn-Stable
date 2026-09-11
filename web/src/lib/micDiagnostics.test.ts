import { expect, it, vi } from "vitest";
import { micSnapshot, micWarning, microphonePermission } from "./micDiagnostics";
it("snapshots only bounded capture facts, not device labels", () => {
 const track = { muted: true, enabled: true, readyState: "live", getSettings: () => ({ deviceId: "fixture-device", sampleRate: 48000, label: "private" }) } as unknown as MediaStreamTrack;
 expect(micSnapshot(track, "suspended", "granted", "route_change")).toEqual({ reason: "route_change", track_muted: true, track_enabled: true, ready_state: "live", device_id: "fixture-device", sample_rate: 48000, audio_context_state: "suspended", permission: "granted" });
});
it("reports unavailable tracks honestly", () => expect(micSnapshot(undefined,"unavailable","unsupported","publish").ready_state).toBe("missing"));
it("warns on interruption without claiming a definite route owner", () => expect(micWarning({ permission:"granted", track_muted:true, ready_state:"live" })).toContain("may be using"));
it("permission denial takes priority", () => expect(micWarning({ permission:"denied", track_muted:true, ready_state:"live" })).toContain("permission blocked"));
it("healthy capture has no warning", () => expect(micWarning({ permission:"granted", track_muted:false, ready_state:"live" })).toBeNull());
it("permission API unsupported is not denial", async () => expect(await microphonePermission({ permissions: { query: vi.fn().mockRejectedValue(new Error("unsupported")) } } as unknown as Navigator)).toBeNull());
it("queries microphone permission", async () => { const query=vi.fn().mockResolvedValue({ state:"prompt" }); expect(await microphonePermission({ permissions:{ query } } as unknown as Navigator)).toEqual({state:"prompt"}); expect(query).toHaveBeenCalledWith({name:"microphone"}); });
