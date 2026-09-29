import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@/services/api";
import {
  isNavV2Enabled,
  NAV_V1_FLAG_KEY,
  NAV_V2_FLAG_KEY,
  shellDestinationForPath,
  viewForRoom,
} from "./navStore";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

function room(over: Partial<Room> = {}): Room {
  return {
    id: "r",
    name: "room",
    description: "",
    type: "channel",
    created_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T00:00:00Z",
    member_count: 1,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...over,
  };
}

describe("nav v2 flag", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("defaults on", () => {
    expect(isNavV2Enabled()).toBe(true);
  });

  it("turns off for 0 and false", () => {
    localStorage.setItem(NAV_V2_FLAG_KEY, "0");
    expect(isNavV2Enabled()).toBe(false);
    localStorage.setItem(NAV_V2_FLAG_KEY, "false");
    expect(isNavV2Enabled()).toBe(false);
  });

  it("turns on for 1 and true", () => {
    localStorage.setItem(NAV_V2_FLAG_KEY, "0");
    localStorage.setItem(NAV_V2_FLAG_KEY, "1");
    expect(isNavV2Enabled()).toBe(true);
    localStorage.setItem(NAV_V2_FLAG_KEY, "true");
    expect(isNavV2Enabled()).toBe(true);
  });

  it("treats an explicit nav v1 opt-out as nav v2 off", () => {
    localStorage.setItem(NAV_V1_FLAG_KEY, "0");
    expect(isNavV2Enabled()).toBe(false);
    localStorage.setItem(NAV_V2_FLAG_KEY, "1");
    expect(isNavV2Enabled()).toBe(false);
    localStorage.setItem(NAV_V1_FLAG_KEY, "false");
    localStorage.removeItem(NAV_V2_FLAG_KEY);
    expect(isNavV2Enabled()).toBe(false);
  });

  it("keeps standing rooms on Meetings for the five-view fallback", () => {
    expect(viewForRoom(room({ is_conference: true, type: "channel" }))).toBe(
      "meetings",
    );
    expect(viewForRoom(room({ type: "agent_hub", brigade_agent_id: "p" }))).toBe(
      "direct",
    );
    expect(viewForRoom(room({ type: "channel" }))).toBe("channels");
  });

  it("derives directory from the agents path and drops it off that path", () => {
    expect(shellDestinationForPath("/agents", "home")).toBe("directory");
    expect(shellDestinationForPath("/agents/org", "conversations")).toBe(
      "directory",
    );
    expect(shellDestinationForPath("/", "directory")).toBe("home");
    expect(shellDestinationForPath("/", "conversations")).toBe("conversations");
    expect(shellDestinationForPath("/c/room-1", "directory")).toBe(
      "conversations",
    );
    expect(shellDestinationForPath("/c/room-1", "home")).toBe("conversations");
  });
});

describe("nav v3 phone tabs", () => {
  it("keeps the Crew and Calls tabs on a room path, and folds them on the desktop rail", async () => {
    const { PHONE_TABS, phoneTabForDestination, railDestination } = await import("./navStore");
    expect(shellDestinationForPath("/c/room-1", "crew")).toBe("crew");
    expect(shellDestinationForPath("/c/room-1", "calls")).toBe("calls");
    expect(shellDestinationForPath("/c/room-1", "home")).toBe("conversations");
    expect(shellDestinationForPath("/", "crew")).toBe("crew");
    expect(shellDestinationForPath("/agents", "crew")).toBe("directory");
    expect(PHONE_TABS.map((tab) => tab.id)).toEqual(["home", "chats", "crew", "calls", "me"]);
    expect(PHONE_TABS.map((tab) => tab.destination)).toEqual([
      "home",
      "conversations",
      "crew",
      "calls",
      null,
    ]);
    expect(phoneTabForDestination("directory")).toBe("crew");
    expect(phoneTabForDestination("conversations")).toBe("chats");
    expect(phoneTabForDestination("calls")).toBe("calls");
    expect(railDestination("crew")).toBe("conversations");
    expect(railDestination("calls")).toBe("conversations");
    expect(railDestination("directory")).toBe("directory");
  });
});
