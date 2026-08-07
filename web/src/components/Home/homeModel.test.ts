import { describe, expect, it } from "vitest";
import type { Message, PendingApproval, Room } from "@/services/api";
import {
  LIVE_MEETING_MS,
  agentFeed,
  agentsSegment,
  buildRevision,
  channelsByActivity,
  defaultConversationsTab,
  humanChatsByActivity,
  liveConferences,
  overallTone,
  priorityModel,
  serviceEntries,
  unreadCountFor,
} from "./homeModel";

const NOW = new Date("2026-08-07T12:00:00Z").getTime();

function message(
  partial: Partial<Message> & { created_at: string },
): Message {
  return {
    id: `m-${partial.created_at}`,
    room_id: "r",
    sender_id: "s1",
    sender_type: "human",
    sender_name: "Sender",
    sender_avatar: null,
    content: "hello",
    content_type: "text",
    thread_id: null,
    reply_count: 0,
    edited: false,
    updated_at: partial.created_at,
    metadata: {},
    ...partial,
  };
}

function room(
  partial: Partial<Room> & { id: string; type: Room["type"] },
): Room {
  return {
    name: partial.id,
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    member_count: 2,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...partial,
  };
}

/** A room whose activity is `minutesAgo` old (via last_message). */
function activeRoom(
  minutesAgo: number,
  partial: Partial<Room> & { id: string; type: Room["type"] },
): Room {
  const at = new Date(NOW - minutesAgo * 60_000).toISOString();
  return room({
    last_message: message({ created_at: at, room_id: partial.id }),
    ...partial,
  });
}

function approval(id: string): PendingApproval {
  return {
    room_id: `room-${id}`,
    room_name: `Room ${id}`,
    message: message({ id, created_at: "2026-08-07T11:00:00Z" }),
  };
}

describe("unreadCountFor", () => {
  it("prefers the live store value over the snapshot", () => {
    const r = room({ id: "a", type: "dm", unread_count: 3 });
    expect(unreadCountFor(r, { a: 7 })).toBe(7);
    expect(unreadCountFor(r, {})).toBe(3);
  });
});

describe("priorityModel", () => {
  it("interleaves mentions → DM unreads → approvals → channel unreads", () => {
    const rooms = [
      activeRoom(5, { id: "mention", type: "channel" }),
      activeRoom(10, { id: "dm", type: "dm", unread_count: 2 }),
      activeRoom(15, { id: "chan", type: "channel", unread_count: 4 }),
    ];
    const model = priorityModel({
      rooms,
      unreadCounts: {},
      mentionUnreads: { mention: true },
      approvals: [approval("ap1")],
    });
    expect(model.items.map((i) => i.kind)).toEqual([
      "mention",
      "dm",
      "approval",
      "channel",
    ]);
  });

  it("dedupes a mention-flagged channel out of the channel group", () => {
    const rooms = [
      activeRoom(5, { id: "busy", type: "channel", unread_count: 40 }),
    ];
    const model = priorityModel({
      rooms,
      unreadCounts: {},
      mentionUnreads: { busy: true },
      approvals: [],
    });
    expect(model.items).toHaveLength(1);
    expect(model.items[0]?.kind).toBe("mention");
    expect(model.channelUnreadRooms).toHaveLength(0);
  });

  it("keeps agent-room unreads out of every priority group (they are W5's)", () => {
    const rooms = [
      activeRoom(5, {
        id: "agent",
        type: "dm",
        brigade_agent_id: "majik",
        unread_count: 3,
      }),
    ];
    const model = priorityModel({
      rooms,
      unreadCounts: {},
      mentionUnreads: {},
      approvals: [],
    });
    expect(model.items).toHaveLength(0);
  });

  it("caps channel unreads and reports the overflow", () => {
    const rooms = Array.from({ length: 7 }, (_, i) =>
      activeRoom(i, { id: `c${i}`, type: "channel", unread_count: 1 }),
    );
    const model = priorityModel({
      rooms,
      unreadCounts: {},
      mentionUnreads: {},
      approvals: [],
    });
    expect(model.channelUnreadRooms).toHaveLength(5);
    expect(model.moreChannelCount).toBe(2);
    // Recency order within the group: c0 is newest.
    expect(model.channelUnreadRooms[0]?.id).toBe("c0");
  });

  it("reads unread through the live override map", () => {
    const rooms = [activeRoom(1, { id: "c1", type: "channel", unread_count: 0 })];
    const model = priorityModel({
      rooms,
      unreadCounts: { c1: 6 },
      mentionUnreads: {},
      approvals: [],
    });
    expect(model.items).toEqual([
      expect.objectContaining({ kind: "channel", unread: 6 }),
    ]);
  });
});

describe("agentFeed", () => {
  const agentMsg = (minutesAgo: number, roomId: string) =>
    message({
      created_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
      room_id: roomId,
      sender_type: "agent",
      sender_name: "Majik",
    });

  it("splits waiting (agent rooms with unread) from recent activity", () => {
    const rooms = [
      room({
        id: "waiting",
        type: "dm",
        brigade_agent_id: "majik",
        unread_count: 2,
        last_message: agentMsg(5, "waiting"),
      }),
      room({
        id: "recent",
        type: "channel",
        last_message: agentMsg(10, "recent"),
      }),
    ];
    const feed = agentFeed(rooms, {});
    expect(feed.waiting.map((r) => r.id)).toEqual(["waiting"]);
    expect(feed.recent.map((r) => r.id)).toEqual(["recent"]);
  });

  it("excludes waiting rooms from recent even beyond the waiting cap", () => {
    const rooms = Array.from({ length: 7 }, (_, i) =>
      room({
        id: `w${i}`,
        type: "dm",
        brigade_agent_id: "majik",
        unread_count: 1,
        last_message: agentMsg(i, `w${i}`),
      }),
    );
    const feed = agentFeed(rooms, {});
    expect(feed.waiting).toHaveLength(5);
    expect(feed.waitingTotal).toBe(7);
    // w5/w6 fell off the visible waiting list but must NOT reappear as
    // plain activity — they are still waiting on the human.
    expect(feed.recent).toHaveLength(0);
  });

  it("only counts agent-authored last messages as activity", () => {
    const rooms = [
      room({
        id: "human",
        type: "channel",
        last_message: message({
          created_at: "2026-08-07T11:00:00Z",
          sender_type: "human",
        }),
      }),
      room({
        id: "system",
        type: "channel",
        last_message: message({
          created_at: "2026-08-07T11:00:00Z",
          sender_type: "system",
        }),
      }),
      room({ id: "silent", type: "channel" }),
    ];
    expect(agentFeed(rooms, {}).recent).toHaveLength(0);
  });

  it("sorts recent activity newest first and caps it", () => {
    const rooms = Array.from({ length: 12 }, (_, i) =>
      room({ id: `r${i}`, type: "channel", last_message: agentMsg(i, `r${i}`) }),
    );
    const feed = agentFeed(rooms, {});
    expect(feed.recent).toHaveLength(10);
    expect(feed.recent[0]?.id).toBe("r0");
  });
});

describe("conversation lists", () => {
  const rooms = [
    activeRoom(1, { id: "chan", type: "channel" }),
    activeRoom(2, { id: "conf", type: "channel", is_conference: true }),
    activeRoom(3, { id: "dm", type: "dm" }),
    activeRoom(4, { id: "agent", type: "dm", brigade_agent_id: "majik" }),
    activeRoom(5, { id: "group", type: "group_dm" }),
  ];

  it("chats = human DMs + private groups only", () => {
    expect(humanChatsByActivity(rooms).map((r) => r.id)).toEqual([
      "dm",
      "group",
    ]);
  });

  it("channels exclude conference rooms and non-channels", () => {
    expect(channelsByActivity(rooms).map((r) => r.id)).toEqual(["chan"]);
  });

  it("defaults the tab to the side with newer top activity", () => {
    const chats = humanChatsByActivity(rooms);
    const channels = channelsByActivity(rooms);
    // Channel activity (1m ago) is newer than the newest chat (3m ago).
    expect(defaultConversationsTab(chats, channels)).toBe("channels");
    expect(defaultConversationsTab(chats, [])).toBe("chats");
    expect(defaultConversationsTab([], [])).toBe("chats");
  });
});

describe("liveConferences", () => {
  it("keeps conferences inside the heuristic window, drops stale ones", () => {
    const fresh = activeRoom(30, {
      id: "fresh",
      type: "channel",
      is_conference: true,
    });
    const stale = activeRoom(LIVE_MEETING_MS / 60_000 + 10, {
      id: "stale",
      type: "channel",
      is_conference: true,
    });
    const live = liveConferences({
      rooms: [fresh, stale],
      unreadCounts: {},
      activeCallRoomId: null,
      hasActiveCall: false,
      now: NOW,
    });
    expect(live.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("keeps a stale conference alive when it still has unread", () => {
    const stale = activeRoom(LIVE_MEETING_MS / 60_000 + 10, {
      id: "stale",
      type: "channel",
      is_conference: true,
      unread_count: 2,
    });
    const live = liveConferences({
      rooms: [stale],
      unreadCounts: {},
      activeCallRoomId: null,
      hasActiveCall: false,
      now: NOW,
    });
    expect(live.map((r) => r.id)).toEqual(["stale"]);
  });

  it("hides the room the user is already in a call with", () => {
    const active = activeRoom(1, {
      id: "active",
      type: "channel",
      is_conference: true,
    });
    const live = liveConferences({
      rooms: [active],
      unreadCounts: {},
      activeCallRoomId: "active",
      hasActiveCall: true,
      now: NOW,
    });
    expect(live).toHaveLength(0);
  });
});

describe("health strip semantics", () => {
  it("aggregates worst-of: warn > unknown > ok", () => {
    expect(overallTone(["ok", "ok", "ok", "ok"])).toBe("ok");
    expect(overallTone(["ok", "unknown", "ok", "ok"])).toBe("unknown");
    expect(overallTone(["ok", "unknown", "warn", "ok"])).toBe("warn");
    expect(overallTone([])).toBe("unknown");
  });

  it("treats explicitly-off features as healthy, not unknown", () => {
    expect(overallTone(["ok", "ok", "ok", "off"])).toBe("ok");
    expect(overallTone(["off", "unknown", "ok", "ok"])).toBe("unknown");
  });

  it("agents segment never lights green from absence of data", () => {
    expect(agentsSegment([]).tone).toBe("unknown");
    expect(agentsSegment([{}, {}]).tone).toBe("unknown");
    expect(agentsSegment([{ availability: "unknown" }]).tone).toBe("unknown");
  });

  it("agents segment counts explicit availability", () => {
    expect(
      agentsSegment([
        { availability: "available" },
        { availability: "available" },
        { availability: "unavailable" },
      ]),
    ).toEqual({ tone: "ok", label: "2 available" });
  });

  it("agents segment treats a fully-unavailable roster as a real warning", () => {
    expect(
      agentsSegment([
        { availability: "unavailable" },
        { availability: "unavailable" },
      ]).tone,
    ).toBe("warn");
    // …but one silent agent among unavailable ones is no longer a certain
    // outage, so the segment falls back to unknown.
    expect(
      agentsSegment([{ availability: "unavailable" }, {}]).tone,
    ).toBe("unknown");
  });

  it("flattens mixed-shape service states for the tooltip", () => {
    expect(
      serviceEntries({
        database: "ready",
        observability: { state: "enabled", required: false },
        build: { revision: "abc123" },
        weird: 42,
      }),
    ).toEqual([
      { name: "database", state: "ready" },
      { name: "observability", state: "enabled" },
    ]);
  });

  it("extracts a short build revision when present", () => {
    expect(buildRevision({ build: { revision: "0619b9f2adae" } })).toBe(
      "0619b9f",
    );
    expect(buildRevision({ build: {} })).toBeNull();
    expect(buildRevision({})).toBeNull();
    expect(buildRevision(undefined)).toBeNull();
  });
});
