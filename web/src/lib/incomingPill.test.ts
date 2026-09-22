import { beforeEach, describe, expect, it } from "vitest";
import {
  decideIncomingPill,
  resetIncomingPillMemory,
  type IncomingPillMessage,
} from "./incomingPill";

function msg(id: string, text = "hello", senderId = "other"): IncomingPillMessage {
  return { id, text, senderId, senderName: "Ada" };
}

describe("decideIncomingPill", () => {
  beforeEach(() => resetIncomingPillMemory());

  it("treats the first id as a baseline and shows the next one", () => {
    expect(decideIncomingPill("room", msg("m1"), null).action).toBe("baseline");
    const shown = decideIncomingPill("room", msg("m2", "  hi   there "), null);
    expect(shown).toEqual({ action: "show", line: "Ada: hi there" });
  });

  it("does not swallow the next message after the pill remounts", () => {
    expect(decideIncomingPill("room", msg("m1"), null).action).toBe("baseline");
    expect(decideIncomingPill("room", msg("m2"), null).action).toBe("show");
    // A Video → Split → Video remount used to null the ref and baseline m3.
    expect(decideIncomingPill("room", msg("m3"), "me").action).toBe("show");
  });

  it("ignores the same id, your own send, and a blank line without sticking", () => {
    decideIncomingPill("room", msg("m1"), null);
    expect(decideIncomingPill("room", msg("m1"), null).action).toBe("ignore");
    expect(decideIncomingPill("room", msg("m2", "mine", "me"), "me").action).toBe(
      "ignore",
    );
    expect(decideIncomingPill("room", msg("m3", "   "), null).action).toBe("ignore");
    expect(decideIncomingPill("room", msg("m4", "back"), null).action).toBe("show");
  });

  it("keeps rooms apart", () => {
    expect(decideIncomingPill("a", msg("m1"), null).action).toBe("baseline");
    expect(decideIncomingPill("b", msg("m1"), null).action).toBe("baseline");
    expect(decideIncomingPill("a", msg("m2"), null).action).toBe("show");
  });
});
