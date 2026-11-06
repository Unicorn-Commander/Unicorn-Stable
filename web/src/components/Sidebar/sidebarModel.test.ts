import { describe, expect, it } from "vitest";
import type { Message, Room, RoomMember } from "@/services/api";
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
import { isAgentConversation, roomTitle, roomTypeLabel } from "@/lib/conversation";

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

function message(content: string, id = "m-thread"): Message {
  return {
    id,
    room_id: "thread",
    sender_id: "p-morgan",
    sender_type: "human",
    sender_name: "Morgan Vale",
    sender_avatar: null,
    content,
    content_type: "text",
    thread_id: null,
    reply_count: 0,
    edited: false,
    created_at: "2026-09-21T04:00:00Z",
    updated_at: "2026-09-21T04:00:00Z",
    metadata: {},
  };
}

const bureauMembers: RoomMember[] = [
  {
    participant_id: "p-alex",
    username: "alex",
    display_name: "Alex Rivera",
    role: "owner",
    participant_type: "human",
    is_self: true,
    joined_at: "",
  },
  {
    participant_id: "p-morgan",
    username: "morgan",
    display_name: "Morgan Vale",
    role: "member",
    participant_type: "human",
    joined_at: "",
  },
  {
    participant_id: "p-persephone",
    username: "persephone",
    display_name: "Persephone",
    role: "member",
    participant_type: "agent",
    joined_at: "",
  },
  {
    participant_id: "p-claude-code-app",
    username: "claude-code-app",
    display_name: "Claude Code App",
    role: "member",
    participant_type: "agent",
    joined_at: "",
  },
];

const bureau = room({
  id: "bureau-of-readiness-magic-unicorn",
  name: "bureau-of-readiness-magic-unicorn",
  display_name: "Bureau of Readiness · Magic Unicorn",
  type: "group_dm",
  member_count: 3,
  members: [bureauMembers[0]!, bureauMembers[2]!, bureauMembers[3]!],
  agent_members: [
    {
      participant_id: "p-persephone",
      agent_id: "persephone",
      display_name: "Persephone",
      agent_mode: "answers_all",
    },
    {
      participant_id: "p-claude-code-app",
      agent_id: "claude-code-app",
      display_name: "Claude Code App",
      agent_mode: "when_named",
    },
  ],
  metadata_: {
    bridge_pair: "persephone:claude-code-app",
    bridge_purpose: "readiness",
  },
});

const humanGroup = room({
  id: "readiness-working-group",
  name: "readiness-working-group",
  display_name: "Readiness Working Group",
  type: "group_dm",
  member_count: 3,
  members: [bureauMembers[0]!, bureauMembers[1]!, bureauMembers[2]!],
  agent_members: [bureau.agent_members![0]!],
  metadata_: {
    bridge_pair: "persephone:readiness-working-group",
    bridge_purpose: "readiness",
  },
});

const bureauThread = room({
  id: "bureau-of-readiness-magic-unicorn-t-brief",
  name: "bureau-of-readiness-magic-unicorn-t-brief",
  type: "group_dm",
  parent_room_id: bureau.id,
  display_name: "New thread",
  first_message: message(
    "Prepare the Bureau of Readiness morning brief with the customer-call decisions and next steps.",
    "m-bureau-first",
  ),
  last_message: message("The morning brief is ready.", "m-bureau-last"),
});

const emptyBureauThread = room({
  id: "bureau-of-readiness-magic-unicorn-t-empty",
  name: "bureau-of-readiness-magic-unicorn-t-empty",
  type: "group_dm",
  parent_room_id: bureau.id,
  display_name: "New thread",
  updated_at: "2026-09-22T05:00:00Z",
  first_message: null,
  last_message: null,
});

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
    const model = buildSidebarModel({ rooms: all, ...empty, view: "all" });
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
    const collapsed = buildSidebarModel({ rooms: all, ...empty, view: "all" });
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
      expect.arrayContaining(["dm", "g", "dm-t", "g-t"]),
    );
    expect(roomsForView(all, "direct").map((r) => r.id)).not.toContain("hub");
    expect(roomsForView(all, "direct").map((r) => r.id)).not.toContain("t-new");
  });
});

describe("Bureau-shaped room findability", () => {
  const rooms = [bureauThread, emptyBureauThread, bureau, humanGroup];

  it("uses the display name and keeps bridge metadata out of titles", () => {
    expect(roomTitle(bureau, bureauMembers)).toBe(
      "Bureau of Readiness · Magic Unicorn",
    );
    expect(
      roomTitle({ ...bureau, display_name: undefined }, bureauMembers),
    ).toBe("bureau-of-readiness-magic-unicorn");
    expect(roomTypeLabel(bureau)).toBe("Group");
    expect(roomTypeLabel(room({ type: "agent_hub" }))).toBe("Agent hub");
    expect(roomTypeLabel(room({ type: "channel", is_conference: true }))).toBe(
      "Meeting",
    );
  });

  it("places a human group with agents in Direct, not Agents", () => {
    expect(isAgentConversation(bureau)).toBe(false);
    expect(isAgentConversation(humanGroup)).toBe(false);

    const directIds = roomsForView(rooms, "direct").map((candidate) => candidate.id);
    expect(directIds).toEqual(
      expect.arrayContaining([humanGroup.id]),
    );
    // A titled group (the Bureau call room: one human, two agents, named by
    // the bridge) is a group too, and its threads follow it.
    expect(directIds).toContain(bureau.id);
    expect(directIds).toContain(bureauThread.id);

    const agentIds = roomsForView(rooms, "agents").map((candidate) => candidate.id);
    expect(agentIds).not.toContain(bureau.id);
    expect(agentIds).not.toContain(bureauThread.id);
    expect(agentIds).not.toContain(emptyBureauThread.id);
    expect(agentIds).not.toContain(humanGroup.id);
  });

  it("titles and nests threads by first message, with empty threads last", () => {
    expect(roomTitle(bureauThread)).toBe(
      "Prepare the Bureau of Readiness morning brief with the cust…",
    );
    expect(roomTitle(emptyBureauThread)).toBe("New thread");

    const model = buildSidebarModel({
      rooms,
      ...empty,
      view: "direct",
      expandedPeople: { [bureau.id]: true },
    });
    const groupRow = model.sections
      .flatMap((section) => section.groups)
      .flatMap((group) => group.rows)
      .find((candidate) => candidate.kind === "group" && candidate.room.id === bureau.id);
    expect(groupRow && groupRow.kind === "group" && groupRow.threads.map((thread) => thread.id)).toEqual([
      bureauThread.id,
      emptyBureauThread.id,
    ]);

    const order = flattenSidebarOrder(model);
    const bureauAt = order.findIndex((ids) => ids[0] === bureau.id);
    expect(order[bureauAt]).toEqual([bureau.id]);
    expect(order[bureauAt + 1]).toEqual([bureauThread.id]);
    expect(order[bureauAt + 2]).toEqual([emptyBureauThread.id]);
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
