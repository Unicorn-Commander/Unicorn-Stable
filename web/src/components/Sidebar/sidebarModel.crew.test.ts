import { describe, expect, it } from "vitest";
import type { Agent, CrewMember, Room } from "@/services/api";
import { CREW_FIXTURE, PERSEPHONE_HUB_ID, ROOK_HUB_ID } from "@/mocks/crewFixture";
import {
  buildConversationRows,
  buildCrewSection,
  CREW_CAP_POLICY,
  defaultCrewSet,
  flattenConversationPane,
  flattenConversationRows,
  flattenCrewRows,
  SECTION_KEYS,
  stepKeyboardOrder,
} from "./sidebarModel";

const SELF = ["p-aaron"];
const NOW = Date.parse("2026-09-28T22:00:00Z");

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
    metadata_: { agent_hub: { human_id: "p-aaron", agent_id: agentId } },
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
const general = room({ id: "room-general", name: "general" });
const taxsq = room({
  id: "room-taxsq",
  name: "taxsq-portal",
  updated_at: "2026-09-28T11:00:00Z",
  agent_members: [
    { participant_id: "p-shafen-claude-code", agent_id: "shafen-claude-code", display_name: "Flow" },
  ],
});

const base = {
  crew: CREW_FIXTURE,
  rooms: [persephoneHub, rookHub],
  agents: [] as Agent[],
  searchQuery: "",
  showAll: false,
  collapsed: {},
  selfIds: SELF,
  now: NOW,
};

const ids = (section: ReturnType<typeof buildCrewSection>) =>
  section.groups.flatMap((group) => group.rows.map((row) => row.member.agent_id));

describe("crew section model", () => {
  it("shows the seats heard from lately, the top house agents and the top partners before More", () => {
    // Fixture: Persephone and Rook have a last line this week; four other seats
    // never spoke and fold. House and Partners each show three, so acceptance 3
    // holds on the first view — eight rows, which keeps six conversations on a
    // 1440×900 desktop.
    const section = buildCrewSection(base);
    expect(section.groups.map((group) => [group.group, group.rows.map((row) => row.member.agent_id)])).toEqual([
      ["own_seat", ["persephone", "claude-code"]],
      ["house", ["majik", "sidekick", "the-general"]],
      ["partner", ["shafen-claude-code", "shox", "okapi-grok"]],
    ]);
    expect(section.total).toBe(12);
    expect(section.hiddenCount).toBe(4);
    expect(section.expanded).toBe(false);
    expect(section.searching).toBe(false);
  });

  it("caps per group, never across groups", () => {
    const eleven: CrewMember[] = Array.from({ length: 11 }, (_, i) => ({
      ...CREW_FIXTURE[0]!,
      agent_id: `seat-${i}`,
      display_name: `Seat ${i}`,
      hub_room_id: null,
      last_at: "2026-09-27T00:00:00Z",
      unread: 0,
    }));
    const crew = [...eleven, ...CREW_FIXTURE.filter((m) => m.group !== "own_seat")];
    const shown = defaultCrewSet(crew, CREW_CAP_POLICY, NOW);
    expect([...shown].filter((id) => id.startsWith("seat-"))).toHaveLength(11);
    expect(shown.has("majik")).toBe(true);
    expect(shown.has("shafen-claude-code")).toBe(true);
    const stale = eleven.map((m) => ({ ...m, last_at: "2026-08-01T00:00:00Z" }));
    const fewer = defaultCrewSet([...stale, ...CREW_FIXTURE.filter((m) => m.group !== "own_seat")], CREW_CAP_POLICY, NOW);
    // A fresh install (nothing heard from) still shows a couple of seats.
    expect([...fewer].filter((id) => id.startsWith("seat-"))).toEqual(["seat-0", "seat-1"]);
    // An unread hub counts as heard from.
    const unread = stale.map((m, i) => (i === 7 ? { ...m, unread: 2 } : m));
    expect(defaultCrewSet(unread, CREW_CAP_POLICY, NOW).has("seat-7")).toBe(true);
  });

  it("More lifts the cap and marks the section expanded", () => {
    const section = buildCrewSection({ ...base, showAll: true });
    expect(ids(section)).toHaveLength(12);
    expect(section.hiddenCount).toBe(0);
    expect(section.expanded).toBe(true);
    expect(section.groups[2]!.label).toBe("Partners");
  });

  it("a search ignores the cap and matches name, id, role line and owner", () => {
    expect(ids(buildCrewSection({ ...base, searchQuery: "shafen" }))).toEqual([
      "shafen-claude-code",
      "shox",
      "okapi-grok",
    ]);
    const zen = buildCrewSection({ ...base, searchQuery: "ZEN" });
    expect(ids(zen)).toEqual(["zen"]);
    expect(zen.hiddenCount).toBe(0);
    expect(zen.searching).toBe(true);
    expect(zen.expanded).toBe(false);
    expect(buildCrewSection({ ...base, searchQuery: "nobody" }).groups).toEqual([]);
  });

  it("brain chip: the hub's seats entry beats the seat default; house rows read the roster family", () => {
    const majik = { id: "majik", model: "qwen3.6-35b-chat" } as Agent;
    const section = buildCrewSection({ ...base, showAll: true, agents: [majik] });
    const brain = (agentId: string) =>
      section.groups.flatMap((group) => group.rows).find((row) => row.member.agent_id === agentId)?.brain;
    expect(brain("persephone")).toBe("Opus 5.5 · medium");
    expect(brain("claude-code")).toBe("Opus 5.5 · medium");
    expect(brain("codex-astra")).toBe("GPT-5 Codex · medium");
    expect(brain("majik")).toBe("Qwen");
    expect(brain("sidekick")).toBeNull();
    expect(brain("claude")).toBeNull();
    expect(brain("shafen-claude-code")).toBe("Fable 5.1 · high");
  });

  it("targets: hub_room_id for your seats and house, the newest shared room for a partner", () => {
    const section = buildCrewSection({ ...base, showAll: true, rooms: [...base.rooms, taxsq] });
    const row = (agentId: string) =>
      section.groups.flatMap((group) => group.rows).find((r) => r.member.agent_id === agentId)!;
    expect(row("persephone")).toMatchObject({ roomId: PERSEPHONE_HUB_ID, target: "hub", targetLabel: null });
    expect(row("shafen-claude-code")).toMatchObject({
      roomId: "room-taxsq",
      target: "shared",
      targetLabel: "#taxsq-portal",
    });
    // A partner you share nothing with has nowhere to go; a seat with no hub
    // yet keeps the server's id (null here) and is ensured on tap.
    expect(row("shox")).toMatchObject({ roomId: null, target: null });
    expect(row("codex-astra")).toMatchObject({ roomId: null, target: null, hub: null });
  });

  it("trusts hub_room_id when /crew answered and never searches the list for a hub", () => {
    const strayHub = hubFor("codex-astra", "hub-codex-astra");
    const answered = buildCrewSection({ ...base, showAll: true, rooms: [...base.rooms, strayHub] });
    const astra = answered.groups.flatMap((g) => g.rows).find((r) => r.member.agent_id === "codex-astra")!;
    expect(astra.roomId).toBeNull();
    const fallback = buildCrewSection({
      ...base,
      showAll: true,
      crewAnswered: false,
      rooms: [...base.rooms, strayHub],
    });
    const astraViaList = fallback.groups.flatMap((g) => g.rows).find((r) => r.member.agent_id === "codex-astra")!;
    expect(astraViaList.roomId).toBe("hub-codex-astra");
  });

  it("badges the hub plus its live threads by the Conversations rule, else the server count", () => {
    const thread = room({ id: `${PERSEPHONE_HUB_ID}-t-1`, parent_room_id: PERSEPHONE_HUB_ID, type: "agent_hub" });
    const archived = room({ id: `${PERSEPHONE_HUB_ID}-t-2`, parent_room_id: PERSEPHONE_HUB_ID, is_archived: true });
    const counts: Record<string, number> = { [PERSEPHONE_HUB_ID]: 1, [thread.id]: 2, [archived.id]: 9 };
    const section = buildCrewSection({
      ...base,
      rooms: [persephoneHub, rookHub, thread, archived],
      roomUnread: (r) => counts[r.id] ?? 0,
    });
    const rows = section.groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.member.agent_id === "persephone")?.unread).toBe(3);
    // Rook's hub is loaded and quiet: the client count (0) wins over the server's stale one.
    expect(rows.find((r) => r.member.agent_id === "claude-code")?.unread).toBe(0);
    // Astra has no hub loaded: the server's count stands.
    const astra = CREW_FIXTURE.find((m) => m.agent_id === "codex-astra")!;
    const withServerCount = buildCrewSection({
      ...base,
      crew: [{ ...astra, unread: 4 }],
      roomUnread: () => 0,
    });
    expect(withServerCount.groups[0]!.rows[0]!.unread).toBe(4);
    // Muted: the rule passed in returns 0 for a muted room.
    const muted = buildCrewSection({
      ...base,
      rooms: [persephoneHub, thread],
      roomUnread: (r) => (r.id === PERSEPHONE_HUB_ID ? 0 : counts[r.id] ?? 0),
    });
    expect(muted.groups[0]!.rows[0]!.unread).toBe(2);
  });

  it("collapses under its own section key", () => {
    const section = buildCrewSection({ ...base, collapsed: { [SECTION_KEYS.crew]: true } });
    expect(section.collapsed).toBe(true);
    expect(section.collapseKey).toBe("section:crew");
    expect(section.groups.length).toBeGreaterThan(0);
  });
});

describe("crew keyboard order", () => {
  it("walks the visible crew targets — hubs and partners' shared rooms — skipping rows with no room and a collapsed section", () => {
    const section = buildCrewSection({ ...base, showAll: true, rooms: [...base.rooms, taxsq] });
    expect(flattenCrewRows(section)).toEqual([[PERSEPHONE_HUB_ID], [ROOK_HUB_ID], ["room-taxsq"]]);
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

  it("reaches every visible row exactly once in both directions with two thread-less hubs", () => {
    // Two hubs with no threads: each is a crew row AND a Conversations row,
    // so the pane holds the same room twice. Stepping from the first copy
    // trapped the walk between the copies; stepping from the last index does not.
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
    const entries = flattenConversationPane(buildCrewSection({ ...base, rooms }), listRows);
    expect(entries).toEqual([[PERSEPHONE_HUB_ID], [ROOK_HUB_ID], [PERSEPHONE_HUB_ID], [ROOK_HUB_ID], ["room-general"]]);

    // Walk down the way AppShell does: navigate only when the target changes.
    const walk = (delta: -1 | 1, startCurrent: string | null, startLast: number | null) => {
      const visited: number[] = [];
      let current = startCurrent;
      let last = startLast;
      for (let i = 0; i < 20; i++) {
        const step = stepKeyboardOrder(entries, current, delta, last);
        if (!step) break;
        if (visited.length > 0 && visited[visited.length - 1] === step.index) break;
        visited.push(step.index);
        last = step.index;
        if (step.target && step.target !== current) current = step.target;
      }
      return { visited, current, last };
    };
    const down = walk(1, null, null);
    expect(down.visited).toEqual([0, 1, 2, 3, 4]);
    expect(down.current).toBe("room-general");
    const up = walk(-1, down.current, down.last);
    expect(up.visited).toEqual([3, 2, 1, 0]);
    expect(up.current).toBe(PERSEPHONE_HUB_ID);
    // The old rule (first copy of the active room) never reaches the list.
    const naive: number[] = [];
    let cur: string | null = null;
    for (let i = 0; i < 6; i++) {
      const step = stepKeyboardOrder(entries, cur, 1, null);
      naive.push(step!.index);
      cur = step!.target;
    }
    expect(naive).toEqual([0, 1, 2, 1, 2, 1]);
  });

  it("enters from the end it moves toward and clamps at the edges", () => {
    const entries = [["a"], ["b"], ["c"]];
    expect(stepKeyboardOrder(entries, null, 1, null)).toEqual({ index: 0, target: "a" });
    expect(stepKeyboardOrder(entries, null, -1, null)).toEqual({ index: 2, target: "c" });
    expect(stepKeyboardOrder(entries, "c", 1, 2)).toEqual({ index: 2, target: "c" });
    expect(stepKeyboardOrder(entries, "zzz", 1, 7)).toEqual({ index: 0, target: "a" });
    expect(stepKeyboardOrder([], "a", 1, null)).toBeNull();
    // A stale last index that no longer holds the active room is ignored.
    expect(stepKeyboardOrder(entries, "b", 1, 0)).toEqual({ index: 2, target: "c" });
  });
});
