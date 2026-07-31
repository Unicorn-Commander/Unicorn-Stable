import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshClientAccessToken } from "./auth";

const client = {
  token: "fresh-token",
  updateToken: vi.fn(async () => true),
};

describe("forced reconnect token refresh", () => {
  beforeEach(() => {
    client.token = "fresh-token";
    client.updateToken.mockClear();
  });

  it("uses keycloak-js's negative minValidity force-refresh sentinel", async () => {
    await expect(refreshClientAccessToken(client, -1)).resolves.toBe(
      "fresh-token",
    );
    expect(client.updateToken).toHaveBeenLastCalledWith(-1);
  });
});

import { isAccessTokenUsable, readAccessTokenExpMs } from "./auth";

function fakeJwt(expSecondsFromNow: number): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  );
  return `${header}.${payload}.sig`;
}

describe("access token usability", () => {
  it("rejects null/empty", () => {
    expect(isAccessTokenUsable(null)).toBe(false);
    expect(isAccessTokenUsable("")).toBe(false);
  });

  it("rejects expired tokens", () => {
    expect(isAccessTokenUsable(fakeJwt(-60))).toBe(false);
  });

  it("accepts tokens with remaining life", () => {
    expect(isAccessTokenUsable(fakeJwt(120))).toBe(true);
  });

  it("reads exp ms", () => {
    const exp = readAccessTokenExpMs(fakeJwt(0));
    expect(exp).not.toBeNull();
    expect(Math.abs((exp as number) - Date.now())).toBeLessThan(2000);
  });
});
