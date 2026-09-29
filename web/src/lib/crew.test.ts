import { describe, expect, it } from "vitest";
import { coerceOwner, type Agent, type Room, type RoomMember } from "@/services/api";
import { CREW_FIXTURE, GUEST_AGENT_MEMBER, PARTNER_SEAT_MEMBER, PERSEPHONE_MEMBER } from "@/mocks/crewFixture";
import {
  brainLabel,
  canEditSeat,
  crewBrainChip,
  crewFromRoster,
  crewPresence,
  crewTargetRoom,
  defaultBrainLabel,
  groupCrew,
  hubRoomFor,
  humanizeModelId,
  isHubRoom,
  isRunnerSeat,
  memberKindMark,
  modelFamilyLabel,
  modelLabel,
  ownerSeatLabel,
  readRoomSeat,
  readRoomSeats,
  RUNNER_OFFLINE_LABEL,
  RUNNER_ONLINE_LABEL,
  runnerSeenLabel,
  seatIndex,
  sharedRoomFor,
} from "./crew";

const SELF = ["p-aaron"];

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
      agent({ id: "gone", status: "offline" }),
    ]);
    expect(rows.map((r) => r.agent_id)).toEqual(["majik", "sidekick", "persephone", "gone"]);
    for (const row of rows) {
      expect(row.group).toBe("house");
      expect(row.kind).toBe("brigade");
      expect(row.backend).toBe("brigade");
      expect(row.seat_capabilities).toBeNull();
      expect(row.owner).toBeNull();
    }
    expect(rows[0]).toMatchObject({ display_name: "Majik Mane", role_line: "House DJ", presence: "online" });
    expect(rows[1]!.presence).toBe("offline");
    // No availability and a non-offline status: nobody measured it — unknown, no dot.
    expect(rows[2]!.presence).toBe("unknown");
    expect(crewPresence(rows[2]!)).toEqual({ online: false, label: "Presence unknown", dotClass: null });
    expect(rows[3]!.presence).toBe("offline");
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
  it("reads metadata.seats per agent, tolerantly", () => {
    expect(readRoomSeat(null, "persephone")).toEqual({ model: null, effort: null });
    expect(readRoomSeat({ metadata_: {} }, "persephone")).toEqual({ model: null, effort: null });
    expect(readRoomSeat({ metadata_: { seats: "junk" } }, "persephone")).toEqual({ model: null, effort: null });
    const room = {
      metadata_: {
        seats: {
          persephone: { model: "claude-opus-5-5", effort: "" },
          "claude-code": { model: null, effort: "max" },
          broken: 7,
        },
      },
    };
    expect(readRoomSeat(room, "persephone")).toEqual({ model: "claude-opus-5-5", effort: null });
    expect(readRoomSeat(room, "claude-code")).toEqual({ model: null, effort: "max" });
    expect(readRoomSeat(room, "grok")).toEqual({ model: null, effort: null });
    expect(readRoomSeat(room, null)).toEqual({ model: null, effort: null });
    expect(Object.keys(readRoomSeats(room))).toEqual(["persephone", "claude-code", "broken"]);
    expect(readRoomSeats(room).broken).toEqual({ model: null, effort: null });
    // The old per-room key is not a seat.
    expect(readRoomSeat({ metadata_: { seat: { model: "x", effort: "low" } } }, "persephone")).toEqual({
      model: null,
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
    const hub = {
      metadata_: {
        seats: {
          persephone: { model: "claude-haiku-4-5", effort: "low" },
          "claude-code": { model: "claude-sonnet-4-5", effort: "max" },
        },
      },
    } as unknown as Room;
    expect(crewBrainChip(persephone, hub)).toBe("Haiku 4.5 · low");
    const rook = CREW_FIXTURE.find((m) => m.agent_id === "claude-code")!;
    expect(crewBrainChip(rook, hub)).toBe("Sonnet 4.5 · max");
    expect(crewBrainChip(persephone, null)).toBe("Fable 5.1 · high");
    // A seat that has not announced: no chip, even with a room override.
    expect(crewBrainChip({ ...persephone, seat_capabilities: null }, hub)).toBeNull();
    expect(crewBrainChip(majik, null, { model: "claude-sonnet-4-5" })).toBe("Claude");
    expect(crewBrainChip(majik, null, null)).toBeNull();
  });

  it("finds a hub only through hub_room_id when /crew answered, else through the list", () => {
    const room = (over: Partial<Room> & { id: string }): Room =>
      ({ name: over.id, description: "", type: "agent_hub", created_at: "", updated_at: "", member_count: 1, unread_count: 0, last_message: null, members: [], agents: [], metadata_: { agent_hub: { human_id: "p-aaron" } }, ...over }) as Room;
    const byId = room({ id: "hub-fa65c5631810" });
    const byCounterpart = room({ id: "h2", counterpart: { participant_id: "p-x", kind: "agent", display_name: "X", agent_id: "codex-astra" } });
    const byResident = room({ id: "h3", brigade_agent_id: "grok" });
    const byParticipant = room({ id: "h4", counterpart: { participant_id: "p-zen", kind: "agent", display_name: "Zen" } });
    const archived = room({ id: "h5", brigade_agent_id: "claude", is_archived: true });
    const thread = room({ id: "h6", brigade_agent_id: "claude", parent_room_id: "h7" });
    const rooms = [byId, byCounterpart, byResident, byParticipant, archived, thread];
    const find = (id: string) => CREW_FIXTURE.find((m) => m.agent_id === id)!;
    // /crew answered: the id is the truth, the list is never searched.
    expect(hubRoomFor(find("persephone"), rooms, SELF)?.id).toBe("hub-fa65c5631810");
    expect(hubRoomFor(find("codex-astra"), rooms, SELF)).toBeNull();
    expect(hubRoomFor({ ...find("persephone"), hub_room_id: "not-loaded" }, rooms, SELF)).toBeNull();
    // Roster fallback (no /crew): the list is searched, but only for YOUR hub.
    expect(hubRoomFor(find("codex-astra"), rooms, SELF, false)?.id).toBe("h2");
    expect(hubRoomFor(find("grok"), rooms, SELF, false)?.id).toBe("h3");
    expect(hubRoomFor(find("zen"), rooms, SELF, false)?.id).toBe("h4");
    expect(hubRoomFor(find("claude"), rooms, SELF, false)).toBeNull();
    const shafens = room({
      id: "h8",
      brigade_agent_id: "grok",
      metadata_: { agent_hub: { human_id: "p-shafen", agent_id: "grok" } },
    });
    expect(hubRoomFor(find("grok"), [shafens], SELF, false)).toBeNull();
    expect(hubRoomFor(find("grok"), [shafens], [], false)).toBeNull();
  });

  it("tests a hub by type, parent AND human — a hub that names nobody is not yours", () => {
    const hub = { type: "agent_hub", parent_room_id: null, metadata_: { agent_hub: { human_id: "p-aaron" } } } as unknown as Room;
    const thread = { ...hub, parent_room_id: "hub-1" } as Room;
    const unnamed = { type: "agent_hub", parent_room_id: null, metadata_: {} } as Room;
    const channel = { type: "channel", parent_room_id: null, metadata_: {} } as Room;
    expect(isHubRoom(hub, ["p-aaron"])).toBe(true);
    expect(isHubRoom(hub, ["dev-user-001", "p-aaron"])).toBe(true);
    expect(isHubRoom(hub, ["p-shafen"])).toBe(false);
    expect(isHubRoom(hub, [null, undefined])).toBe(false);
    expect(isHubRoom(hub, [])).toBe(false);
    expect(isHubRoom(thread, ["p-aaron"])).toBe(false);
    expect(isHubRoom(unnamed, ["p-aaron"])).toBe(false);
    expect(isHubRoom(channel, ["p-aaron"])).toBe(false);
  });

  it("resolves one target per row: a hub for yours and house, the shared room for a partner", () => {
    const room = (over: Partial<Room> & { id: string }): Room =>
      ({ name: over.id, description: "", type: "channel", created_at: "", updated_at: "", member_count: 1, unread_count: 0, last_message: null, members: [], agents: [], ...over }) as Room;
    const hub = room({ id: "hub-fa65c5631810", type: "agent_hub", metadata_: { agent_hub: { human_id: "p-aaron" } } });
    const shared = room({ id: "room-taxsq", name: "taxsq-portal", brigade_agent_ids: ["shafen-claude-code"] });
    const dm = room({ id: "dm-1", type: "group_dm", display_name: "Aaron, Shafen, Flow", updated_at: "2026-09-29T00:00:00Z", agent_members: [{ participant_id: "p-shafen-claude-code", agent_id: "shafen-claude-code", display_name: "Flow" }] });
    const find = (id: string) => CREW_FIXTURE.find((m) => m.agent_id === id)!;
    expect(crewTargetRoom(find("persephone"), [hub, shared], SELF)).toMatchObject({ kind: "hub", label: "Persephone" });
    expect(crewTargetRoom(find("shafen-claude-code"), [hub, shared], SELF)).toMatchObject({ kind: "shared", label: "#taxsq-portal" });
    expect(crewTargetRoom(find("shafen-claude-code"), [hub, shared, dm], SELF)?.label).toBe("Aaron, Shafen, Flow");
    expect(crewTargetRoom(find("shox"), [hub, shared], SELF)).toBeNull();
    expect(crewTargetRoom(find("codex-astra"), [hub, shared], SELF)).toBeNull();
  });

  it("finds the newest room shared with a partner's seat", () => {
    const room = (over: Partial<Room> & { id: string }): Room =>
      ({ name: over.id, description: "", type: "channel", created_at: "", updated_at: "", member_count: 1, unread_count: 0, last_message: null, members: [], agents: [], ...over }) as Room;
    const flow = CREW_FIXTURE.find((m) => m.agent_id === "shafen-claude-code")!;
    const older = room({
      id: "shared-old",
      updated_at: "2026-09-20T00:00:00Z",
      agent_members: [{ participant_id: "p-shafen-claude-code", agent_id: "shafen-claude-code", display_name: "Flow" }],
    });
    const newer = room({
      id: "shared-new",
      updated_at: "2026-09-28T00:00:00Z",
      brigade_agent_ids: ["shafen-claude-code"],
    });
    const thread = room({ id: "t", parent_room_id: "shared-new", brigade_agent_id: "shafen-claude-code", updated_at: "2026-09-29T00:00:00Z" });
    const other = room({ id: "other", brigade_agent_id: "majik", updated_at: "2026-09-29T00:00:00Z" });
    expect(sharedRoomFor(flow, [older, other, thread, newer])?.id).toBe("shared-new");
    expect(sharedRoomFor(flow, [other])).toBeNull();
  });

  it("indexes runner seats by agent and participant", () => {
    const index = seatIndex(CREW_FIXTURE);
    expect(index.byAgent.has("persephone")).toBe(true);
    expect(index.byAgent.has("majik")).toBe(false);
    expect(index.byParticipant.get("p-shafen-claude-code")?.group).toBe("partner");
  });
});

describe("runner presence", () => {
  const now = Date.parse("2026-09-28T21:00:00Z");

  it("says only what the row knows: online, or no gateway call in the window", () => {
    expect(crewPresence(persephone)).toMatchObject({ online: true, label: RUNNER_ONLINE_LABEL });
    // The hourly announce and the last line are NOT last-seen stamps; the
    // offline label never invents a duration from them.
    const stale = { ...persephone, presence: "offline" as const, seat_capabilities: { ...persephone.seat_capabilities!, updated_at: "2026-09-28T20:48:00Z" }, last_at: "2026-09-25T00:00:00Z" };
    expect(crewPresence(stale)).toMatchObject({ online: false, label: RUNNER_OFFLINE_LABEL });
    expect(RUNNER_OFFLINE_LABEL).toBe("Runner offline — no gateway call in the last 3 min");
    // Once /crew carries last_seen_at, this is the label it feeds.
    expect(runnerSeenLabel("2026-09-28T20:48:00Z", now)).toBe("Runner not seen for 12 min");
    expect(runnerSeenLabel("2026-09-28T18:00:00Z", now)).toBe("Runner not seen for 3 h");
    expect(runnerSeenLabel("2026-09-20T18:00:00Z", now)).toBe("Runner not seen for 8 d");
    expect(runnerSeenLabel(null, now)).toBe(RUNNER_OFFLINE_LABEL);
    expect(runnerSeenLabel("garbage", now)).toBe(RUNNER_OFFLINE_LABEL);
  });

  it("keeps Brigade wording for house agents and draws no dot for unknown", () => {
    expect(crewPresence(majik)).toMatchObject({ online: true, label: "Majik Mane is available" });
    expect(crewPresence({ ...majik, presence: "offline" })).toMatchObject({
      online: false,
      label: "Majik Mane is unavailable",
    });
    expect(crewPresence(majik).dotClass).not.toBe(crewPresence({ ...majik, presence: "offline" }).dotClass);
    expect(crewPresence({ ...majik, presence: "unknown" }).dotClass).toBeNull();
  });
});

describe("owner coercion", () => {
  it("takes a string or the first of a list", () => {
    expect(coerceOwner("shafen")).toBe("shafen");
    expect(coerceOwner(" aaron ")).toBe("aaron");
    expect(coerceOwner(["shafen", "aaron"])).toBe("shafen");
    expect(coerceOwner(["", "aaron"])).toBe("aaron");
    expect(coerceOwner([])).toBeNull();
    expect(coerceOwner(null)).toBeNull();
    expect(coerceOwner(7)).toBeNull();
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
    expect(seen && seen.kind === "partner_seat" ? seen.label : null).toBe("Aaron’s seat");
    const bare: RoomMember = { username: "x", display_name: "X", role: "member", joined_at: "" };
    expect(memberKindMark(bare, "aaron")).toBeNull();
    expect(memberKindMark({ ...bare, metadata: { backend: "runner" } }, "aaron")).toBeNull();
    // The server stores owner as a string OR a list of usernames.
    const listed = memberKindMark({ ...bare, metadata: { backend: "runner", owner: ["shafen", "aaron"] } }, "aaron");
    expect(listed && listed.kind === "partner_seat" ? listed.label : null).toBe("Shafen’s seat");
  });

  it("writes the possessive", () => {
    expect(ownerSeatLabel("Shafen")).toBe("Shafen’s seat");
    expect(ownerSeatLabel("shafen")).toBe("Shafen’s seat");
    expect(ownerSeatLabel("Jess")).toBe("Jess’ seat");
    expect(ownerSeatLabel("Shafen Khan")).toBe("Shafen Khan’s seat");
    expect(ownerSeatLabel("  ")).toBe("Partner's seat");
  });
});
