import { describe, expect, it } from "vitest";
import {
  composeStartGroupPayload,
  groupLabelFromPicks,
  isHumanPairDm,
  pickKey,
  togglePick,
  type StartGroupAgentPick,
  type StartGroupPersonPick,
  type StartGroupPick,
} from "./startGroupModel";

const person = (
  over: Partial<StartGroupPersonPick> = {},
): StartGroupPersonPick => ({
  kind: "user",
  id: "p-1",
  keycloak_sub: "kc-1",
  display_name: "Alice",
  username: "alice",
  ...over,
});

const agent = (over: Partial<StartGroupAgentPick> = {}): StartGroupAgentPick => ({
  kind: "agent",
  id: "perry",
  name: "Perrywinkle",
  ...over,
});

describe("pickKey", () => {
  it("keys people by participant id and agents by brigade id", () => {
    expect(pickKey(person())).toBe("user:p-1");
    expect(pickKey(agent())).toBe("agent:perry");
  });

  it("falls back to the keycloak sub for never-signed-in people", () => {
    expect(pickKey(person({ id: null }))).toBe("user:kc-1");
  });

  it("never collides a person with an agent sharing the same raw id", () => {
    expect(pickKey(person({ id: "perry" }))).not.toBe(pickKey(agent()));
  });
});

describe("togglePick", () => {
  it("adds when absent and removes when present", () => {
    const a = person();
    const b = agent();
    let picks: StartGroupPick[] = [];
    picks = togglePick(picks, a);
    picks = togglePick(picks, b);
    expect(picks).toEqual([a, b]);
    picks = togglePick(picks, a);
    expect(picks).toEqual([b]);
  });

  it("treats same-key picks as the same selection", () => {
    const first = person({ display_name: "Alice" });
    const rename = person({ display_name: "Alice Cooper" });
    const picks = togglePick(togglePick([], first), rename);
    expect(picks).toEqual([]);
  });
});

describe("groupLabelFromPicks", () => {
  it("pins the peer first, then people, then agents", () => {
    const label = groupLabelFromPicks("Bob", [
      agent({ id: "iris", name: "Iris" }),
      person({ display_name: "Cara" }),
    ]);
    expect(label).toBe("Group: Bob, Cara, Iris");
  });

  it("caps at three names", () => {
    const label = groupLabelFromPicks("Bob", [
      person({ id: "p1", display_name: "Cara" }),
      person({ id: "p2", display_name: "Dan" }),
      person({ id: "p3", display_name: "Eve" }),
    ]);
    expect(label).toBe("Group: Bob, Cara, Dan");
  });

  it("uses the username when a person has no display name", () => {
    const label = groupLabelFromPicks("Bob", [
      person({ display_name: "", username: "cara" }),
    ]);
    expect(label).toBe("Group: Bob, cara");
  });

  it("skips blank labels and has a last-resort fallback", () => {
    expect(groupLabelFromPicks("", [])).toBe("Group chat");
    expect(groupLabelFromPicks("  ", [agent()])).toBe("Group: Perrywinkle");
  });
});

describe("composeStartGroupPayload", () => {
  it("splits people into ids vs subs and keeps agent order verbatim", () => {
    const payload = composeStartGroupPayload([
      agent({ id: "iris", name: "Iris" }),
      person({ id: "p-1" }),
      person({ id: null, keycloak_sub: "kc-9", username: "newbie" }),
      agent({ id: "sgt-cipher", name: "Sgt Cipher" }),
    ]);
    expect(payload).toEqual({
      participant_ids: ["p-1"],
      keycloak_subs: ["kc-9"],
      // Order preserved — the server's last-invited-wins rule reads it.
      agent_ids: ["iris", "sgt-cipher"],
    });
  });

  it("dedupes repeated picks", () => {
    const payload = composeStartGroupPayload([
      person({ id: "p-1" }),
      person({ id: "p-1" }),
      agent(),
      agent(),
    ]);
    expect(payload.participant_ids).toEqual(["p-1"]);
    expect(payload.agent_ids).toEqual(["perry"]);
  });

  it("drops people already in the DM (the server seeds them itself)", () => {
    const payload = composeStartGroupPayload(
      [person({ id: "p-peer" }), person({ id: "p-new" })],
      { existingParticipantIds: ["p-me", "p-peer"] },
    );
    expect(payload.participant_ids).toEqual(["p-new"]);
  });
});

describe("isHumanPairDm (agent-bind routing guard)", () => {
  const me = { is_self: true, participant_type: "human" as const };
  const peer = { is_self: false, participant_type: "human" as const };
  const agentMember = { is_self: false, participant_type: "agent" as const };

  it("is true for a human 1:1 DM with a loaded human peer", () => {
    expect(isHumanPairDm({ type: "dm" }, [me, peer])).toBe(true);
  });

  it("treats a member row without participant_type as human (legacy rows)", () => {
    expect(isHumanPairDm({ type: "dm" }, [me, { is_self: false }])).toBe(true);
  });

  it("is false for an agent DM (brigade_agent_id present)", () => {
    expect(
      isHumanPairDm({ type: "dm", brigade_agent_id: "majik" }, [me, peer]),
    ).toBe(false);
  });

  it("is false for group_dm and channel rooms", () => {
    expect(isHumanPairDm({ type: "group_dm" }, [me, peer])).toBe(false);
    expect(isHumanPairDm({ type: "channel" }, [me, peer])).toBe(false);
  });

  it("is false when the only other member is an agent", () => {
    // A dm-type room whose peer is an agent member but whose binding was
    // cleared — no human peer to start a group with.
    expect(isHumanPairDm({ type: "dm" }, [me, agentMember])).toBe(false);
  });

  it("is false while room or members are not loaded (server 409 backstops)", () => {
    expect(isHumanPairDm(undefined, [me, peer])).toBe(false);
    expect(isHumanPairDm(null, [me, peer])).toBe(false);
    expect(isHumanPairDm({ type: "dm" }, undefined)).toBe(false);
    expect(isHumanPairDm({ type: "dm" }, [])).toBe(false);
    expect(isHumanPairDm({ type: "dm" }, [me])).toBe(false);
  });
});
