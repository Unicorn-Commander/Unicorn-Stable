import { describe, expect, it } from "vitest";
import { agentPresence, humanPresence } from "./agentStatus";

describe("presence with a guest's view of the roster", () => {
  it("draws the unknown badge when availability and its reason are null", () => {
    // A guest caller gets members rows with null availability and
    // availability_reason: the badge is "unknown", never a crash or a claim.
    const badge = agentPresence({ isOnline: false, availability: null, availabilityReason: null, name: "Persephone" });
    expect(badge.kind).toBe("unknown");
    expect(badge.stateText).toBe("unknown");
    expect(badge.label).toContain("Persephone");
    expect(agentPresence({}).kind).toBe("unknown");
    expect(agentPresence({ availability: undefined, availabilityReason: undefined }).kind).toBe("unknown");
  });

  it("still says connected for an agent that is in the call", () => {
    expect(agentPresence({ isOnline: true, availability: null, availabilityReason: null }).kind).toBe("connected");
    expect(humanPresence(undefined)).toBeNull();
  });
});
