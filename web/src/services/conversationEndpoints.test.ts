/**
 * L2 has not shipped POST /rooms/for-project or GET /rooms/{id}/tasks.
 * These tests mock those two routes with MSW and prove the client speaks
 * the contract. The panels call the real methods and surface a 404 honestly.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { api } from "./api";
import { useFederationStore } from "@/stores/federationStore";

const server = setupServer(
  http.get("*/api/v1/rooms/:roomId/tasks", () =>
    HttpResponse.json([
      {
        id: "task-1",
        title: "Ship the chip",
        status: "IN_PROGRESS",
        due_date: "2026-09-30",
        project_number: "P-00115",
        assignee: {
          participant_id: "aaron",
          display_name: "Aaron",
          avatar_url: "https://cdn.magicunicorn.dev/aaron.png",
          kind: "human",
        },
      },
    ]),
  ),
  http.post("*/api/v1/rooms/for-project", async ({ request }) => {
    const body = (await request.json()) as { project_number?: string };
    return HttpResponse.json({
      id: "room-project",
      name: "p-00115-stable",
      display_name: "P-00115",
      description: null,
      room_type: "channel",
      created_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
      member_count: 1,
      visibility: "private",
      project_number: body.project_number,
    });
  }),
);

beforeAll(() => {
  useFederationStore.setState({
    activeInstanceId: "test",
    accessibleInstances: [
      {
        id: "test",
        name: "Test",
        webOrigin: "http://stable.test",
        apiBaseUrl: "http://stable.test",
        keycloak: { url: "http://stable.test", realm: "stable", clientId: "stable-web" },
      },
    ],
  });
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("reads project tasks from GET /rooms/{id}/tasks", async () => {
  const tasks = await api.getRoomTasks("room-1");
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.title).toBe("Ship the chip");
  expect(tasks[0]?.assignee?.display_name).toBe("Aaron");
});

it("opens a project channel from POST /rooms/for-project", async () => {
  const room = await api.ensureProjectChannel("P-00115");
  expect(room.id).toBe("room-project");
  expect(room.visibility).toBe("private");
  expect(room.project_number).toBe("P-00115");
  expect(room.type).toBe("channel");
});
