/**
 * Voice-settings model — the non-rendering half of the settings surface:
 * has-a-voice-agent + owner/admin gating (what decides whether the control
 * exists at all), the mode → human-language mapping, the agent-name
 * resolution, the toast copy, and the relay_config → room-query reconcile.
 */
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Room, RoomMember } from "@/services/api";
import {
  applyRelayConfigToRoomQueries,
  canEditVoiceSettings,
  FALLBACK_AGENT_NAME,
  VOICE_ACTIVATION_MODES,
  voiceActivationOptions,
  voiceAgentDisplayName,
  voiceRelayActivation,
  voiceRelaySource,
  voiceSettingsSavedToast,
  voiceRelayFlag,
} from "./voiceSettings";

function member(over: Partial<RoomMember> = {}): RoomMember {
  return {
    username: "aaron",
    display_name: "Aaron",
    role: "member",
    joined_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("voiceRelaySource (does the room HAVE a voice agent)", () => {
  it("is the trimmed username when present", () => {
    expect(voiceRelaySource({ voice_relay_source: "rook" })).toBe("rook");
    expect(voiceRelaySource({ voice_relay_source: "  rook " })).toBe("rook");
  });

  it("is null for absent, empty, whitespace, or non-string values", () => {
    expect(voiceRelaySource(null)).toBeNull();
    expect(voiceRelaySource(undefined)).toBeNull();
    expect(voiceRelaySource({})).toBeNull();
    expect(voiceRelaySource({ voice_relay_source: "" })).toBeNull();
    expect(voiceRelaySource({ voice_relay_source: "   " })).toBeNull();
    expect(voiceRelaySource({ voice_relay_source: 42 })).toBeNull();
  });
});

describe("voiceRelayActivation", () => {
  it("reads a valid mode and defaults absent/unknown to 'name'", () => {
    expect(voiceRelayActivation({ voice_relay_activation: "ptt" })).toBe("ptt");
    expect(voiceRelayActivation({})).toBe("name");
    expect(voiceRelayActivation(null)).toBe("name");
    expect(voiceRelayActivation({ voice_relay_activation: "loud" })).toBe(
      "name",
    );
  });
});

describe("canEditVoiceSettings (owner/admin ladder)", () => {
  it("owner and admin may, member and guest may not", () => {
    expect(
      canEditVoiceSettings([member({ is_self: true, role: "owner" })]),
    ).toBe(true);
    expect(
      canEditVoiceSettings([member({ is_self: true, role: "admin" })]),
    ).toBe(true);
    expect(
      canEditVoiceSettings([member({ is_self: true, role: "member" })]),
    ).toBe(false);
    expect(
      canEditVoiceSettings([member({ is_self: true, role: "guest" })]),
    ).toBe(false);
  });

  it("no self row / no members ⇒ no control (never trust a guess)", () => {
    expect(canEditVoiceSettings([member({ role: "owner" })])).toBe(false);
    expect(canEditVoiceSettings([])).toBe(false);
    expect(canEditVoiceSettings(undefined)).toBe(false);
  });

  it("reads MY row, not somebody else's", () => {
    expect(
      canEditVoiceSettings([
        member({ username: "rook", role: "owner" }),
        member({ is_self: true, role: "member" }),
      ]),
    ).toBe(false);
  });
});

describe("voiceAgentDisplayName", () => {
  const rookMember = member({
    username: "rook",
    display_name: "Rook",
    participant_type: "agent",
  });

  it("resolves the member whose username equals voice_relay_source", () => {
    expect(voiceAgentDisplayName([member(), rookMember], "rook")).toBe("Rook");
  });

  it("falls back to the generic name rather than parroting a username", () => {
    expect(voiceAgentDisplayName([member()], "rook")).toBe(
      FALLBACK_AGENT_NAME,
    );
    expect(voiceAgentDisplayName(undefined, "rook")).toBe(FALLBACK_AGENT_NAME);
    expect(voiceAgentDisplayName([rookMember], null)).toBe(
      FALLBACK_AGENT_NAME,
    );
    expect(
      voiceAgentDisplayName(
        [member({ username: "rook", display_name: "  " })],
        "rook",
      ),
    ).toBe(FALLBACK_AGENT_NAME);
  });
});

describe("voiceActivationOptions (mode → human language)", () => {
  /** Option for a mode, or a loud failure — never a silent undefined. */
  function opt(agentName: string, mode: string) {
    const found = voiceActivationOptions(agentName).find(
      (o) => o.mode === mode,
    );
    if (!found) throw new Error(`no option for mode ${mode}`);
    return found;
  }

  it("covers every mode, default first, window second, off last", () => {
    const options = voiceActivationOptions("Rook");
    expect(options.map((o) => o.mode)).toEqual([...VOICE_ACTIVATION_MODES]);
    expect(options.at(0)?.mode).toBe("name");
    expect(options.at(-1)?.mode).toBe("off");
  });

  it("speaks human, not wire ids, and weaves the agent's real name in", () => {
    expect(opt("Rook", "name").label).toBe("Only when named — say “Rook, …”");
    expect(opt("Rook", "window").label).toBe("Named line, then a conversation");
    expect(opt("Rook", "window").description).toContain("Rook");
    expect(opt("Rook", "always").label).toBe("Everything I say");
    expect(opt("Rook", "ptt").label).toBe("Only while my talk key is held");
    expect(opt("Rook", "off").label).toBe("Never — transcript only");
    // No option's label is its bare wire id.
    for (const o of voiceActivationOptions("Rook")) {
      expect(o.label).not.toBe(o.mode);
    }
    // The name mode names the agent; descriptions do too.
    expect(opt("Rook", "name").label).toContain("Rook");
    expect(opt("Rook", "ptt").description).toContain("Rook");
  });

  it("degrades a blank agent name to the generic fallback", () => {
    expect(opt("   ", "name").label).toContain(FALLBACK_AGENT_NAME);
  });
});

describe("voiceSettingsSavedToast", () => {
  const option = { label: "Everything I say" };

  it("live change says the call switched immediately", () => {
    const t = voiceSettingsSavedToast(option, true, true);
    expect(t.body).toContain("immediately");
  });

  it("saved-not-live DURING a call here says it waits for the next call", () => {
    const t = voiceSettingsSavedToast(option, false, true);
    expect(t.body.toLowerCase()).toContain("next call");
    expect(t.body.toLowerCase()).toContain("current call");
  });

  it("saved-not-live outside a call simply applies from the next call", () => {
    const t = voiceSettingsSavedToast(option, false, false);
    expect(t.body.toLowerCase()).toContain("next call");
  });
});

describe("applyRelayConfigToRoomQueries (relay_config reconcile)", () => {
  function seededClient(): { qc: QueryClient; room: Room } {
    const qc = new QueryClient();
    const room = {
      id: "room-1",
      name: "Ops",
      description: "",
      type: "channel",
      created_at: "",
      updated_at: "",
      member_count: 2,
      unread_count: 0,
      last_message: null,
      members: [],
      agents: [],
      metadata_: { voice_relay_source: "rook", voice_relay_activation: "name" },
    } as Room;
    qc.setQueryData(["room", "room-1"], room);
    return { qc, room };
  }

  it("patches the cached mode and invalidates the query", () => {
    const { qc } = seededClient();
    applyRelayConfigToRoomQueries(qc, "room-1", "always");
    const cached = qc.getQueryData<Room>(["room", "room-1"]);
    expect(cached?.metadata_?.voice_relay_activation).toBe("always");
    // The rest of the metadata (the has-agent fact) is preserved.
    expect(cached?.metadata_?.voice_relay_source).toBe("rook");
    expect(qc.getQueryState(["room", "room-1"])?.isInvalidated).toBe(true);
  });

  it("leaves an un-fetched room alone (no fabricated cache entry)", () => {
    const qc = new QueryClient();
    applyRelayConfigToRoomQueries(qc, "room-9", "off");
    expect(qc.getQueryData(["room", "room-9"])).toBeUndefined();
  });
});

describe("voiceRelayFlag", () => {
  it("defaults to off and reads every spelling the row can hold", () => {
    expect(voiceRelayFlag(undefined, "voice_relay_video")).toBe(false);
    expect(voiceRelayFlag({}, "voice_relay_video")).toBe(false);
    expect(voiceRelayFlag({ voice_relay_video: true }, "voice_relay_video")).toBe(true);
    expect(voiceRelayFlag({ voice_relay_video: "true" }, "voice_relay_video")).toBe(true);
    expect(voiceRelayFlag({ voice_relay_video: "false" }, "voice_relay_video")).toBe(false);
    expect(voiceRelayFlag({ voice_relay_multi: 1 }, "voice_relay_multi")).toBe(true);
    expect(voiceRelayFlag({ voice_relay_multi: "junk" }, "voice_relay_multi")).toBe(false);
  });
});
