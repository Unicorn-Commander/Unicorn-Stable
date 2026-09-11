import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());
it("opens a runner's canonical room without POST or invite", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      response({ backend: "runner", room_id: "canonical" }),
    )
    .mockResolvedValueOnce(
      response({
        id: "canonical",
        name: "seat",
        display_name: "Seat",
        room_type: "dm",
        members: [],
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const room = await api.createAgentDm("seat", "Chat with wrong default");
  expect(room.id).toBe("canonical");
  expect(fetcher.mock.calls.map((c) => c[1].method)).toEqual(["GET", "GET"]);
  expect(fetcher.mock.calls[0]![0]).toContain(
    "/brigade/agents/seat/chat-route",
  );
});
it("does not mint a runner room when provisioning is missing", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      response({ detail: "Runner chat is not configured" }, 409),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    api.createAgentDm("seat", "Chat with Seat"),
  ).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects mixed runner groups before creation", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(response({ backend: "runner", room_id: "canonical" }));
  vi.stubGlobal("fetch", fetcher);
  await expect(api.requireBrigadeAgents(["seat"])).rejects.toThrow(
    "existing chat",
  );
  expect(fetcher.mock.calls.every((c) => c[1].method === "GET")).toBe(true);
});
it("preserves the Brigade create and bind route", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ backend: "brigade", room_id: null }))
    .mockResolvedValueOnce(
      response({ id: "new-room", name: "chat-with-selected", room_type: "dm" }),
    )
    .mockResolvedValueOnce(response({}));
  vi.stubGlobal("fetch", fetcher);
  await api.createAgentDm("selected", "Chat with Selected");
  expect(fetcher.mock.calls.map((c) => c[1].method)).toEqual([
    "GET",
    "POST",
    "POST",
  ]);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).name).toBe(
    "chat-with-selected",
  );
  expect(JSON.parse(fetcher.mock.calls[2]![1].body).brigade_agent_id).toBe(
    "selected",
  );
});
