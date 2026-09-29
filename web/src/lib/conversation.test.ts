import { describe, expect, it } from "vitest";
import { othersInRoom } from "./conversation";
import type { Room, RoomMember } from "@/services/api";
import {
  HUB_STARTER_PROMPTS,
  NEW_SHEET_ITEMS,
  THREAD_ENTRY_POINTS,
  channelConsequence,
  countNeedsYou,
  guestLinkConsequence,
  noteThreadOnParent,
  olderArchivedLabel,
  parseThreadSlash,
  projectChannelConsequence,
  roomLabel,
  roomNeedsYou,
  threadStubFromEvent,
  upsertRoomList,
} from "./conversation";

function room(over: Partial<Room> = {}): Room {
  return {
    id: "r1",
    name: "general",
    description: "",
    type: "channel",
    created_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T00:00:00Z",
    member_count: 2,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...over,
  };
}

describe("thread entry points", () => {
  it("keeps every way to start a thread, including a seeded message", () => {
    const ids = THREAD_ENTRY_POINTS.map((row) => row.id);
    expect(ids).toEqual([
      "sidebar-plus",
      "room-header",
      "threads-panel",
      "shortcut",
      "new-sheet",
      "message-menu",
      "slash",
      "crew-card",
      "phone-fab",
    ]);
    expect(THREAD_ENTRY_POINTS.find((row) => row.id === "message-menu")?.detail).toContain(
      "seed_message_id",
    );
  });

  it("parses /thread and leaves other slash commands alone", () => {
    expect(parseThreadSlash("/thread")).toEqual({ title: null });
    expect(parseThreadSlash("/thread  Ship the chip  ")).toEqual({ title: "Ship the chip" });
    expect(parseThreadSlash("/threads")).toBeNull();
    expect(parseThreadSlash("hello")).toBeNull();
  });
});

describe("new sheet", () => {
  it("offers the six starts, with plain-language consequences", () => {
    expect(NEW_SHEET_ITEMS.map((item) => item.id)).toEqual([
      "person",
      "agent",
      "thread",
      "channel",
      "project",
      "call",
    ]);
    expect(channelConsequence("public")).toMatch(/find this channel and join/i);
    expect(channelConsequence("private")).toMatch(/only people you invite/i);
    expect(projectChannelConsequence()).toMatch(/private/i);
    expect(guestLinkConsequence()).toMatch(/outside Unicorn Commander/i);
    expect(HUB_STARTER_PROMPTS).toHaveLength(3);
  });
});

describe("needs you", () => {
  it("counts a direct unread and a mention, not channel chatter", () => {
    const dm = room({ id: "dm", type: "dm" });
    const channel = room({ id: "ch", type: "channel" });
    expect(roomNeedsYou(dm, 3, false)).toBe(true);
    expect(roomNeedsYou(channel, 8, false)).toBe(false);
    expect(roomNeedsYou(channel, 8, true)).toBe(true);
    expect(roomNeedsYou(dm, 3, false, true)).toBe(false);
    expect(
      countNeedsYou(
        [dm, channel],
        { dm: 2, ch: 9 },
        { ch: false },
      ),
    ).toBe(1);
  });
});

describe("labels", () => {
  it("names an untitled group from its members", () => {
    const members: RoomMember[] = [
      {
        username: "aaron",
        display_name: "Aaron",
        role: "owner",
        is_self: true,
        joined_at: "",
      },
      {
        username: "persephone",
        display_name: "Persephone",
        role: "member",
        participant_type: "agent",
        joined_at: "",
      },
      {
        username: "rook",
        display_name: "Rook",
        role: "member",
        joined_at: "",
      },
    ];
    expect(
      roomLabel(room({ type: "group_dm", name: "group-ab", display_name: undefined }), members),
    ).toBe("Persephone, Rook");
  });

  it("formats the collapsed thread hint", () => {
    expect(olderArchivedLabel(3, 1)).toBe("+3 older · 1 archived");
    expect(olderArchivedLabel(0, 2)).toBe("2 archived");
    expect(olderArchivedLabel(0, 0)).toBeNull();
  });
});

describe("live room list", () => {
  it("inserts a thread stub and bumps the parent without dropping the row", () => {
    const parent = room({ id: "hub", type: "agent_hub", name: "Persephone", thread_count: 0 });
    const stub = threadStubFromEvent(
      { room_id: "th1", parent_room_id: "hub", display_name: null },
      parent,
    );
    expect(stub.name).toBe("New thread");
    expect(stub.type).toBe("agent_hub");
    const next = noteThreadOnParent([parent], "hub", stub);
    expect(next.map((r) => r.id)).toEqual(["th1", "hub"]);
    expect(next.find((r) => r.id === "hub")?.thread_count).toBe(1);
    const replaced = upsertRoomList(next, { ...stub, name: "Ship the chip", display_name: "Ship the chip" });
    expect(replaced.find((r) => r.id === "th1")?.name).toBe("Ship the chip");
    expect(replaced).toHaveLength(2);
  });
});

describe("othersInRoom", () => {
  it("drops the caller by the server's is_self, not by an id that never matches", () => {
    const me = { participant_id: "p-aaron", user_id: null, is_self: true, display_name: "Aaron" };
    const seat = { participant_id: "p-persephone", user_id: null, display_name: "Persephone", participant_type: "agent" };
    // The Keycloak id is not a participant id: the comparison alone kept the human in.
    expect(othersInRoom([me, seat], "dev-user-001").map((p) => p.participant_id)).toEqual(["p-persephone"]);
    // Rows without the flag still fall back to the id comparison.
    const legacyMe = { participant_id: "dev-user-001", display_name: "Aaron" };
    expect(othersInRoom([legacyMe, seat], "dev-user-001").map((p) => p.participant_id)).toEqual(["p-persephone"]);
  });
});

