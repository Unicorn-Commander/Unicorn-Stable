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
