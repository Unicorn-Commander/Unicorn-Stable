import { describe, expect, it } from "vitest";
import {
  applyOccupancyEvent,
  isFreshCallStart,
  liveCallsByRoom,
  shouldShowCallDock,
  shouldShowLiveCallBanner,
  shouldToastCallStart,
  type CallOccupancyEvent,
  type CallStartToastArgs,
  type LiveCallEntry,
} from "./callAwareness";

const entry = (over: Partial<LiveCallEntry> = {}): LiveCallEntry => ({
  room_id: "room-a",
  display_name: "Design",
  room_type: "channel",
  participant_count: 2,
  has_agent: false,
  ...over,
});

const event = (over: Partial<CallOccupancyEvent> = {}): CallOccupancyEvent => ({
  room_id: "room-a",
  room_type: "channel",
  room_name: "Design",
  participant_count: 1,
  has_agent: false,
  by: { id: "p-alice", display_name: "Alice" },
  ...over,
});

describe("liveCallsByRoom", () => {
  it("indexes entries by room id and tolerates undefined", () => {
    const map = liveCallsByRoom([entry(), entry({ room_id: "room-b" })]);
    expect(map["room-a"]?.display_name).toBe("Design");
    expect(map["room-b"]).toBeDefined();
    expect(liveCallsByRoom(undefined)).toEqual({});
  });
});

describe("applyOccupancyEvent", () => {
  it("adds a room the poll has not seen yet", () => {
    const next = applyOccupancyEvent([], event({ participant_count: 1 }));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      room_id: "room-a",
      display_name: "Design",
      participant_count: 1,
    });
  });

  it("updates the count of an existing entry without duplicating it", () => {
    const next = applyOccupancyEvent(
      [entry({ participant_count: 1 }), entry({ room_id: "room-b" })],
      event({ participant_count: 3 }),
    );
    expect(next.filter((c) => c.room_id === "room-a")).toHaveLength(1);
    expect(next.find((c) => c.room_id === "room-a")?.participant_count).toBe(3);
    // Unrelated rooms untouched.
    expect(next.find((c) => c.room_id === "room-b")?.participant_count).toBe(2);
  });

  it("removes the entry when occupancy hits zero", () => {
    const next = applyOccupancyEvent(
      [entry()],
      event({ participant_count: 0, by: null }),
    );
    expect(next).toEqual([]);
  });

  it("keeps known name/type/agent facts when the event omits them", () => {
    const next = applyOccupancyEvent(
      [entry({ has_agent: true })],
      event({ participant_count: 1, room_name: "", has_agent: undefined }),
    );
    expect(next[0]).toMatchObject({
      display_name: "Design",
      has_agent: true,
    });
  });

  it("never mutates the input list", () => {
    const first = entry({ participant_count: 1 });
    const before = [first];
    applyOccupancyEvent(before, event({ participant_count: 5 }));
    expect(first.participant_count).toBe(1);
    expect(before).toHaveLength(1);
  });
});

describe("isFreshCallStart", () => {
  it("is true for a first join in a room not already live", () => {
    expect(isFreshCallStart([], event())).toBe(true);
    expect(isFreshCallStart(undefined, event())).toBe(true);
  });

  it("is false for a leave (no `by`)", () => {
    expect(isFreshCallStart([], event({ by: null }))).toBe(false);
    expect(isFreshCallStart([], event({ by: undefined }))).toBe(false);
  });

  it("is false when the joiner is not the first participant", () => {
    expect(isFreshCallStart([], event({ participant_count: 2 }))).toBe(false);
  });

  it("is false when the cache already lists the room live (webhook retry)", () => {
    expect(isFreshCallStart([entry()], event())).toBe(false);
  });
});

describe("shouldToastCallStart", () => {
  const base: CallStartToastArgs = {
    freshStart: true,
    roomId: "room-a",
    byParticipantId: "p-alice",
    selfParticipantId: "p-me",
    selfUserId: "kc-me",
    connectedCallRoomId: null,
    viewingRoomId: "room-other",
    documentVisible: true,
    ringingRoomId: null,
    notifyLevel: "all",
  };

  it("toasts a fresh start elsewhere in the app", () => {
    expect(shouldToastCallStart(base)).toBe(true);
  });

  it("never toasts a non-start", () => {
    expect(shouldToastCallStart({ ...base, freshStart: false })).toBe(false);
  });

  it("never toasts your own call start (participant id space)", () => {
    expect(
      shouldToastCallStart({ ...base, byParticipantId: "p-me" }),
    ).toBe(false);
  });

  it("never toasts your own call start (keycloak id fallback)", () => {
    expect(
      shouldToastCallStart({ ...base, byParticipantId: "kc-me" }),
    ).toBe(false);
  });

  it("does not treat an unnamed joiner as self", () => {
    expect(shouldToastCallStart({ ...base, byParticipantId: null })).toBe(true);
  });

  it("skips the room this device's call is in", () => {
    expect(
      shouldToastCallStart({ ...base, connectedCallRoomId: "room-a" }),
    ).toBe(false);
  });

  it("skips the room on screen while the tab is visible", () => {
    expect(
      shouldToastCallStart({ ...base, viewingRoomId: "room-a" }),
    ).toBe(false);
  });

  it("still toasts for the on-screen room when the tab is hidden", () => {
    expect(
      shouldToastCallStart({
        ...base,
        viewingRoomId: "room-a",
        documentVisible: false,
      }),
    ).toBe(true);
  });

  it("defers to an active ring banner for the same room", () => {
    expect(shouldToastCallStart({ ...base, ringingRoomId: "room-a" })).toBe(
      false,
    );
  });

  it("respects per-room notification levels", () => {
    expect(shouldToastCallStart({ ...base, notifyLevel: "muted" })).toBe(false);
    expect(shouldToastCallStart({ ...base, notifyLevel: "mentions" })).toBe(
      false,
    );
  });
});

describe("shouldShowCallDock", () => {
  it("shows while connected and viewing another room", () => {
    expect(
      shouldShowCallDock({
        isConnected: true,
        activeCallRoomId: "room-a",
        activeRoomId: "room-b",
      }),
    ).toBe(true);
  });

  it("shows while connected and on a non-room page (no active room)", () => {
    expect(
      shouldShowCallDock({
        isConnected: true,
        activeCallRoomId: "room-a",
        activeRoomId: null,
      }),
    ).toBe(true);
  });

  it("hides in the call's own room", () => {
    expect(
      shouldShowCallDock({
        isConnected: true,
        activeCallRoomId: "room-a",
        activeRoomId: "room-a",
      }),
    ).toBe(false);
  });

  it("hides when not connected, even with a (stale) call room id", () => {
    expect(
      shouldShowCallDock({
        isConnected: false,
        activeCallRoomId: "room-a",
        activeRoomId: "room-b",
      }),
    ).toBe(false);
  });

  it("hides when connected but no call room is recorded", () => {
    // Should be unreachable (VoiceProvider sets the id before connecting) but
    // the dock must fail closed rather than render a pill with no target.
    expect(
      shouldShowCallDock({
        isConnected: true,
        activeCallRoomId: null,
        activeRoomId: "room-b",
      }),
    ).toBe(false);
  });
});

describe("shouldShowLiveCallBanner", () => {
  const base = {
    liveCall: entry(),
    roomId: "room-a",
    isConnected: false,
    isConnecting: false,
    activeCallRoomId: null as string | null,
    ringingRoomId: null as string | null,
  };

  it("shows for a live call this device is not on", () => {
    expect(shouldShowLiveCallBanner(base)).toBe(true);
  });

  it("hides with no live call", () => {
    expect(shouldShowLiveCallBanner({ ...base, liveCall: undefined })).toBe(
      false,
    );
  });

  it("hides when this device is connected to THIS room's call", () => {
    expect(
      shouldShowLiveCallBanner({
        ...base,
        isConnected: true,
        activeCallRoomId: "room-a",
      }),
    ).toBe(false);
  });

  it("still shows when connected to a DIFFERENT room's call", () => {
    // Viewing room A which has a call, while my call lives in room B: the
    // banner is the honest "there is also a call HERE" surface (join = switch).
    expect(
      shouldShowLiveCallBanner({
        ...base,
        isConnected: true,
        activeCallRoomId: "room-b",
      }),
    ).toBe(true);
  });

  it("hides mid-join to avoid a flash while connecting", () => {
    expect(shouldShowLiveCallBanner({ ...base, isConnecting: true })).toBe(
      false,
    );
  });

  it("defers to the ringing banner for this room", () => {
    expect(
      shouldShowLiveCallBanner({ ...base, ringingRoomId: "room-a" }),
    ).toBe(false);
  });
});
