import { describe, expect, it } from "vitest";
import { compactSince } from "./SeatCards";

describe("how long a seat has been at it", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  it("fits a card: now, minutes, hours, days", () => {
    expect(compactSince(ago(0), now)).toBe("now");
    expect(compactSince(ago(2), now)).toBe("2m");
    expect(compactSince(ago(59), now)).toBe("59m");
    expect(compactSince(ago(60), now)).toBe("1h");
    expect(compactSince(ago(47 * 60), now)).toBe("47h");
    expect(compactSince(ago(72 * 60), now)).toBe("3d");
  });

  it("says nothing for a stamp it cannot read, and never a negative time", () => {
    expect(compactSince(null, now)).toBeNull();
    expect(compactSince("soon", now)).toBeNull();
    expect(compactSince(new Date(now + 5 * 60_000).toISOString(), now)).toBe("now");
  });
});
