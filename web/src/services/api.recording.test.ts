/**
 * Recording routes against the MSW stand-in (L8s still answers 409 on the
 * real server). Pins method, path, and body for start / stop / list / policy.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { recordingHandlers } from "@/mocks/recordingHandlers";
import { api, type ApiError } from "./api";

const server = setupServer(...recordingHandlers);

beforeAll(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://127.0.0.1");
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

describe("recording API (MSW until L8s)", () => {
  it("starts an audio or video recording", async () => {
    await expect(api.startRecording("room-1", "audio")).resolves.toMatchObject({
      active: true,
      kind: "audio",
    });
    await expect(api.startRecording("room-1", "composite")).resolves.toMatchObject({
      kind: "composite",
    });
  });

  it("stops a recording", async () => {
    await expect(api.stopRecording("room-1")).resolves.toMatchObject({ active: false });
  });

  it("lists the room's recordings", async () => {
    const rows = await api.listRecordings("room-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      kind: "audio",
      started_by_name: "Aaron",
      duration_seconds: 724,
      session_url: "https://meetingops.example/sessions/mo-1",
    });
  });

  it("patches the room recording policy", async () => {
    await expect(api.updateRecordingPolicy("room-1", "on_request")).resolves.toMatchObject({
      recording_policy: "on_request",
    });
  });

  it("surfaces a refusal", async () => {
    server.use(
      http.post("*/api/v1/rooms/:roomId/recording/start", () =>
        HttpResponse.json(
          { detail: "Recording controls are not enabled yet" },
          { status: 409 },
        ),
      ),
    );
    let thrown: ApiError | null = null;
    try {
      await api.startRecording("room-1", "audio");
    } catch (error) {
      thrown = error as ApiError;
    }
    expect(thrown?.status).toBe(409);
    expect(thrown?.detail).toBe("Recording controls are not enabled yet");
  });
});
