/**
 * Nav v3 routes against the MSW stand-in (Lane A lands the server halves).
 * Pins method, path, body and the normalized shapes for /crew, the hub,
 * threads, the seat write and the member mode write.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { crewHandlers, resetCrewMock } from "@/mocks/crewHandlers";
import { CREW_RAW_FIXTURE, PERSEPHONE_HUB_ID } from "@/mocks/crewFixture";
import { api, normalizeCrewMember, type ApiError } from "./api";

const server = setupServer(...crewHandlers);

beforeAll(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://127.0.0.1");
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  resetCrewMock();
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

describe("GET /api/v1/crew", () => {
  it("returns the ranked crew with kind, owner, group and seat capabilities — and drops every other kind", async () => {
    expect(CREW_RAW_FIXTURE).toHaveLength(14);
    expect(CREW_RAW_FIXTURE.map((row) => row.kind)).toContain("guest_agent");
    expect(CREW_RAW_FIXTURE.map((row) => row.kind)).toContain("integration");
    const crew = await api.getCrew();
    expect(crew).toHaveLength(12);
    expect(crew.map((m) => m.agent_id)).not.toContain("taxsq-assistant");
    expect(crew.map((m) => m.agent_id)).not.toContain("webhook-dev-stable");
    expect(crew.map((m) => m.display_name)).not.toContain("Claude Code");
    expect(crew[0]).toMatchObject({
      agent_id: "persephone",
      participant_id: "p-persephone",
      backend: "runner",
      kind: "seat",
      owner: "aaron",
      group: "own_seat",
      presence: "online",
      hub_room_id: PERSEPHONE_HUB_ID,
    });
    expect(crew[0]!.seat_capabilities).toMatchObject({
      harness: "claude-code",
      default_model: "claude-fable-5-1",
      default_effort: "high",
      efforts: ["low", "medium", "high", "max"],
    });
    expect(crew.map((m) => m.group)).toEqual([
      ...Array(6).fill("own_seat"),
      ...Array(3).fill("house"),
      ...Array(3).fill("partner"),
    ]);
    expect(crew.find((m) => m.agent_id === "majik")).toMatchObject({
      kind: "brigade",
      backend: "brigade",
      owner: null,
      seat_capabilities: null,
    });
  });

  it("accepts an {items} envelope and fills omitted fields", async () => {
    server.use(
      http.get("*/api/v1/crew", () =>
        HttpResponse.json({ items: [{ agent_id: "sidekick" }, { agent_id: "flow", backend: "runner", owner: "shafen" }] }),
      ),
    );
    const crew = await api.getCrew();
    expect(crew[0]).toMatchObject({
      agent_id: "sidekick",
      display_name: "sidekick",
      kind: "brigade",
      group: "house",
      presence: "offline",
      unread: 0,
      seat_capabilities: null,
    });
    // A runner row with no group is somebody's seat, never silently yours.
    expect(crew[1]).toMatchObject({ kind: "seat", group: "partner", owner: "shafen" });
  });

  it("keeps the server's group when it names one, coerces owner, drops unknown kinds", () => {
    expect(normalizeCrewMember({ agent_id: "x", backend: "runner", group: "own_seat" })?.group).toBe("own_seat");
    expect(normalizeCrewMember({ agent_id: "x", kind: "brigade", group: "house" })?.kind).toBe("brigade");
    expect(normalizeCrewMember({ agent_id: "x", kind: "seat", owner: ["shafen", "aaron"] })?.owner).toBe("shafen");
    expect(normalizeCrewMember({ agent_id: "x", kind: "seat", owner: 42 })?.owner).toBeNull();
    expect(normalizeCrewMember({ agent_id: "x", kind: "guest_agent" })).toBeNull();
    expect(normalizeCrewMember({ agent_id: "x", kind: "integration", backend: "runner" })).toBeNull();
    expect(normalizeCrewMember({ agent_id: "x", presence: "unknown" })?.presence).toBe("unknown");
  });

  it("surfaces a 404 so the hook can fall back to the roster", async () => {
    server.use(http.get("*/api/v1/crew", () => HttpResponse.json({ detail: "Not Found" }, { status: 404 })));
    let thrown: ApiError | null = null;
    try {
      await api.getCrew();
    } catch (error) {
      thrown = error as ApiError;
    }
    expect(thrown?.status).toBe(404);
  });
});

describe("hub and threads", () => {
  it("ensures the hub and starts a thread under it", async () => {
    const hub = await api.ensureAgentHub("persephone");
    expect(hub).toMatchObject({ id: PERSEPHONE_HUB_ID, type: "agent_hub", brigade_agent_id: "persephone" });
    expect(hub.counterpart?.display_name).toBe("Persephone");
    const thread = await api.createThread(hub.id, { title: "  " });
    expect(thread.parent_room_id).toBe(PERSEPHONE_HUB_ID);
    expect(thread.id).toBe(`${PERSEPHONE_HUB_ID}-t-00000001`);
    expect(thread.type).toBe("agent_hub");
  });
});

describe("PATCH /rooms/{id} metadata.seats (C2)", () => {
  it("writes one seat's brain and reads it back off metadata_.seats", async () => {
    const room = await api.updateRoom(PERSEPHONE_HUB_ID, {
      metadata: { seats: { persephone: { model: "claude-opus-5-5", effort: "medium" } } },
    });
    expect(room.metadata_?.seats).toEqual({ persephone: { model: "claude-opus-5-5", effort: "medium" } });
    expect(room.metadata_?.agent_hub).toEqual({ human_id: "p-aaron", agent_id: "persephone" });
  });

  it("422 on a bad shape, 403 on someone else's seat, 409 on a room with no seat", async () => {
    await expect(
      api.updateRoom(PERSEPHONE_HUB_ID, { metadata: { seats: { persephone: { model: null, effort: "ultra" } } } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      api.updateRoom(PERSEPHONE_HUB_ID, { metadata: { seat: { model: null, effort: "high" } } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      api.updateRoom("room-taxsq", { metadata: { seats: { "shafen-claude-code": { model: null, effort: "max" } } } }),
    ).rejects.toMatchObject({ status: 403, detail: "ask the seat's owner" });
    await expect(
      api.updateRoom("room-general", { metadata: { seats: { persephone: { model: "claude-opus-5-5", effort: null } } } }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("PATCH /rooms/{id}/members/{pid} agent_mode", () => {
  it("echoes the mode", async () => {
    const row = await api.setAgentMode(PERSEPHONE_HUB_ID, "p-persephone", "listening");
    expect(row).toMatchObject({ participant_id: "p-persephone", agent_mode: "listening" });
  });

  it("lists a guest agent and a partner's seat with their metadata", async () => {
    const members = await api.getRoomMembers("room-taxsq");
    const guest = members.find((m) => m.participant_id === "p-taxsq-assistant");
    expect(guest?.metadata).toMatchObject({ kind: "guest_agent" });
    const flow = members.find((m) => m.participant_id === "p-shafen-claude-code");
    expect(flow?.metadata).toMatchObject({ backend: "runner", owner: "shafen" });
  });
});
