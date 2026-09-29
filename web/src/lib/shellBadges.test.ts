import { describe, expect, it } from "vitest";
import type { Room } from "@/services/api";
import { shellBadges } from "./shellBadges";

function room(over: Partial<Room> & { id: string }): Room {
  return {
    name: over.id,
    description: "",
    type: "channel",
    created_at: "",
    updated_at: "",
    member_count: 1,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...over,
  };
}

describe("shellBadges", () => {
  const hub = room({ id: "hub", type: "agent_hub" });
  const thread = room({ id: "hub-t-1", type: "agent_hub", parent_room_id: "hub" });
  const channel = room({ id: "general" });
  const channelThread = room({ id: "general-t-1", parent_room_id: "general" });

  it("counts a thread under a hub, not a channel thread without a mention", () => {
    const out = shellBadges({
      rooms: [hub, thread, channel, channelThread],
      unreadCounts: { "hub-t-1": 3, "general-t-1": 5 },
      mentionUnreads: {},
      isMuted: () => false,
      pendingInvites: 0,
    });
    expect(out).toEqual({ conversations: 1, home: 1 });
    const mentioned = shellBadges({
      rooms: [hub, thread, channel, channelThread],
      unreadCounts: { "hub-t-1": 3, "general-t-1": 5 },
      mentionUnreads: { "general-t-1": true },
      isMuted: () => false,
      pendingInvites: 0,
    });
    expect(mentioned.conversations).toBe(2);
  });

  it("respects mute and adds invites to Home only", () => {
    const out = shellBadges({
      rooms: [hub, thread],
      unreadCounts: { hub: 1, "hub-t-1": 3 },
      mentionUnreads: {},
      isMuted: (id) => id === "hub-t-1",
      pendingInvites: 2,
    });
    expect(out).toEqual({ conversations: 1, home: 3 });
  });
});
