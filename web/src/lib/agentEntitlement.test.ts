import { describe, expect, it } from "vitest";

import {
  apiErrorText,
  isAgentEntitled,
  isEntitlementDenial,
} from "./agentEntitlement";

describe("isAgentEntitled", () => {
  it("locks only an explicit entitled:false", () => {
    expect(isAgentEntitled({ entitled: false })).toBe(false);
  });

  it("treats explicit entitled:true as entitled", () => {
    expect(isAgentEntitled({ entitled: true })).toBe(true);
  });

  it("defaults to entitled when the server does not annotate (old server)", () => {
    expect(isAgentEntitled({})).toBe(true);
    expect(isAgentEntitled(null)).toBe(true);
    expect(isAgentEntitled(undefined)).toBe(true);
  });
});

describe("isEntitlementDenial", () => {
  it("recognizes the server's 403", () => {
    expect(
      isEntitlementDenial({
        status: 403,
        message: "Forbidden",
        detail: "You don't have access to the agent 'the-colonel'.",
      }),
    ).toBe(true);
  });

  it("does not flag other failures", () => {
    expect(isEntitlementDenial({ status: 502, message: "Bad Gateway" })).toBe(
      false,
    );
    expect(isEntitlementDenial(new Error("network down"))).toBe(false);
    expect(isEntitlementDenial(undefined)).toBe(false);
  });
});

describe("apiErrorText", () => {
  it("prefers the server's clean detail over statusText", () => {
    expect(
      apiErrorText(
        {
          status: 403,
          message: "Forbidden",
          detail: "You don't have access to the agent 'the-colonel'.",
        },
        "fallback",
      ),
    ).toBe("You don't have access to the agent 'the-colonel'.");
  });

  it("falls back to statusText, then Error.message, then the fallback", () => {
    expect(
      apiErrorText({ status: 500, message: "Server Error", detail: null }, "x"),
    ).toBe("Server Error");
    expect(apiErrorText(new Error("boom"), "x")).toBe("boom");
    expect(apiErrorText("weird", "fallback")).toBe("fallback");
  });
});
