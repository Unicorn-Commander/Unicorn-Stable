import { beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@/services/api";
import {
  isNavV2Enabled,
  NAV_V2_FLAG_KEY,
  viewForRoom,
} from "./navStore";

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
    localStorage.clear();
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

  it("keeps standing rooms on Meetings for the five-view fallback", () => {
    expect(viewForRoom(room({ is_conference: true, type: "channel" }))).toBe(
      "meetings",
    );
    expect(viewForRoom(room({ type: "agent_hub", brigade_agent_id: "p" }))).toBe(
      "direct",
    );
    expect(viewForRoom(room({ type: "channel" }))).toBe("channels");
  });
});
