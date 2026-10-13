import { beforeEach, describe, expect, it } from "vitest";

import { configureRuntimeHosts, isRuntimeHostAllowed } from "@/lib/runtimeHosts";

describe("runtime host allowlist", () => {
  beforeEach(() => {
    configureRuntimeHosts([
      {
        webOrigin: "https://stable.example.com",
        apiBaseUrl: "https://api.example.com/v1",
        keycloak: { url: "https://auth.example.com" },
        trustedOrigins: "*.assets.example.com",
      },
    ]);
  });

  it("accepts configured exact and wildcard hosts", () => {
    expect(isRuntimeHostAllowed("stable.example.com")).toBe(true);
    expect(isRuntimeHostAllowed("api.example.com")).toBe(true);
    expect(isRuntimeHostAllowed("cdn.assets.example.com")).toBe(true);
  });

  it("rejects lookalike hosts outside the descriptor", () => {
    expect(isRuntimeHostAllowed("stable.example.com.evil.test")).toBe(false);
    expect(isRuntimeHostAllowed("assets.example.com.evil.test")).toBe(false);
  });
});
