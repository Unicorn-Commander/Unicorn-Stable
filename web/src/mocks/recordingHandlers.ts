/**
 * MSW stand-in for the recording routes until the server lane (L8s) replaces
 * the 409 stubs. The app itself still calls the real endpoints; tests use
 * these handlers so the client is pinned to the contract shapes.
 */
import { http, HttpResponse } from "msw";

export const recordingHandlers = [
  http.post("*/api/v1/rooms/:roomId/recording/start", async ({ request, params }) => {
    const body = (await request.json()) as { kind?: unknown };
    if (body.kind !== "audio" && body.kind !== "composite") {
      return HttpResponse.json({ detail: "Invalid kind" }, { status: 422 });
    }
    return HttpResponse.json(
      {
        active: true,
        kind: body.kind,
        room_id: params.roomId,
        started_by: "p-aaron",
        started_at: "2026-09-21T18:00:00Z",
      },
      { status: 202 },
    );
  }),

  http.post("*/api/v1/rooms/:roomId/recording/stop", ({ params }) =>
    HttpResponse.json({ active: false, room_id: params.roomId }, { status: 202 }),
  ),

  http.get("*/api/v1/rooms/:roomId/recordings", ({ params }) =>
    HttpResponse.json([
      {
        id: "rec-1",
        room_id: params.roomId,
        kind: "audio",
        status: "complete",
        started_by: "p-aaron",
        started_by_name: "Aaron",
        started_at: "2026-09-21T18:00:00Z",
        ended_at: "2026-09-21T18:12:04Z",
        duration_seconds: 724,
        storage_url: "https://storage.example/rec-1.ogg",
        mo_session_id: "mo-1",
        mo_session_url: "https://meetingops.example/sessions/mo-1",
        retention_until: null,
        legal_hold: false,
      },
    ]),
  ),

  http.get("*/api/v1/rooms/:roomId/recordings/:recordingId/download", () =>
    HttpResponse.json({
      url: "https://signed.example/rec-1.ogg?X-Amz-Signature=test",
      expires_in_seconds: 900,
      kind: "audio",
      content_type: "audio/ogg",
    }),
  ),

  http.patch("*/api/v1/rooms/:roomId", async ({ request }) => {
    const body = (await request.json()) as { recording_policy?: unknown };
    if (
      body.recording_policy !== undefined &&
      body.recording_policy !== "off" &&
      body.recording_policy !== "on_request" &&
      body.recording_policy !== "always"
    ) {
      return HttpResponse.json({ detail: "Invalid recording_policy" }, { status: 422 });
    }
    return HttpResponse.json({
      recording_policy: body.recording_policy ?? "off",
      recording_kind: "audio",
    });
  }),
];
