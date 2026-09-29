/**
 * MSW stand-in for the Nav v3 routes (C2 seat settings, C3 crew, hub +
 * threads) while Lane A lands the server halves. The app calls the real
 * endpoints; tests use these so the client is pinned to the contract shapes.
 */
import { http, HttpResponse } from "msw";
import {
  CREW_FIXTURE,
  PERSEPHONE_HUB_ID,
  hubRoomRaw,
  membersFixture,
  threadRoomRaw,
} from "./crewFixture";

export const SEAT_MODEL_RE = /^[a-z0-9][a-z0-9.:_/-]{0,80}$/;
export const SEAT_EFFORTS = ["low", "medium", "high", "max"] as const;

/** Rooms with a runner-backed seat member. Everything else 409s on a seat write. */
const SEAT_ROOMS = new Set<string>([PERSEPHONE_HUB_ID, "hub-rook-0c3d1a2b", "room-taxsq"]);

let threadCounter = 0;

export function resetCrewMock(): void {
  threadCounter = 0;
}

export const crewHandlers = [
  http.get("*/api/v1/crew", () => HttpResponse.json(CREW_FIXTURE)),

  http.post("*/api/v1/agents/:agentId/hub", ({ params }) =>
    HttpResponse.json(hubRoomRaw(String(params.agentId))),
  ),

  http.post("*/api/v1/rooms/:roomId/threads", async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as { title?: string };
    threadCounter += 1;
    return HttpResponse.json(
      threadRoomRaw(String(params.roomId), threadCounter, body.title ?? null),
      { status: 201 },
    );
  }),

  http.get("*/api/v1/rooms/:roomId/members", ({ params }) =>
    HttpResponse.json(membersFixture(String(params.roomId))),
  ),

  http.patch("*/api/v1/rooms/:roomId/members/:participantId", async ({ params, request }) => {
    const body = (await request.json()) as { agent_mode?: unknown };
    const mode = body.agent_mode;
    if (mode !== "answers_all" && mode !== "when_named" && mode !== "listening" && mode !== "muted") {
      return HttpResponse.json({ detail: "Invalid agent_mode" }, { status: 422 });
    }
    const row = membersFixture(String(params.roomId)).find(
      (m) => m.participant_id === params.participantId,
    );
    return HttpResponse.json({ ...(row ?? { participant_id: params.participantId }), agent_mode: mode });
  }),

  http.patch("*/api/v1/rooms/:roomId", async ({ params, request }) => {
    const roomId = String(params.roomId);
    const body = (await request.json()) as { metadata?: { seat?: unknown } };
    const seat = body.metadata?.seat;
    if (seat !== undefined) {
      if (!seat || typeof seat !== "object") {
        return HttpResponse.json({ detail: "seat must be an object" }, { status: 422 });
      }
      const { model, effort } = seat as { model?: unknown; effort?: unknown };
      if (model !== null && model !== undefined && (typeof model !== "string" || !SEAT_MODEL_RE.test(model))) {
        return HttpResponse.json({ detail: "Invalid seat.model" }, { status: 422 });
      }
      if (
        effort !== null &&
        effort !== undefined &&
        !(SEAT_EFFORTS as readonly string[]).includes(String(effort))
      ) {
        return HttpResponse.json({ detail: "Invalid seat.effort" }, { status: 422 });
      }
      if (!SEAT_ROOMS.has(roomId)) {
        return HttpResponse.json(
          { detail: "This room has no runner-backed seat" },
          { status: 409 },
        );
      }
      return HttpResponse.json(
        hubRoomRaw("persephone", {
          id: roomId,
          name: roomId,
          metadata_: { seat: { model: model ?? null, effort: effort ?? null } },
        }),
      );
    }
    return HttpResponse.json(hubRoomRaw("persephone", { id: roomId, name: roomId }));
  }),
];
