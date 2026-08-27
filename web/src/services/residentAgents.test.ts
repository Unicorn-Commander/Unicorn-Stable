import { describe, expect, it } from "vitest";
import { residentAgentIds, residentAgentIdsFromMetadata } from "@/services/api";

describe("residentAgentIdsFromMetadata", () => {
  it("resolves a room that only ever had the scalar", () => {
    // Every room in the database before multi-agent looks like this.
    expect(residentAgentIdsFromMetadata({ brigade_agent_id: "majik" })).toEqual([
      "majik",
    ]);
  });

  it("is empty for a human-only room", () => {
    expect(residentAgentIdsFromMetadata(null)).toEqual([]);
    expect(residentAgentIdsFromMetadata({})).toEqual([]);
    expect(residentAgentIdsFromMetadata({ brigade_agent_id: "" })).toEqual([]);
  });

  it("mirrors the server: list form, then a scalar the list missed", () => {
    expect(
      residentAgentIdsFromMetadata({
        brigade_agent_ids: ["majik", "the-general"],
        brigade_agent_id: "the-general",
      }),
    ).toEqual(["majik", "the-general"]);
    // Half-written metadata must not lose the room's only agent.
    expect(
      residentAgentIdsFromMetadata({
        brigade_agent_ids: ["gunny"],
        brigade_agent_id: "majik",
      }),
    ).toEqual(["gunny", "majik"]);
  });

  it("ignores a malformed list", () => {
    expect(
      residentAgentIdsFromMetadata({
        brigade_agent_ids: "majik",
        brigade_agent_id: "gunny",
      }),
    ).toEqual(["gunny"]);
    expect(
      residentAgentIdsFromMetadata({ brigade_agent_ids: [1, "", "majik"] }),
    ).toEqual(["majik"]);
  });
});

describe("residentAgentIds", () => {
  it("dispatches a single-agent room exactly as before", () => {
    expect(residentAgentIds({ brigade_agent_id: "majik" })).toEqual(["majik"]);
    expect(
      residentAgentIds({
        brigade_agent_id: "majik",
        brigade_agent_ids: ["majik"],
      }),
    ).toEqual(["majik"]);
  });

  it("orders the canonical responder LAST", () => {
    // Each invite re-points metadata.brigade_agent_id at the agent it invited,
    // so ending on the canonical one means joining a call cannot change who
    // answers text in the room.
    expect(
      residentAgentIds({
        brigade_agent_id: "majik",
        brigade_agent_ids: ["majik", "the-general"],
      }),
    ).toEqual(["the-general", "majik"]);
  });

  it("is empty for a human-only room", () => {
    expect(residentAgentIds(null)).toEqual([]);
    expect(residentAgentIds({})).toEqual([]);
  });
});
