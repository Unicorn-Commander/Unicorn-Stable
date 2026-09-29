import { describe, expect, it } from "vitest";
import { CREW_RETRIES, crewRetry } from "./useCrew";

describe("crewRetry (review 2, P2-7)", () => {
  it("retries a failing /crew twice before it counts", () => {
    expect(CREW_RETRIES).toBe(2);
    const outage = { status: 503 };
    expect(crewRetry(0, outage)).toBe(true);
    expect(crewRetry(1, outage)).toBe(true);
    expect(crewRetry(2, outage)).toBe(false);
    // No answer at all (a network error, a timeout) is retried the same way.
    expect(crewRetry(0, new Error("Failed to fetch"))).toBe(true);
  });

  it("does not retry a server that has no /crew: the roster is its answer", () => {
    expect(crewRetry(0, { status: 404 })).toBe(false);
  });
});
