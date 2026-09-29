import { describe, expect, it } from "vitest";
import type { PeopleDirectoryEntry, Room } from "@/services/api";
import { CREW_FIXTURE } from "@/mocks/crewFixture";
import { buildToPicks } from "./newSheetPicker";

function room(over: Partial<Room> & { id: string }): Room {
  return {
    name: over.id,
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

function person(id: string, username: string, display_name: string): PeopleDirectoryEntry {
  return { id, username, display_name, avatar_url: null, is_online: false } as unknown as PeopleDirectoryEntry;
}

const rooms = [
  room({ id: "room-general", name: "general" }),
  room({ id: "room-leadership", name: "leadership", visibility: "private" }),
  room({ id: "room-leads-old", name: "leads-old", is_archived: true }),
  room({ id: "room-leads-thread", name: "leads thread", parent_room_id: "room-general" }),
  room({ id: "room-dm-lead", name: "Lead Singer", type: "dm" }),
];
const people = [person("u-jason", "jason", "Nate Ellison"), person("u-shafen", "shafen", "Shafen Khan")];
const browsable = [
  room({ id: "room-leads", name: "leads" }),
  room({ id: "room-leadership", name: "leadership" }),
];

describe("New sheet To picker", () => {
  it("with nothing typed lists the crew's first rows and nothing else", () => {
    const picks = buildToPicks({ crew: CREW_FIXTURE, people, rooms, browsable, query: "  " });
    expect(picks.crew.map((m) => m.agent_id)).toEqual([
      "persephone",
      "claude-code",
      "codex-astra",
      "grok",
      "zen",
      "claude",
    ]);
    expect(picks.people).toEqual([]);
    expect(picks.channels).toEqual([]);
    expect(picks.empty).toBe(false);
  });

  it("a query narrows Crew, People and Channels together", () => {
    const picks = buildToPicks({ crew: CREW_FIXTURE, people, rooms, browsable, query: "sha" });
    expect(picks.crew.map((m) => m.display_name)).toEqual(["Flow", "ShOX", "Okapi"]);
    expect(picks.people.map((p) => p.username)).toEqual(["shafen"]);
    expect(picks.channels).toEqual([]);
    expect(picks.empty).toBe(false);
  });

  it("offers joined channels first, then joinable ones, never DMs, threads or archived rooms", () => {
    const picks = buildToPicks({ crew: CREW_FIXTURE, people, rooms, browsable, query: "lead" });
    expect(picks.channels.map((c) => [c.room.id, c.joined])).toEqual([
      ["room-leadership", true],
      ["room-leads", false],
    ]);
    expect(picks.crew).toEqual([]);
    expect(picks.people).toEqual([]);
  });

  it("matches a crew member by id and role line", () => {
    expect(
      buildToPicks({ crew: CREW_FIXTURE, people: [], rooms: [], query: "codex" }).crew.map((m) => m.agent_id),
    ).toEqual(["codex-astra"]);
    expect(
      buildToPicks({ crew: CREW_FIXTURE, people: [], rooms: [], query: "fleet" }).crew.map((m) => m.agent_id),
    ).toEqual(["the-general"]);
  });

  it("caps each group and reports empty when nothing matches", () => {
    const capped = buildToPicks({ crew: CREW_FIXTURE, people, rooms, query: "a", caps: { crew: 2, people: 1 } });
    expect(capped.crew).toHaveLength(2);
    expect(capped.people).toHaveLength(1);
    const none = buildToPicks({ crew: CREW_FIXTURE, people, rooms, browsable, query: "zzz" });
    expect(none.empty).toBe(true);
    expect(none.crew).toEqual([]);
  });
});
