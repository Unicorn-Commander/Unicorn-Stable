import { describe, expect, it } from "vitest";
import type { Agent, Room } from "@/services/api";
import { CREW_FIXTURE, PERSEPHONE_HUB_ID, ROOK_HUB_ID } from "@/mocks/crewFixture";
import {
  buildConversationRows,
  buildCrewSection,
  flattenConversationPane,
  flattenConversationRows,
  flattenCrewRows,
  SECTION_KEYS,
} from "./sidebarModel";

function room(over: Partial<Room> = {}): Room {
  return {
    id: "r",
    name: "room",
    description: "",
    type: "channel",
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
    member_count: 1,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...over,
  };
}

function hubFor(agentId: string, id: string, over: Partial<Room> = {}): Room {
  return room({
    id,
    name: agentId,
    type: "agent_hub",
    counterpart: {
      participant_id: `p-${agentId}`,
      kind: "agent",
      display_name: agentId,
      agent_id: agentId,
    },
    ...over,
  });
}

const persephoneHub = hubFor("persephone", PERSEPHONE_HUB_ID, {
  metadata_: {
    agent_hub: { human_id: "p-aaron", agent_id: "persephone" },
    seats: { persephone: { model: "claude-opus-5-5", effort: "medium" } },
  },
});
const rookHub = hubFor("claude-code", ROOK_HUB_ID);
const astraHub = hubFor("codex-astra", "hub-codex-astra");
const general = room({ id: "room-general", name: "general" });

const base = {
  crew: CREW_FIXTURE,
  rooms: [persephoneHub, rookHub],
  agents: [] as Agent[],
  searchQuery: "",
  showAll: false,
  collapsed: {},
};

const ids = (section: ReturnType<typeof buildCrewSection>) =>
  section.groups.flatMap((group) => group.rows.map((row) => row.member.agent_id));

describe("crew section model", () => {
  it("groups Your seats → House → Partners in server order and caps at eight", () => {
    const section = buildCrewSection(base);
    expect(section.groups.map((group) => group.group)).toEqual(["own_seat", "house"]);
    expect(section.groups[0]!.label).toBe("Your seats");
    expect(section.groups[0]!.rows.map((row) => row.member.agent_id)).toEqual([
      "persephone",
      "claude-code",
      "codex-astra",
      "grok",
      "zen",
      "claude",
    ]);
    expect(section.groups[1]!.rows.map((row) => row.member.agent_id)).toEqual([
      "majik",
      "sidekick",
    ]);
    expect(section.total).toBe(12);
    expect(section.hiddenCount).toBe(4);
    expect(section.searching).toBe(false);
  });

  it("More lifts the cap and the Partners group appears", () => {
    const section = buildCrewSection({ ...base, showAll: true });
    expect(section.groups.map((group) => group.group)).toEqual(["own_seat", "house", "partner"]);
    expect(section.hiddenCount).toBe(0);
    expect(section.groups[2]!.label).toBe("Partners");
    expect(section.groups[2]!.rows.map((row) => row.member.display_name)).toEqual([
      "Flow",
      "ShOX",
      "Okapi",
    ]);
  });

  it("never lists a guest agent or an integration, whatever the fixture holds", () => {
    const section = buildCrewSection({ ...base, showAll: true });
    for (const row of section.groups.flatMap((group) => group.rows)) {
      expect(["own_seat", "house", "partner"]).toContain(row.member.group);
      expect(row.member.agent_id).not.toMatch(/^webhook-|taxsq/);
    }
  });

  it("a search ignores the cap and matches name, id, role line and owner", () => {
    expect(ids(buildCrewSection({ ...base, searchQuery: "shafen" }))).toEqual([
      "shafen-claude-code",
      "shox",
      "okapi-grok",
    ]);
    const okapi = buildCrewSection({ ...base, searchQuery: "OKAPI" });
    expect(ids(okapi)).toEqual(["okapi-grok"]);
    expect(okapi.total).toBe(1);
    expect(okapi.hiddenCount).toBe(0);
    expect(okapi.searching).toBe(true);
    expect(ids(buildCrewSection({ ...base, searchQuery: "showrunner" }))).toEqual(["claude-code"]);
    expect(buildCrewSection({ ...base, searchQuery: "nobody" }).groups).toEqual([]);
  });

  it("brain chip: the hub's override beats the seat default; house rows read the roster family", () => {
    const majik = { id: "majik", model: "qwen3.6-35b-chat" } as Agent;
    const section = buildCrewSection({ ...base, showAll: true, agents: [majik] });
    const brain = (agentId: string) =>
      section.groups.flatMap((group) => group.rows).find((row) => row.member.agent_id === agentId)
        ?.brain;
    expect(brain("persephone")).toBe("Opus 5.5 · medium");
    expect(brain("claude-code")).toBe("Opus 5.5 · medium");
    expect(brain("codex-astra")).toBe("GPT-5 Codex · medium");
    expect(brain("zen")).toBe("Qwen 3.6 35B · medium");
    expect(brain("majik")).toBe("Qwen");
    expect(brain("sidekick")).toBeNull();
    // "claude" is a seat that has not announced its capabilities yet.
    expect(brain("claude")).toBeNull();
    // A partner's seat shows its brain too — read-only is the popover's job.
    expect(brain("shafen-claude-code")).toBe("Fable 5.1 · high");
  });

  it("resolves a hub from the room list when the server sent none", () => {
    const section = buildCrewSection({ ...base, showAll: true, rooms: [...base.rooms, astraHub] });
    const rows = section.groups.flatMap((group) => group.rows);
    expect(rows.find((row) => row.member.agent_id === "codex-astra")?.roomId).toBe("hub-codex-astra");
    expect(rows.find((row) => row.member.agent_id === "persephone")?.roomId).toBe(PERSEPHONE_HUB_ID);
    expect(rows.find((row) => row.member.agent_id === "grok")?.roomId).toBeNull();
  });

  it("collapses under its own section key", () => {
    const section = buildCrewSection({ ...base, collapsed: { [SECTION_KEYS.crew]: true } });
    expect(section.collapsed).toBe(true);
    expect(section.collapseKey).toBe("section:crew");
    expect(section.groups.length).toBeGreaterThan(0);
  });
});

describe("crew keyboard order", () => {
  it("walks the visible crew hubs, skipping rows with no hub and a collapsed section", () => {
    const section = buildCrewSection({ ...base, showAll: true, rooms: [...base.rooms, astraHub] });
    expect(flattenCrewRows(section)).toEqual([[PERSEPHONE_HUB_ID], [ROOK_HUB_ID], ["hub-codex-astra"]]);
    const capped = buildCrewSection({ ...base, rooms: [...base.rooms, astraHub] });
    expect(flattenCrewRows(capped)).toEqual([[PERSEPHONE_HUB_ID], [ROOK_HUB_ID], ["hub-codex-astra"]]);
    const shut = buildCrewSection({ ...base, collapsed: { [SECTION_KEYS.crew]: true } });
    expect(flattenCrewRows(shut)).toEqual([]);
  });

  it("puts the crew before the one list, and the list alone on a phone", () => {
    const rooms = [persephoneHub, rookHub, general];
    const listRows = buildConversationRows({
      rooms,
      searchQuery: "",
      scope: null,
      categories: {},
      people: {},
      folders: {},
      expandedPeople: {},
      filter: "all",
      isUnread: () => false,
    });
    const listOrder = flattenConversationRows(listRows);
    expect(listOrder.length).toBe(3);
    const section = buildCrewSection({ ...base, rooms });
    const pane = flattenConversationPane(section, listRows);
    expect(pane.slice(0, 2)).toEqual([[PERSEPHONE_HUB_ID], [ROOK_HUB_ID]]);
    expect(pane.slice(2)).toEqual(listOrder);
    expect(flattenConversationPane(null, listRows)).toEqual(listOrder);
  });
});
