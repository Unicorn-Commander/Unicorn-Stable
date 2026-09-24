import { describe, expect, it } from "vitest";
import type { Message, Room } from "@/services/api";
import {
  buildConversationRows,
  buildSidebarModel,
  conversationShape,
  flattenConversationRows,
  flattenSidebarOrder,
  groupFaceRoom,
  isPrivateChannel,
  roomsForView,
  roomsOnConversationRow,
  type SidebarRow,
} from "./sidebarModel";

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

const empty = {
  searchQuery: "",
  scope: null,
  categories: {},
  people: {},
  folders: {},
  collapsed: {},
  expandedPeople: {},
};

describe("sidebar nesting", () => {
  const hub = room({
    id: "hub",
    name: "Persephone",
    type: "agent_hub",
    brigade_agent_id: "persephone",
    updated_at: "2026-09-21T01:00:00Z",
    agent_members: [
      {
        participant_id: "p",
        agent_id: "persephone",
        display_name: "Persephone",
        agent_mode: "answers_all",
      },
    ],
  });
  const newest = room({
    id: "t-new",
    name: "Launch copy",
    type: "agent_hub",
    parent_room_id: "hub",
    brigade_agent_id: "persephone",
    updated_at: "2026-09-21T03:00:00Z",
  });
  const older = room({
    id: "t-old",
    name: "Yesterday",
    type: "agent_hub",
    parent_room_id: "hub",
    brigade_agent_id: "persephone",
    updated_at: "2026-09-21T02:00:00Z",
  });
  const archived = room({
    id: "t-arch",
    name: "Old",
    type: "agent_hub",
    parent_room_id: "hub",
    is_archived: true,
  });
  const person = room({
    id: "dm",
    name: "Pat",
    type: "dm",
    counterpart: {
      participant_id: "pat",
      kind: "human",
      display_name: "Pat Lee",
    },
  });
  const dmThread = room({
    id: "dm-t",
    name: "Side question",
    type: "dm",
    parent_room_id: "dm",
  });
  const group = room({
    id: "g",
    name: "group-xyz",
    display_name: undefined,
    type: "group_dm",
  });
  const groupThread = room({
    id: "g-t",
    name: "Plan",
    type: "group_dm",
    parent_room_id: "g",
  });
  const pub = room({ id: "pub", name: "general", type: "channel", visibility: "public" });
  const priv = room({
    id: "priv",
    name: "leadership",
    type: "channel",
    visibility: "private",
  });
  const project = room({
    id: "proj",
    name: "p-00115-stable",
    type: "channel",
    visibility: "private",
    project_number: "P-00115",
  });
  const channelThread = room({
    id: "ch-t",
    name: "Incident",
    type: "channel",
    parent_room_id: "proj",
  });

  const all = [newest, older, hub, person, dmThread, group, groupThread, pub, priv, project, channelThread, archived];

  it("nests threads under a hub, a DM, a group, and a channel", () => {
    const model = buildSidebarModel({ rooms: all, ...empty, view: "direct" });
    const people = model.sections[0].groups.flatMap((g) => g.rows);
    const hubRow = people.find((row) => row.kind === "person" && row.entry.kind === "agent");
    expect(hubRow && hubRow.kind === "person" && hubRow.entry.kind === "agent" && hubRow.entry.agentId).toBe(
      "persephone",
    );
    if (hubRow?.kind === "person" && hubRow.entry.kind === "agent") {
      expect(hubRow.entry.threads.map((t) => t.id)).toEqual(["t-new", "t-old"]);
      // The row badge uses this set: the hub plus the threads, even when the
      // expanded list is only the children.
      expect(roomsOnConversationRow(hubRow).map((t) => t.id)).toEqual([
        "hub",
        "t-new",
        "t-old",
      ]);
      expect(hubRow.entry.archivedCount).toBe(1);
      expect(hubRow.entry.mode).toBe("answers_all");
      expect(hubRow.entry.hub.id).toBe("hub");
    }
    const pat = people.find((row) => row.kind === "person" && row.entry.kind === "person");
    if (pat?.kind === "person" && pat.entry.kind === "person") {
      expect(pat.entry.name).toBe("Pat Lee");
      expect(pat.entry.threads.map((t) => t.id)).toEqual(["dm", "dm-t"]);
    }
    const groups = model.sections[1].groups.flatMap((g) => g.rows);
    expect(groups).toHaveLength(1);
    if (groups[0]?.kind === "group") {
      expect(groups[0].threads.map((t) => t.id)).toEqual(["g-t"]);
    }

    const channels = buildSidebarModel({ rooms: all, ...empty, view: "channels" });
    const channelRows = channels.sections[2].groups.flatMap((g) => g.rows);
    const projectRow = channelRows.find((row) => row.kind === "channel" && row.room.id === "proj");
    expect(projectRow && projectRow.kind === "channel" && projectRow.room.project_number).toBe("P-00115");
    if (projectRow?.kind === "channel") {
      expect(projectRow.threads.map((t) => t.id)).toEqual(["ch-t"]);
      expect(isPrivateChannel(projectRow.room)).toBe(true);
    }
    expect(channelRows.some((row) => row.kind === "channel" && row.room.id === "ch-t")).toBe(false);
    const privateRow = channelRows.find((row) => row.kind === "channel" && row.room.id === "priv");
    expect(privateRow && privateRow.kind === "channel" && isPrivateChannel(privateRow.room)).toBe(true);
  });

  it("walks expanded threads and collapses them to one stop", () => {
    const collapsed = buildSidebarModel({ rooms: all, ...empty, view: "direct" });
    const collapsedOrder = flattenSidebarOrder(collapsed);
    const hubStop = collapsedOrder.find((ids) => ids.includes("t-new"));
    expect(hubStop?.[0]).toBe("t-new");
    expect(hubStop).toContain("t-old");
    expect(hubStop).toHaveLength(1 + 1); // one keyboard stop carrying both ids

    const expanded = buildSidebarModel({
      rooms: all,
      ...empty,
      view: "channels",
      expandedPeople: { proj: true },
    });
    const order = flattenSidebarOrder(expanded);
    const projAt = order.findIndex((ids) => ids[0] === "proj");
    expect(order[projAt]).toEqual(["proj"]);
    expect(order[projAt + 1]).toEqual(["ch-t"]);
  });

  it("keeps the Home chats alias on human DMs only", () => {
    const ids = roomsForView(all, "chats").map((r) => r.id);
    expect(ids).toContain("dm");
    expect(ids).toContain("dm-t");
    expect(ids).not.toContain("hub");
    expect(ids).not.toContain("t-new");
    expect(roomsForView(all, "agents").map((r) => r.id)).toEqual(
      expect.arrayContaining(["hub", "t-new", "t-old"]),
    );
    expect(roomsForView(all, "direct").map((r) => r.id)).toEqual(
      expect.arrayContaining(["hub", "dm", "g", "t-new"]),
    );
  });
});

function rowId(row: SidebarRow): string {
  return row.kind === "person" ? row.entry.hub.id : row.room.id;
}

describe("one conversation list", () => {
  const base = {
    searchQuery: "",
    scope: null,
    categories: {},
    people: {},
    folders: {},
    expandedPeople: {},
  };
  const unreadOld = room({
    id: "dm-old",
    name: "Pat",
    type: "dm",
    unread_count: 2,
    updated_at: "2026-09-01T00:00:00Z",
    counterpart: {
      participant_id: "pat",
      kind: "human",
      display_name: "Pat Lee",
    },
  });
  const readNew = room({
    id: "general",
    name: "general",
    type: "channel",
    visibility: "public",
    unread_count: 0,
    updated_at: "2026-09-24T12:00:00Z",
  });
  const standing = room({
    id: "war",
    name: "war-room",
    type: "channel",
    is_conference: true,
    unread_count: 0,
    updated_at: "2026-09-24T08:00:00Z",
  });
  const crew = room({
    id: "crew",
    name: "crew",
    display_name: "Crew",
    type: "group_dm",
    unread_count: 0,
    updated_at: "2026-09-20T00:00:00Z",
  });
  const hub = room({
    id: "hub-p",
    name: "Persephone",
    type: "agent_hub",
    brigade_agent_id: "persephone",
    unread_count: 1,
    updated_at: "2026-09-10T00:00:00Z",
    counterpart: {
      participant_id: "p-persephone",
      kind: "agent",
      display_name: "Persephone",
      agent_id: "persephone",
    },
  });
  const thread = room({
    id: "war-thread",
    name: "Incident",
    type: "channel",
    parent_room_id: "war",
    updated_at: "2026-09-24T18:00:00Z",
  });
  const locked = room({
    id: "leadership",
    name: "leadership",
    type: "channel",
    visibility: "private",
    unread_count: 0,
    updated_at: "2026-09-02T00:00:00Z",
  });
  const rooms = [readNew, unreadOld, standing, crew, hub, thread, locked];
  const isUnread = (candidate: { unread_count?: number }) =>
    (candidate.unread_count ?? 0) > 0;

  it("orders unread first, then recency, and keeps threads inside the parent", () => {
    const rows = buildConversationRows({
      ...base,
      rooms,
      filter: "all",
      isUnread,
    });
    // Unread first (hub is the newer unread). Then recency, and a thread's
    // activity counts for its parent — war's child is newer than #general.
    expect(rows.map(rowId)).toEqual([
      "hub-p",
      "dm-old",
      "war",
      "general",
      "crew",
      "leadership",
    ]);
    expect(rows.map(conversationShape)).toEqual([
      "direct",
      "direct",
      "channel",
      "channel",
      "group",
      "channel",
    ]);
    expect(rows.map(rowId)).not.toContain("war-thread");
    const war = rows.find((row) => rowId(row) === "war");
    expect(war?.kind === "channel" && war.threads.map((t) => t.id)).toEqual([
      "war-thread",
    ]);
    const lockedRow = rows.find((row) => rowId(row) === "leadership");
    expect(
      lockedRow?.kind === "channel" && isPrivateChannel(lockedRow.room),
    ).toBe(true);
    expect(standing.is_conference).toBe(true);
    expect(conversationShape(rows.find((row) => rowId(row) === "war")!)).toBe(
      "channel",
    );
  });

  it("treats All, Unread, People, and Channels as filters on that one list", () => {
    const people = buildConversationRows({
      ...base,
      rooms,
      filter: "people",
      isUnread,
    }).map(rowId);
    expect(people).toEqual(["hub-p", "dm-old", "crew"]);
    const channels = buildConversationRows({
      ...base,
      rooms,
      filter: "channels",
      isUnread,
    }).map(rowId);
    expect(channels).toEqual(["war", "general", "leadership"]);
    const unread = buildConversationRows({
      ...base,
      rooms,
      filter: "unread",
      isUnread,
    }).map(rowId);
    expect(unread).toEqual(["hub-p", "dm-old"]);
  });

  it("keeps the open room in the unread group so Alt+Down reaches the next unread", () => {
    // U1 was unread and is now open, so its badge is already cleared.
    // Without the pin it falls out of the unread group and Alt+↓ skips U2.
    const opened = [
      room({
        id: "U1",
        name: "U1",
        type: "dm",
        unread_count: 0,
        updated_at: "2026-09-24T05:00:00Z",
      }),
      room({
        id: "U2",
        name: "U2",
        type: "dm",
        unread_count: 2,
        updated_at: "2026-09-24T04:00:00Z",
      }),
      room({
        id: "R1",
        name: "R1",
        type: "channel",
        unread_count: 0,
        updated_at: "2026-09-24T03:00:00Z",
      }),
      room({
        id: "R2",
        name: "R2",
        type: "channel",
        unread_count: 0,
        updated_at: "2026-09-24T02:00:00Z",
      }),
      room({
        id: "R3",
        name: "R3",
        type: "channel",
        unread_count: 0,
        updated_at: "2026-09-24T01:00:00Z",
      }),
    ];
    const stillUnread = (candidate: { unread_count?: number }) =>
      (candidate.unread_count ?? 0) > 0;
    const dropped = buildConversationRows({
      ...base,
      rooms: opened,
      filter: "all",
      isUnread: stillUnread,
    }).map(rowId);
    expect(dropped).toEqual(["U2", "U1", "R1", "R2", "R3"]);

    const pinned = buildConversationRows({
      ...base,
      rooms: opened,
      filter: "all",
      isUnread: stillUnread,
      activeRoomId: "U1",
    });
    expect(pinned.map(rowId)).toEqual(["U1", "U2", "R1", "R2", "R3"]);
    const order = flattenConversationRows(pinned);
    const at = order.findIndex((ids) => ids.includes("U1"));
    expect(at).toBe(0);
    expect(order[at + 1]?.[0]).toBe("U2");

    const unreadFilter = buildConversationRows({
      ...base,
      rooms: opened,
      filter: "unread",
      isUnread: stillUnread,
      activeRoomId: "U1",
    }).map(rowId);
    expect(unreadFilter).toEqual(["U1", "U2"]);
  });

  it("does not use the current user as a group's last-sender fallback", () => {
    const last: Message = {
      id: "m",
      room_id: "g",
      sender_id: "me",
      sender_type: "human",
      sender_name: "Me",
      sender_avatar: null,
      content: "hi",
      content_type: "text",
      thread_id: null,
      reply_count: 0,
      edited: false,
      created_at: "2026-09-24T00:00:00Z",
      updated_at: "2026-09-24T00:00:00Z",
      metadata: {},
    };
    const crew = room({ id: "g", type: "group_dm", last_message: last });
    expect(groupFaceRoom(crew, ["me"]).last_message).toBeNull();
    expect(groupFaceRoom(crew, ["someone-else"]).last_message).toBe(last);
    expect(groupFaceRoom(crew, [null, undefined]).last_message).toBe(last);
  });
});
