/**
 * Retry policy for the avatar API — the storm guard.
 *
 * `/participants/me/avatar` was once observed being re-fetched ~30× under a
 * 401 with no backoff. These tests pin the policy that prevents that:
 * auth failures (401/403) never retry, transient failures (network, 408/429,
 * 5xx) retry with exponential backoff and a cap, and other 4xx fail fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module pulls in the auth + federation stores; stub both so this stays a
// pure-node test (no keycloak-js, no zustand persistence side effects).
vi.mock("@/services/auth", () => ({
  getToken: () => "test-token",
  refreshToken: async () => "test-token",
}));
vi.mock("@/stores/federationStore", () => ({
  useFederationStore: {
    getState: () => ({ accessibleInstances: [], activeInstanceId: null }),
    subscribe: () => () => {},
  },
}));

import {
  AVATAR_RETRY_BASE_DELAY_MS,
  AVATAR_RETRY_MAX_ATTEMPTS,
  AVATAR_RETRY_MAX_DELAY_MS,
  AvatarApiError,
  avatarRetryDelayMs,
  fetchMyAvatar,
  isRetriableAvatarError,
} from "./avatar";

const okBody = {
  effective_url: null,
  source: "none",
  keycloak_url: null,
  override_url: null,
  has_keycloak_picture: false,
  display_name: "Aaron",
  username: "aaron",
};

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

/** Run fn under fake timers, flushing every backoff sleep as it appears. */
async function withFlushedTimers<T>(fn: () => Promise<T>): Promise<T> {
  const p = fn();
  // Swallow here so a rejection is not "unhandled" between flushes; the
  // caller still sees it through the returned promise.
  p.catch(() => {});
  await vi.runAllTimersAsync();
  return p;
}

describe("avatar retry policy", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not retry a 401 — auth states do not self-heal by hammering", async () => {
    fetchMock.mockResolvedValue(response(401, { detail: "Not authenticated" }));
    await expect(withFlushedTimers(fetchMyAvatar)).rejects.toMatchObject({
      name: "AvatarApiError",
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 403", async () => {
    fetchMock.mockResolvedValue(response(403, { detail: "Forbidden" }));
    await expect(withFlushedTimers(fetchMyAvatar)).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry other 4xx (404 is a bug, not weather)", async () => {
    fetchMock.mockResolvedValue(response(404, { detail: "Not found" }));
    await expect(withFlushedTimers(fetchMyAvatar)).rejects.toMatchObject({
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx up to the attempt cap, then surfaces the error", async () => {
    fetchMock.mockResolvedValue(response(503, { detail: "Unavailable" }));
    await expect(withFlushedTimers(fetchMyAvatar)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(AVATAR_RETRY_MAX_ATTEMPTS);
  });

  it("retries a network failure and succeeds when the server recovers", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(response(500, { detail: "boom" }))
      .mockResolvedValueOnce(response(200, okBody));
    const state = await withFlushedTimers(fetchMyAvatar);
    expect(state.username).toBe("aaron");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops instantly when a retried request lands on 401", async () => {
    // Transient first, then the session dies: the 401 must end the loop even
    // though retries were already underway.
    fetchMock
      .mockResolvedValueOnce(response(502, { detail: "bad gateway" }))
      .mockResolvedValueOnce(response(401, { detail: "expired" }));
    await expect(withFlushedTimers(fetchMyAvatar)).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially between attempts", async () => {
    fetchMock.mockResolvedValue(response(500, { detail: "boom" }));
    const p = fetchMyAvatar();
    p.catch(() => {});
    // Attempt 1 fires immediately.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Backoff 1: nothing until 500ms have passed.
    await vi.advanceTimersByTimeAsync(AVATAR_RETRY_BASE_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Backoff 2 doubles.
    await vi.advanceTimersByTimeAsync(2 * AVATAR_RETRY_BASE_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.runAllTimersAsync();
    await expect(p).rejects.toBeInstanceOf(AvatarApiError);
  });
});

describe("retry classification helpers", () => {
  it("classifies statuses", () => {
    expect(isRetriableAvatarError(new AvatarApiError("x", 401))).toBe(false);
    expect(isRetriableAvatarError(new AvatarApiError("x", 403))).toBe(false);
    expect(isRetriableAvatarError(new AvatarApiError("x", 404))).toBe(false);
    expect(isRetriableAvatarError(new AvatarApiError("x", 408))).toBe(true);
    expect(isRetriableAvatarError(new AvatarApiError("x", 429))).toBe(true);
    expect(isRetriableAvatarError(new AvatarApiError("x", 500))).toBe(true);
    expect(isRetriableAvatarError(new AvatarApiError("x", null))).toBe(true);
    // Non-API errors (auth-layer throws, programming errors) never retry.
    expect(isRetriableAvatarError(new Error("keycloak refresh failed"))).toBe(
      false,
    );
  });

  it("caps the backoff curve", () => {
    expect(avatarRetryDelayMs(1)).toBe(AVATAR_RETRY_BASE_DELAY_MS);
    expect(avatarRetryDelayMs(2)).toBe(AVATAR_RETRY_BASE_DELAY_MS * 2);
    expect(avatarRetryDelayMs(3)).toBe(AVATAR_RETRY_BASE_DELAY_MS * 4);
    expect(avatarRetryDelayMs(10)).toBe(AVATAR_RETRY_MAX_DELAY_MS);
  });
});
