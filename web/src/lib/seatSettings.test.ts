import { describe, expect, it } from "vitest";
import type { Room, RoomMember } from "@/services/api";
import {
  CREW_FIXTURE,
  MAJIK_MEMBER,
  PARTNER_SEAT_MEMBER,
  PERSEPHONE_HUB_ID,
  PERSEPHONE_MEMBER,
} from "@/mocks/crewFixture";
import {
  applySeatToRoom,
  effectiveEffort,
  effectiveModel,
  findSeatMember,
  findSeatMembers,
  seatMenuEntries,
  isDefaultSeat,
  pickEffort,
  pickModel,
  resetSeat,
  seatChipLabel,
  seatDefaultLabel,
  seatEffortOptions,
  seatModelOptions,
  seatPatchBody,
  seatRefusalKind,
  shouldShowModelSwitcher,
  validateSeat,
} from "./seatSettings";

const persephone = CREW_FIXTURE.find((m) => m.agent_id === "persephone")!;
const caps = persephone.seat_capabilities!;

function room(over: Partial<Room> = {}): Room {
  return {
    id: PERSEPHONE_HUB_ID,
    name: "Persephone",
    description: "",
    type: "agent_hub",
    created_at: "",
    updated_at: "",
    member_count: 2,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...over,
  };
}

describe("seat member match", () => {
  it("finds your seat through the room's agent rows and reads its mode", () => {
    const hub = room({
      agent_members: [
        { participant_id: "p-persephone", agent_id: "persephone", display_name: "Persephone", agent_mode: "answers_all" },
      ],
    });
    const match = findSeatMember(hub, [], CREW_FIXTURE);
    expect(match).toMatchObject({
      participantId: "p-persephone",
      editable: true,
      agentMode: "answers_all",
    });
    expect(match?.member.agent_id).toBe("persephone");
  });

  it("falls back to the counterpart, then the members payload, then the resident id", () => {
    const viaCounterpart = room({
      counterpart: { participant_id: "p-x", kind: "agent", display_name: "Rook", agent_id: "claude-code" },
    });
    expect(findSeatMember(viaCounterpart, null, CREW_FIXTURE)?.member.agent_id).toBe("claude-code");
    const viaMembers = room({ type: "channel", counterpart: null });
    expect(findSeatMember(viaMembers, [PERSEPHONE_MEMBER], CREW_FIXTURE)).toMatchObject({
      participantId: "p-persephone",
      agentMode: "answers_all",
    });
    const viaResident = room({ type: "channel", brigade_agent_id: "codex-astra" });
    expect(findSeatMember(viaResident, [], CREW_FIXTURE)?.member.display_name).toBe("Astra");
  });

  it("lists every seat in a room, yours first, one entry each", () => {
    const shared = room({
      type: "channel",
      counterpart: null,
      agent_members: [
        { participant_id: "p-shafen-claude-code", agent_id: "shafen-claude-code", display_name: "Flow", agent_mode: "when_named" },
        { participant_id: "p-majik", agent_id: "majik", display_name: "Majik" },
      ],
      brigade_agent_ids: ["persephone", "claude-code", "shafen-claude-code"],
    });
    const matches = findSeatMembers(shared, [PERSEPHONE_MEMBER, PARTNER_SEAT_MEMBER], CREW_FIXTURE);
    expect(matches.map((m) => [m.member.agent_id, m.editable])).toEqual([
      ["persephone", true],
      ["claude-code", true],
      ["shafen-claude-code", false],
    ]);
    expect(matches[0]!.participantId).toBe("p-persephone");
    expect(matches[2]!.agentMode).toBe("when_named");
  });

  it("lists the phone's menu lines: yours named and open, a partner's locked with its owner", () => {
    const shared = room({
      type: "channel",
      counterpart: null,
      agent_members: [
        { participant_id: "p-shafen-claude-code", agent_id: "shafen-claude-code", display_name: "Flow", agent_mode: "when_named" },
      ],
      brigade_agent_ids: ["persephone", "shafen-claude-code"],
      metadata_: { seats: { persephone: { model: "claude-opus-5-5", effort: "medium" } } },
    });
    const matches = findSeatMembers(shared, [PERSEPHONE_MEMBER, PARTNER_SEAT_MEMBER], CREW_FIXTURE);
    expect(seatMenuEntries(shared, matches)).toEqual([
      { key: "persephone", label: "Persephone · Opus 5.5 · medium", locked: false },
      { key: "shafen-claude-code", label: "Shafen’s Flow · Fable 5.1 · high", locked: true },
    ]);
    // One seat of yours: the line needs no name.
    const hub = room();
    const alone = findSeatMembers(hub, [PERSEPHONE_MEMBER], CREW_FIXTURE);
    expect(seatMenuEntries(hub, alone)).toEqual([
      { key: "persephone", label: "Fable 5.1 · high", locked: false },
    ]);
    // A partner's seat nothing is known about: no line, as no chip.
    const silent = matches.map((match) =>
      match.editable ? match : { ...match, member: { ...match.member, seat_capabilities: null } },
    );
    expect(seatMenuEntries(shared, silent).map((entry) => entry.key)).toEqual(["persephone"]);
    expect(seatMenuEntries(null, [])).toEqual([]);
    // Yours, when its runner never announced and nothing is set here: no
    // line either — it used to read "seat default" and open an empty sheet
    // (review 2, D10). Set something, and the line is back.
    const unannounced = alone.map((match) => ({ ...match, member: { ...match.member, seat_capabilities: null } }));
    expect(seatMenuEntries(hub, unannounced)).toEqual([]);
    const withSeat = room({ metadata_: { seats: { persephone: { model: null, effort: "max" } } } });
    expect(seatMenuEntries(withSeat, unannounced)).toEqual([{ key: "persephone", label: "max", locked: false }]);
  });

  it("marks a partner's seat read-only and ignores house agents", () => {
    const shared = room({ type: "channel", counterpart: null });
    const partner = findSeatMember(shared, [PARTNER_SEAT_MEMBER], CREW_FIXTURE);
    expect(partner).toMatchObject({ participantId: "p-shafen-claude-code", editable: false });
    const majik: RoomMember = { ...PERSEPHONE_MEMBER, participant_id: "p-majik", display_name: "Majik" };
    expect(findSeatMember(shared, [majik], CREW_FIXTURE)).toBeNull();
    expect(findSeatMember(shared, [], [])).toBeNull();
    expect(findSeatMember(null, [], CREW_FIXTURE)).toBeNull();
  });
});

describe("switcher and refusals", () => {
  it("keeps the Brigade switcher while any agent member is not a seat", () => {
    const seatOnly = room({
      agent_members: [{ participant_id: "p-persephone", agent_id: "persephone", display_name: "Persephone" }],
    });
    expect(shouldShowModelSwitcher(seatOnly, [PERSEPHONE_MEMBER], CREW_FIXTURE)).toBe(false);
    const mixed = room({
      type: "group_dm",
      counterpart: null,
      agent_members: [
        { participant_id: "p-persephone", agent_id: "persephone", display_name: "Persephone" },
        { participant_id: "p-majik", agent_id: "majik", display_name: "Majik" },
      ],
    });
    expect(shouldShowModelSwitcher(mixed, [PERSEPHONE_MEMBER], CREW_FIXTURE)).toBe(true);
    const brigadeOnly = room({ type: "dm", counterpart: null, agent_members: [], brigade_agent_id: "majik" });
    expect(shouldShowModelSwitcher(brigadeOnly, [], CREW_FIXTURE)).toBe(true);
    const seatByResident = room({ type: "dm", counterpart: null, agent_members: [], brigade_agent_id: "persephone" });
    expect(shouldShowModelSwitcher(seatByResident, [], CREW_FIXTURE)).toBe(false);
    const humansOnly = room({ type: "channel", counterpart: null, agent_members: [] });
    expect(shouldShowModelSwitcher(humansOnly, [], CREW_FIXTURE)).toBe(true);
    // Members payload alone (no agents[] on the detail) decides the same way.
    const viaMembers = room({ type: "channel", counterpart: null, agent_members: [] });
    expect(shouldShowModelSwitcher(viaMembers, [PERSEPHONE_MEMBER], CREW_FIXTURE)).toBe(false);
    expect(shouldShowModelSwitcher(viaMembers, [PERSEPHONE_MEMBER, MAJIK_MEMBER], CREW_FIXTURE)).toBe(true);
  });

  it("counts only house agents: a guest agent or an integration does not bring the switcher back (review 2, P2-10)", () => {
    const withAgents = (...rows: Array<{ pid: string; agent: string }>) =>
      room({
        type: "channel",
        counterpart: null,
        agent_members: rows.map((row) => ({ participant_id: row.pid, agent_id: row.agent, display_name: row.agent })),
      });
    const guest: RoomMember = {
      ...PERSEPHONE_MEMBER,
      participant_id: "p-taxsq-assistant",
      display_name: "Northbridge Tax Assistant",
      metadata: { kind: "guest_agent", backend: null, owner: null, owner_display_name: null },
    };
    const integration: RoomMember = {
      ...PERSEPHONE_MEMBER,
      participant_id: "p-webhook",
      display_name: "Webhook",
      metadata: { kind: "integration", backend: null, owner: null, owner_display_name: null },
    };
    const strangerSeat: RoomMember = {
      ...PERSEPHONE_MEMBER,
      participant_id: "p-someone-elses-seat",
      display_name: "Someone else's seat",
      metadata: { kind: null, backend: "runner", owner: "someone", owner_display_name: "Someone" },
    };
    const houseAgent: RoomMember = {
      ...PERSEPHONE_MEMBER,
      participant_id: "p-majik",
      display_name: "Majik",
      metadata: { kind: null, backend: null, owner: null, owner_display_name: null },
    };
    const persephone = { pid: "p-persephone", agent: "persephone" };
    // #taxsq-portal: your seat and the customer's own AI. Nothing to switch.
    const portal = withAgents(persephone, { pid: "p-taxsq-assistant", agent: "taxsq-assistant" });
    expect(shouldShowModelSwitcher(portal, [PERSEPHONE_MEMBER, guest], CREW_FIXTURE)).toBe(false);
    // Found through the members payload alone, the same.
    const viaMembers = withAgents();
    expect(shouldShowModelSwitcher(viaMembers, [PERSEPHONE_MEMBER, guest, integration], CREW_FIXTURE)).toBe(false);
    expect(shouldShowModelSwitcher(viaMembers, [PERSEPHONE_MEMBER, strangerSeat], CREW_FIXTURE)).toBe(false);
    // A house agent still brings it, with or without metadata.
    expect(shouldShowModelSwitcher(viaMembers, [PERSEPHONE_MEMBER, guest, houseAgent], CREW_FIXTURE)).toBe(true);
    const oldServer: RoomMember = { ...houseAgent, metadata: undefined };
    expect(shouldShowModelSwitcher(viaMembers, [PERSEPHONE_MEMBER, oldServer], CREW_FIXTURE)).toBe(true);
    // A room whose only agent is a guest reads like a room with none.
    expect(shouldShowModelSwitcher(withAgents(), [guest], CREW_FIXTURE)).toBe(
      shouldShowModelSwitcher(withAgents(), [], CREW_FIXTURE),
    );
  });

  it("tells the two 409s apart", () => {
    expect(seatRefusalKind("This room is archived")).toBe("archived");
    expect(seatRefusalKind("archived rooms refuse")).toBe("archived");
    expect(seatRefusalKind("no runner seat in this room")).toBe("no_seat");
    expect(seatRefusalKind(null)).toBe("no_seat");
  });
});

describe("seat popover state", () => {
  it("names the default and labels the chip from override or default", () => {
    expect(seatDefaultLabel(caps)).toBe("Default (Fable 5.1 · high)");
    expect(seatDefaultLabel(null)).toBe("Default (seat's own settings)");
    expect(seatChipLabel(resetSeat(), caps)).toBe("Fable 5.1 · high");
    expect(seatChipLabel({ model: "claude-opus-5-5", effort: "medium" }, caps)).toBe("Opus 5.5 · medium");
    expect(isDefaultSeat(resetSeat())).toBe(true);
    expect(isDefaultSeat({ model: null, effort: "max" })).toBe(false);
  });

  it("offers the announced models and efforts, with the four efforts as the floor", () => {
    expect(seatModelOptions(caps).map((m) => m.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]);
    expect(seatEffortOptions(caps)).toEqual(["low", "medium", "high", "max"]);
    expect(seatEffortOptions({ ...caps, efforts: [] })).toEqual(["low", "medium", "high", "max"]);
    expect(seatEffortOptions(null)).toEqual(["low", "medium", "high", "max"]);
    expect(seatModelOptions(null)).toEqual([]);
  });

  it("highlights the effective model and effort", () => {
    expect(effectiveModel(resetSeat(), caps)).toBe("claude-fable-5-1");
    expect(effectiveEffort(resetSeat(), caps)).toBe("high");
    expect(effectiveModel({ model: "claude-haiku-4-5", effort: null }, caps)).toBe("claude-haiku-4-5");
    expect(effectiveEffort({ model: null, effort: "low" }, caps)).toBe("low");
  });

  it("accumulates picks and resets to the default", () => {
    let seat = resetSeat();
    seat = pickModel(seat, "claude-opus-5-5");
    expect(seat).toEqual({ model: "claude-opus-5-5", effort: null });
    seat = pickEffort(seat, "medium");
    expect(seat).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(seatPatchBody("persephone", seat)).toEqual({
      metadata: { seats: { persephone: { model: "claude-opus-5-5", effort: "medium" } } },
    });
    expect(seatPatchBody("claude-code", resetSeat())).toEqual({
      metadata: { seats: { "claude-code": { model: null, effort: null } } },
    });
    expect(resetSeat()).toEqual({ model: null, effort: null });
  });

  it("validates against what the seat announced", () => {
    expect(validateSeat({ model: "claude-opus-5-5", effort: "max" }, caps)).toBe(true);
    expect(validateSeat({ model: "gpt-5", effort: null }, caps)).toBe(false);
    expect(validateSeat({ model: null, effort: "ultra" }, caps)).toBe(false);
    expect(validateSeat({ model: "anything", effort: null }, null)).toBe(true);
  });

  it("writes the optimistic room without losing other metadata or other seats", () => {
    const before = room({
      metadata_: {
        auto_titled: true,
        seats: { persephone: { model: "x", effort: "low" }, "claude-code": { model: null, effort: "max" } },
      },
    });
    const after = applySeatToRoom(before, "persephone", { model: "claude-opus-5-5", effort: null });
    expect(after.metadata_).toEqual({
      auto_titled: true,
      seats: {
        persephone: { model: "claude-opus-5-5", effort: null },
        "claude-code": { model: null, effort: "max" },
      },
    });
    expect(applySeatToRoom({ metadata_: null }, "grok", resetSeat()).metadata_).toEqual({
      seats: { grok: { model: null, effort: null } },
    });
  });
});
