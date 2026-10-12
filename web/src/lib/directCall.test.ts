/**
 * The ringing-loop fix, pinned as ORDER: nobody is rung until this client is
 * on the line, and backing out of the device check rings nobody.
 */
import { describe, expect, it, vi } from "vitest";
import { runStartCall, type StartCallDeps } from "./directCall";
import type { RingResponse } from "@/services/api";

function ringResponse(partial: Partial<RingResponse>): RingResponse {
  return {
    call_id: "call-1",
    room_id: "room-1",
    state: "ringing",
    started_at: "2026-09-02T22:59:02Z",
    expires_at: "2026-09-02T22:59:47Z",
    ring_timeout_seconds: 45,
    targets: [{ id: "shafen", display_name: "Shafen", state: "ringing" }],
    ...partial,
  };
}

function deps(over: Partial<StartCallDeps> = {}) {
  const order: string[] = [];
  const d: StartCallDeps = {
    connect: vi.fn(async () => {
      order.push("connect");
      return true;
    }),
    ringRoom: vi.fn(async () => {
      order.push("ring");
      return ringResponse({});
    }),
    ring: vi.fn(() => void order.push("card:ringing")),
    showOutcome: vi.fn((c) => void order.push(`card:${c.phase}`)),
    disconnect: vi.fn(() => void order.push("disconnect")),
    ...over,
  };
  return { d, order };
}

const E04 = {
  roomId: "room-1",
  roomType: "group_dm" as const,
  hasAgents: true,
  label: "Build In Public — E04",
};

describe("runStartCall", () => {
  it("rings AFTER connecting, never before", async () => {
    const { d, order } = deps();
    const result = await runStartCall(E04, d);
    expect(result).toBe("joined_ringing");
    expect(order).toEqual(["connect", "ring", "card:ringing"]);
  });

  it("backing out of the device check rings nobody", async () => {
    const { d, order } = deps({ connect: vi.fn(async () => false) });
    expect(await runStartCall(E04, d)).toBe("backed_out");
    expect(d.ringRoom).not.toHaveBeenCalled();
    expect(d.ring).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("ring=false joins silently — no ring request, no card", async () => {
    const { d } = deps();
    expect(await runStartCall({ ...E04, ring: false }, d)).toBe("joined_no_ring");
    expect(d.connect).toHaveBeenCalledTimes(1);
    expect(d.ringRoom).not.toHaveBeenCalled();
  });

  it("channels just join", async () => {
    const { d } = deps();
    expect(await runStartCall({ ...E04, roomType: "channel" }, d)).toBe(
      "joined_channel",
    );
    expect(d.ringRoom).not.toHaveBeenCalled();
  });

  it("in_call (everyone already on the line) shows no card", async () => {
    const { d } = deps({
      ringRoom: vi.fn(async () =>
        ringResponse({
          call_id: null,
          state: "in_call",
          targets: [{ id: "shafen", display_name: "Shafen", state: "in_call" }],
        }),
      ),
    });
    expect(await runStartCall(E04, d)).toBe("joined_in_call");
    expect(d.ring).not.toHaveBeenCalled();
    expect(d.showOutcome).not.toHaveBeenCalled();
  });

  it("show room with the other human offline: STAY (agents are here), say so", async () => {
    const { d, order } = deps({
      ringRoom: vi.fn(async () =>
        ringResponse({
          call_id: null,
          state: "unreachable",
          targets: [{ id: "shafen", display_name: "Shafen", state: "offline" }],
        }),
      ),
    });
    expect(await runStartCall(E04, d)).toBe("joined_unreachable");
    expect(d.disconnect).not.toHaveBeenCalled();
    expect(d.ringRoom).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["connect", "card:offline"]);
    expect(d.showOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "Shafen isn't online right now." }),
    );
  });

  it("1:1 human DM with nobody reachable: leave the empty room", async () => {
    const { d } = deps({
      ringRoom: vi.fn(async () =>
        ringResponse({
          call_id: null,
          state: "unreachable",
          targets: [{ id: "shafen", display_name: "Shafen", state: "busy" }],
        }),
      ),
    });
    expect(
      await runStartCall(
        { ...E04, roomType: "dm", hasAgents: false, label: "Shafen" },
        d,
      ),
    ).toBe("left_unreachable");
    expect(d.disconnect).toHaveBeenCalledTimes(1);
    expect(d.showOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "busy" }),
    );
  });

  it("409 (agent DM, nobody human to ring) is a silent join", async () => {
    const { d } = deps({
      ringRoom: vi.fn(async () => {
        throw { status: 409, detail: "There is nobody in this conversation to call." };
      }),
    });
    expect(await runStartCall({ ...E04, roomType: "dm" }, d)).toBe("joined_no_ring");
    expect(d.showOutcome).not.toHaveBeenCalled();
    expect(d.disconnect).not.toHaveBeenCalled();
  });

  it("surfaces a runner canonical-room 409 and does not retry it", async () => {
    const showRunnerVoiceCanonicalOnly = vi.fn();
    const { d } = deps({
      showRunnerVoiceCanonicalOnly,
      ringRoom: vi.fn(async () => {
        throw {
          status: 409,
          detail: {
            code: "runner_voice_canonical_only",
            detail: "Open this runner's canonical chat; new runner rooms require provisioning",
            canonical_room_id: "canonical-room",
            canonical_room_name: "Persephone · Desk",
            seat: "persephone",
          },
        };
      }),
    });
    expect(await runStartCall({ ...E04, roomType: "dm" }, d)).toBe("joined_no_ring");
    expect(showRunnerVoiceCanonicalOnly).toHaveBeenCalledWith({
      code: "runner_voice_canonical_only",
      detail: "Open this runner's canonical chat; new runner rooms require provisioning",
      canonical_room_id: "canonical-room",
      canonical_room_name: "Persephone · Desk",
      seat: "persephone",
    });
    expect(d.ringRoom).toHaveBeenCalledTimes(1);
    expect(d.showOutcome).not.toHaveBeenCalled();
  });

  it("a failed ring leaves you IN the call and says they weren't told", async () => {
    const { d } = deps({
      ringRoom: vi.fn(async () => {
        throw { status: 500 };
      }),
    });
    expect(await runStartCall(E04, d)).toBe("joined_ring_failed");
    expect(d.disconnect).not.toHaveBeenCalled();
    expect(d.showOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "failed",
        detail: "Couldn't ring them. You're in the call; they weren't told.",
      }),
    );
  });

  it("uncertain presence is said out loud on the card", async () => {
    const { d } = deps({
      ringRoom: vi.fn(async () =>
        ringResponse({
          targets: [{ id: "shafen", display_name: "Shafen", state: "unknown" }],
        }),
      ),
    });
    await runStartCall(E04, d);
    expect(d.ring).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "Ringing Build In Public — E04… (couldn't confirm they're online)",
      }),
    );
  });
});
