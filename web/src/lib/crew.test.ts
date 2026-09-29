import { describe, expect, it } from "vitest";
import type { Agent, Room, RoomMember } from "@/services/api";
import { CREW_FIXTURE, GUEST_AGENT_MEMBER, PARTNER_SEAT_MEMBER, PERSEPHONE_MEMBER } from "@/mocks/crewFixture";
import {
  brainLabel,
  canEditSeat,
  crewBrainChip,
  crewFromRoster,
  defaultBrainLabel,
  groupCrew,
  hubRoomFor,
  humanizeModelId,
  isRunnerSeat,
  memberKindMark,
  modelFamilyLabel,
  modelLabel,
  ownerSeatLabel,
  readRoomSeat,
  seatIndex,
} from "./crew";

const persephone = CREW_FIXTURE.find((m) => m.agent_id === "persephone")!;
const flow = CREW_FIXTURE.find((m) => m.agent_id === "shafen-claude-code")!;
const majik = CREW_FIXTURE.find((m) => m.agent_id === "majik")!;

describe("crew grouping", () => {
  it("keeps the fixed group order and the server's order within a group", () => {
    const groups = groupCrew(CREW_FIXTURE);
    expect(groups.map((g) => [g.group, g.label, g.members.length])).toEqual([
      ["own_seat", "Your seats", 6],
      ["house", "House", 3],
      ["partner", "Partners", 3],
    ]);
    expect(groups[2]!.members.map((m) => m.display_name)).toEqual(["Flow", "ShOX", "Okapi"]);
  });

  it("drops an empty group", () => {
    expect(groupCrew([majik]).map((g) => g.group)).toEqual(["house"]);
  });

  it("tells seats from house agents and only your own seat is editable", () => {
    expect(isRunnerSeat(persephone)).toBe(true);
    expect(isRunnerSeat(flow)).toBe(true);
    expect(isRunnerSeat(majik)).toBe(false);
    expect(canEditSeat(persephone)).toBe(true);
    expect(canEditSeat(flow)).toBe(false);
    expect(canEditSeat(majik)).toBe(false);
  });
});

describe("roster fallback", () => {
  const agent = (over: Partial<Agent> & { id: string }): Agent =>
    ({ name: over.id, display_name: over.id, description: "", avatar_url: null, status: "active", capabilities: [], model: "", ...over }) as Agent;

  it("maps every entitled roster agent to a house row and never a seat", () => {
    const rows = crewFromRoster([
      agent({ id: "majik", display_name: "Majik Mane", title: "House DJ", availability: "available" }),
      agent({ id: "sidekick", status: "offline", availability: "unavailable" }),
      agent({ id: "locked", entitled: false }),
      agent({ id: "persephone", display_name: "Persephone" }),
    ]);
    expect(rows.map((r) => r.agent_id)).toEqual(["majik", "sidekick", "persephone"]);
    for (const row of rows) {
      expect(row.group).toBe("house");
      expect(row.kind).toBe("brigade");
      expect(row.backend).toBe("brigade");
      expect(row.seat_capabilities).toBeNull();
      expect(row.owner).toBeNull();
    }
    expect(rows[0]).toMatchObject({ display_name: "Majik Mane", role_line: "House DJ", presence: "online" });
    expect(rows[1]!.presence).toBe("offline");
    // No availability on an older roster: status decides.
    expect(rows[2]!.presence).toBe("online");
  });
});

describe("model labels", () => {
  it("humanizes ids the seat did not label", () => {
    expect(humanizeModelId("claude-fable-5-1")).toBe("Fable 5.1");
    expect(humanizeModelId("claude-opus-5-5")).toBe("Opus 5.5");
    expect(humanizeModelId("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(humanizeModelId("gpt-5-codex")).toBe("GPT 5 Codex");
    expect(humanizeModelId("anthropic/claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(humanizeModelId("grok-4")).toBe("Grok 4");
  });

  it("prefers the announced label", () => {
    expect(modelLabel("claude-fable-5-1", persephone.seat_capabilities)).toBe("Fable 5.1");
    expect(modelLabel("claude-opus-9-9", persephone.seat_capabilities)).toBe("Opus 9.9");
    expect(modelLabel(null, persephone.seat_capabilities)).toBeNull();
  });

  it("names a Brigade agent's model family or nothing", () => {
    expect(modelFamilyLabel("claude-sonnet-4-20250514")).toBe("Claude");
    expect(modelFamilyLabel("qwen3.6-35b-chat")).toBe("Qwen");
    expect(modelFamilyLabel("gpt-4o")).toBe("GPT");
    expect(modelFamilyLabel("openrouter/deepseek-r1")).toBe("DeepSeek");
    expect(modelFamilyLabel("")).toBeNull();
    expect(modelFamilyLabel(undefined)).toBeNull();
  });
});

describe("room seat", () => {
  it("reads metadata.seat tolerantly", () => {
    expect(readRoomSeat(null)).toEqual({ model: null, effort: null });
    expect(readRoomSeat({ metadata_: {} })).toEqual({ model: null, effort: null });
    expect(readRoomSeat({ metadata_: { seat: "junk" } })).toEqual({ model: null, effort: null });
    expect(readRoomSeat({ metadata_: { seat: { model: "claude-opus-5-5", effort: "" } } })).toEqual({
      model: "claude-opus-5-5",
      effort: null,
    });
  });

  it("labels the brain from the override, else the default, and names the default", () => {
    const caps = persephone.seat_capabilities;
    expect(brainLabel({ model: null, effort: null }, caps)).toBe("Fable 5.1 · high");
    expect(brainLabel({ model: "claude-opus-5-5", effort: null }, caps)).toBe("Opus 5.5 · high");
    expect(brainLabel({ model: null, effort: "max" }, caps)).toBe("Fable 5.1 · max");
    expect(brainLabel({ model: null, effort: null }, null)).toBeNull();
    expect(brainLabel({ model: "x-1", effort: null }, null)).toBe("X 1");
    expect(defaultBrainLabel(caps)).toBe("Fable 5.1 · high");
    expect(defaultBrainLabel(null)).toBeNull();
  });

  it("chips a seat from its hub and a house agent from the roster", () => {
    const hub = { metadata_: { seat: { model: "claude-haiku-4-5", effort: "low" } } } as unknown as Room;
    expect(crewBrainChip(persephone, hub)).toBe("Haiku 4.5 · low");
    expect(crewBrainChip(persephone, null)).toBe("Fable 5.1 · high");
    // A seat that has not announced: no chip, even with a room override.
    expect(crewBrainChip({ ...persephone, seat_capabilities: null }, hub)).toBeNull();
    expect(crewBrainChip(majik, null, { model: "claude-sonnet-4-5" })).toBe("Claude");
    expect(crewBrainChip(majik, null, null)).toBeNull();
  });

  it("finds the hub by id, counterpart, resident id or participant", () => {
    const room = (over: Partial<Room> & { id: string }): Room =>
      ({ name: over.id, description: "", type: "agent_hub", created_at: "", updated_at: "", member_count: 1, unread_count: 0, last_message: null, members: [], agents: [], ...over }) as Room;
    const byId = room({ id: "hub-fa65c5631810" });
    const byCounterpart = room({ id: "h2", counterpart: { participant_id: "p-x", kind: "agent", display_name: "X", agent_id: "codex-astra" } });
    const byResident = room({ id: "h3", brigade_agent_id: "grok" });
    const byParticipant = room({ id: "h4", counterpart: { participant_id: "p-zen", kind: "agent", display_name: "Zen" } });
    const archived = room({ id: "h5", brigade_agent_id: "claude", is_archived: true });
    const thread = room({ id: "h6", brigade_agent_id: "claude", parent_room_id: "h7" });
    const rooms = [byId, byCounterpart, byResident, byParticipant, archived, thread];
    const find = (id: string) => CREW_FIXTURE.find((m) => m.agent_id === id)!;
    expect(hubRoomFor(find("persephone"), rooms)?.id).toBe("hub-fa65c5631810");
    expect(hubRoomFor(find("codex-astra"), rooms)?.id).toBe("h2");
    expect(hubRoomFor(find("grok"), rooms)?.id).toBe("h3");
    expect(hubRoomFor(find("zen"), rooms)?.id).toBe("h4");
    expect(hubRoomFor(find("claude"), rooms)).toBeNull();
  });

  it("indexes runner seats by agent and participant", () => {
    const index = seatIndex(CREW_FIXTURE);
    expect(index.byAgent.has("persephone")).toBe(true);
    expect(index.byAgent.has("majik")).toBe(false);
    expect(index.byParticipant.get("p-shafen-claude-code")?.group).toBe("partner");
  });
});

describe("member roster marks (§2.0)", () => {
  it("marks a guest agent and a partner's seat, never your own seat or a bare row", () => {
    expect(memberKindMark(GUEST_AGENT_MEMBER, "aaron")).toEqual({ kind: "guest" });
    expect(memberKindMark(PARTNER_SEAT_MEMBER, "aaron")).toEqual({
      kind: "partner_seat",
      owner: "shafen",
      label: "Shafen’s seat",
    });
    expect(memberKindMark(PERSEPHONE_MEMBER, "aaron")).toBeNull();
    // Someone else looking at the same room sees Aaron's seat as a partner's.
    const seen = memberKindMark(PERSEPHONE_MEMBER, "shafen");
    expect(seen?.kind).toBe("partner_seat");
    expect(seen && seen.kind === "partner_seat" ? seen.label : null).toBe("aaron’s seat");
    const bare: RoomMember = { username: "x", display_name: "X", role: "member", joined_at: "" };
    expect(memberKindMark(bare, "aaron")).toBeNull();
    expect(memberKindMark({ ...bare, metadata: { backend: "runner" } }, "aaron")).toBeNull();
  });

  it("writes the possessive", () => {
    expect(ownerSeatLabel("Shafen")).toBe("Shafen’s seat");
    expect(ownerSeatLabel("Jess")).toBe("Jess’ seat");
    expect(ownerSeatLabel("  ")).toBe("Partner's seat");
  });
});
