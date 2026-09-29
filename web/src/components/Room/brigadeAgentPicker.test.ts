import { describe, expect, it } from "vitest";
import { invitableAgents } from "./BrigadeAgentPicker";

describe("invitableAgents", () => {
  it("drops the seats you may not add (entitled: false) and keeps the rest", () => {
    const list = [
      { id: "majik", name: "Majik", description: "", entitled: true },
      { id: "shafen-claude-code", name: "Flow", description: "Shafen's Claude Code", entitled: false },
      { id: "sidekick", name: "Sidekick", description: "" },
    ];
    expect(invitableAgents(list).map((a) => a.id)).toEqual(["majik", "sidekick"]);
  });
});
