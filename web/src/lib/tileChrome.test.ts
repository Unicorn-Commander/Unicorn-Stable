import { describe, expect, it } from "vitest";
import {
  LOWER_THIRD_HOLD_MS,
  agentRosterRole,
  broadcastLowerThirdOptIn,
  humanTitleFromMember,
  localTilePlate,
  lowerThirdLayoutForCall,
  lowerThirdPhase,
  resolveLocalDisplayName,
  resolveLowerThirdSubtitle,
  roomLowerThirdOptIn,
  subtitleFromMetadata,
  withLowerThirdParam,
} from "./tileChrome";

describe("local tile name", () => {
  it("uses the account display name, then the LiveKit name, then the username", () => {
    expect(
      resolveLocalDisplayName({
        displayName: "Aaron Stransky",
        liveKitName: "Token Name",
        username: "aaron",
      }),
    ).toBe("Aaron Stransky");
    expect(
      resolveLocalDisplayName({ displayName: "  ", liveKitName: "Token Name" }),
    ).toBe("Token Name");
    expect(
      resolveLocalDisplayName({ liveKitName: "", username: "aaron" }),
    ).toBe("aaron");
    expect(resolveLocalDisplayName({})).toBe("");
  });

  it("prints the display name with a small (you), and You only when there is no name", () => {
    expect(localTilePlate("Aaron Stransky")).toBe("Aaron Stransky (you)");
    expect(localTilePlate("")).toBe("You");
    expect(localTilePlate("   ")).toBe("You");
    // The no-name fallback is the word You. Don't turn that into "You (you)".
    expect(localTilePlate("You")).toBe("You");
  });
});

describe("lower third phase", () => {
  it("shows on a stage for a new speaker and hides after the hold", () => {
    expect(LOWER_THIRD_HOLD_MS).toBe(4000);
    const base = {
      optedIn: true,
      layout: "stage" as const,
      speakerId: "ada",
    };
    expect(lowerThirdPhase({ ...base, heldMs: 0 })).toBe("shown");
    expect(lowerThirdPhase({ ...base, heldMs: 3999 })).toBe("shown");
    expect(lowerThirdPhase({ ...base, heldMs: 4000 })).toBe("hidden");
  });

  it("hides when nobody is speaking or the call has not opted in", () => {
    expect(
      lowerThirdPhase({
        optedIn: true,
        layout: "stage",
        speakerId: null,
        heldMs: 0,
      }),
    ).toBe("hidden");
    expect(
      lowerThirdPhase({
        optedIn: false,
        layout: "stage",
        speakerId: "ada",
        heldMs: 0,
      }),
    ).toBe("hidden");
  });

  it("never shows in compact or on the filmstrip", () => {
    for (const layout of ["compact", "filmstrip"] as const) {
      expect(
        lowerThirdPhase({
          optedIn: true,
          layout,
          speakerId: "ada",
          heldMs: 0,
        }),
      ).toBe("hidden");
    }
  });

  it("maps call layouts: stage yes, compact and the filmstrip region no", () => {
    expect(
      lowerThirdLayoutForCall({
        viewMode: "spotlight",
        showChips: false,
        region: "stage",
      }),
    ).toBe("stage");
    expect(
      lowerThirdLayoutForCall({
        viewMode: "grid",
        showChips: false,
        region: "stage",
      }),
    ).toBe("stage");
    expect(
      lowerThirdLayoutForCall({
        viewMode: "compact",
        showChips: false,
        region: "stage",
      }),
    ).toBe("compact");
    expect(
      lowerThirdLayoutForCall({
        viewMode: "grid",
        showChips: true,
        region: "stage",
      }),
    ).toBe("compact");
    expect(
      lowerThirdLayoutForCall({
        viewMode: "spotlight",
        showChips: false,
        region: "filmstrip",
      }),
    ).toBe("filmstrip");
    expect(
      lowerThirdLayoutForCall({
        viewMode: "screen",
        showChips: false,
        region: "filmstrip",
      }),
    ).toBe("filmstrip");
  });
});

describe("broadcast opt-in", () => {
  it("stays off unless the token URL or the room asks", () => {
    expect(broadcastLowerThirdOptIn({ search: "" })).toBe(false);
    expect(broadcastLowerThirdOptIn({ search: "?token=sbt-abc" })).toBe(false);
    expect(broadcastLowerThirdOptIn({ search: "?lowerThird=0" })).toBe(false);
    expect(broadcastLowerThirdOptIn({ search: "?lowerThird=1" })).toBe(true);
    expect(broadcastLowerThirdOptIn({ search: "?lowerThird=yes" })).toBe(true);
    expect(broadcastLowerThirdOptIn({ roomOptIn: false })).toBe(false);
    expect(broadcastLowerThirdOptIn({ roomOptIn: true })).toBe(true);
  });

  it("does not treat the relay face plate as a lower-third opt-in", () => {
    expect(roomLowerThirdOptIn({ voice_relay_face_plate: true })).toBe(false);
    expect(roomLowerThirdOptIn({ voice_relay_face_plate: "false" })).toBe(
      false,
    );
    expect(roomLowerThirdOptIn(undefined)).toBe(false);
    expect(roomLowerThirdOptIn({ lower_third: true })).toBe(true);
    expect(roomLowerThirdOptIn({ lower_third: "yes" })).toBe(true);
    expect(roomLowerThirdOptIn({ lower_third: "no" })).toBe(false);
  });

  it("adds the flag to a broadcast URL only when asked", () => {
    const bare =
      "https://stable.example/broadcast/r/p?token=sbt-abc&source=screen";
    expect(withLowerThirdParam(bare, false)).toBe(bare);
    const on = new URL(withLowerThirdParam(bare, true));
    expect(on.searchParams.get("token")).toBe("sbt-abc");
    expect(on.searchParams.get("source")).toBe("screen");
    expect(on.searchParams.get("lowerThird")).toBe("1");
  });
});

describe("lower third subtitle", () => {
  const roster = [
    { id: "majik", name: "Majik", display_name: "Majik", title: "Show host" },
    { id: "rook", name: "Rook", display_name: "Rook", title: "  " },
  ];

  it("uses the agent's roster role, including when the worker id is the room persona", () => {
    expect(agentRosterRole("agent-majik", "Majik", roster)).toBe("Show host");
    expect(agentRosterRole("stable-brigade", "Majik", roster, "majik")).toBe(
      "Show host",
    );
    expect(agentRosterRole("agent-rook", "Rook", roster)).toBeNull();
    expect(agentRosterRole("agent-unknown", "Nope", roster)).toBeNull();
  });

  it("reads a human title only when one is set", () => {
    expect(humanTitleFromMember({ display_name: "Aaron Stransky" })).toBeNull();
    expect(humanTitleFromMember({ title: "  " })).toBeNull();
    expect(humanTitleFromMember({ title: "Founder" })).toBe("Founder");
    expect(humanTitleFromMember(null)).toBeNull();
  });

  it("prefers the roster role for agents and the title for humans", () => {
    expect(
      resolveLowerThirdSubtitle({
        isAgent: true,
        agentRole: "Show host",
        humanTitle: "Founder",
        metadata: JSON.stringify({ title: "Metadata" }),
      }),
    ).toBe("Show host");
    expect(
      resolveLowerThirdSubtitle({
        isAgent: false,
        humanTitle: "Founder",
        metadata: JSON.stringify({ role: "Metadata" }),
      }),
    ).toBe("Founder");
    expect(
      resolveLowerThirdSubtitle({
        isAgent: false,
        metadata: JSON.stringify({ role: "Guest host" }),
      }),
    ).toBe("Guest host");
    expect(subtitleFromMetadata("not json")).toBeNull();
    expect(subtitleFromMetadata("")).toBeNull();
  });
});
