/**
 * updateVoiceSettings — the client half of PATCH /rooms/{id}/voice-settings.
 * Pins the wire shape (method, path, body) and both result paths: the parsed
 * {activation, live} response, and the ApiError carrying the server's detail
 * (409 "no voice agent" is what the UI surfaces verbatim).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ApiError } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.updateVoiceSettings", () => {
  it("PATCHes the room's voice-settings endpoint with the mode", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { activation: "ptt", live: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.updateVoiceSettings("room-1", "ptt");

    expect(result).toEqual({ activation: "ptt", live: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url.endsWith("/api/v1/rooms/room-1/voice-settings")).toBe(true);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ activation: "ptt" });
  });

  it("carries live:false through so callers can say 'next call'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { activation: "off", live: false })),
    );
    await expect(api.updateVoiceSettings("room-1", "off")).resolves.toEqual({
      activation: "off",
      live: false,
    });
  });

  it("surfaces the server's detail on an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, {
          detail: "This room has no voice agent configured",
        }),
      ),
    );
    let thrown: ApiError | null = null;
    try {
      await api.updateVoiceSettings("room-1", "always");
    } catch (e) {
      thrown = e as ApiError;
    }
    expect(thrown?.status).toBe(409);
    expect(thrown?.detail).toBe("This room has no voice agent configured");
  });
});
