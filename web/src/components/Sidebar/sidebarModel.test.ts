import { describe, expect, it } from "vitest";
import type { Room } from "@/services/api";
import {
  buildSidebarModel,
  flattenSidebarOrder,
  isPrivateChannel,
  roomsForView,
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
