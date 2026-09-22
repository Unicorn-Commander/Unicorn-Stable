/**
 * Every rung of resolveIdentity. Colour (`identityFor`) is not under test here.
 */
import { describe, expect, it } from "vitest";
import manifest from "../../public/agent-puppets/manifest.json";
import { brandAvatarFor } from "@/lib/brandAvatars";
import {
  EXTERNAL_VENDOR_AGENT_IDS,
  resolveIdentity,
  type ResolvedIdentity,
} from "@/lib/identity";

const KC = "https://cdn.magicunicorn.dev/aaron.png";
const OVERRIDE = "https://cdn.magicunicorn.dev/override.png";
const ROSTER = "https://brigade.magicunicorn.dev/avatars/custom.png";
const GRAVATAR = "https://www.gravatar.com/avatar/abc?d=404";

function human(extra: Record<string, unknown> = {}): ResolvedIdentity {
  return resolveIdentity({
    id: "p-aaron",
    display_name: "Aaron Stransky",
    participant_type: "human",
    ...extra,
  });
}

describe("resolveIdentity humans", () => {
  it("prefers the Stable override over the Keycloak picture", () => {
    const face = human({ override_url: OVERRIDE, avatar_url: KC });
    expect(face.kind).toBe("human");
    expect(face.src).toBe(OVERRIDE);
    expect(face.fallbacks).toEqual([KC]);
    expect(face.ring).toBe("none");
    expect(face.needsPhoto).toBeFalsy();
  });

  it("uses participant.avatar_url as the Keycloak picture when there is no override", () => {
    const face = human({ avatar_url: KC });
    expect(face.src).toBe(KC);
    expect(face.fallbacks).toEqual([]);
  });

  it("reads the camelCase signed-in user", () => {
    const face = resolveIdentity({
      id: "kc-sub",
      displayName: "Aaron Stransky",
      avatarUrl: KC,
      email: "aaron@example.com",
      username: "aaron",
      roles: ["user"],
      is_self: true,
    });
    expect(face.kind).toBe("human");
    expect(face.name).toBe("Aaron Stransky");
    expect(face.src).toBe(KC);
    expect(face.needsPhoto).toBeFalsy();
  });

  it("drops a third-party picture and leaves initials as the last rung", () => {
    const face = human({ avatar_url: GRAVATAR, is_self: true });
    expect(face.src).toBeNull();
    expect(face.fallbacks).toEqual([]);
    expect(face.kind).toBe("human");
    expect(face.needsPhoto).toBe(true);
  });

  it("walks override → keycloak → effective on the avatar API state", () => {
    const face = resolveIdentity({
      effective_url: OVERRIDE,
      source: "override",
      keycloak_url: KC,
      override_url: OVERRIDE,
      has_keycloak_picture: true,
      display_name: "Aaron Stransky",
      username: "aaron",
    });
    expect(face.src).toBe(OVERRIDE);
    expect(face.fallbacks).toEqual([KC]);
    expect(face.needsPhoto).toBe(false);
  });

  it("rejects javascript and protocol-relative URLs", () => {
    expect(human({ avatar_url: "javascript:alert(1)" }).src).toBeNull();
    expect(human({ avatar_url: "//evil.example/a.png" }).src).toBeNull();
    expect(human({ avatar_url: "http://cdn.magicunicorn.dev/a.png" }).src).toBeNull();
  });
});

describe("resolveIdentity agents", () => {
  it("uses the bundled puppet ahead of an allowlisted roster URL", () => {
    const face = resolveIdentity({
      id: "majik",
      display_name: "Majik",
      participant_type: "agent",
      avatar_url: ROSTER,
    });
    expect(face.kind).toBe("agent");
    expect(face.src).toBe(brandAvatarFor("majik"));
    expect(face.src).toBe("/agent-puppets/majik.webp");
    expect(face.fallbacks).toEqual([ROSTER]);
    expect(face.ring).toBe("amber");
    expect(face.needsPhoto).toBeFalsy();
  });

  it("uses an allowlisted roster URL when no puppet ships", () => {
    const face = resolveIdentity({
      id: "no-such-agent-zz",
      display_name: "Unpainted",
      participant_type: "agent",
      avatar_url: ROSTER,
    });
    expect(face.src).toBe(ROSTER);
    expect(face.fallbacks).toEqual([]);
    expect(face.ring).toBe("amber");
  });

  it("drops an unsafe roster URL and does not invent initials (src null → unicorn)", () => {
    const face = resolveIdentity({
      id: "no-such-agent-zz",
      display_name: "Unpainted",
      participant_type: "agent",
      avatar_url: "https://evil.example/track.png",
      emoji: "🤖",
    });
    expect(face.kind).toBe("agent");
    expect(face.src).toBeNull();
    expect(face.fallbacks).toEqual([]);
  });

  it("keeps a shipped member-row texture ahead of the slug's generic puppet", () => {
    const face = resolveIdentity({
      id: "claude-code",
      display_name: "Claude Code",
      participant_type: "agent",
      art_url: "/agent-puppets/rook.webp",
      avatar_url: ROSTER,
    });
    expect(face.src).toBe("/agent-puppets/rook.webp");
    // The slug's puppet is the same Rook texture, so it is not a second rung.
    expect(face.fallbacks).toEqual([ROSTER]);
  });

  it("gives external vendor agents a grey ring", () => {
    const face = resolveIdentity({
      id: "grok",
      display_name: "Grok",
      participant_type: "agent",
    });
    expect(face.ring).toBe("grey");
    expect(face.src).toBe("/agent-puppets/grok.webp");
  });

  it("matches the puppet manifest's external set", () => {
    const rows = manifest as unknown as Record<string, { kind?: string }>;
    const external = Object.entries(rows)
      .filter(([, row]) => row.kind === "external")
      .map(([id]) => id)
      .sort();
    expect([...EXTERNAL_VENDOR_AGENT_IDS].sort()).toEqual(external);
  });

  it("matches a member-row puppet from the username when the id is a UUID", () => {
    const face = resolveIdentity({
      id: "8f1c0a2e-1111-2222-3333-444444444444",
      participant_id: "8f1c0a2e-1111-2222-3333-444444444444",
      username: "agent-majik",
      display_name: "Resident",
      participant_type: "agent",
    });
    expect(face.kind).toBe("agent");
    expect(face.src).toBe("/agent-puppets/majik.webp");
  });

  it("resolves a webhook seat that has a puppet as that agent, not the webhook logo", () => {
    // Display name "Claude Code" is Rook (puppetRig alias). The id alone
    // stops one hop earlier, on the generic Claude Code drawing. Either way
    // it is a character, not the webhook tile.
    const named = resolveIdentity({
      id: "webhook-dev-stable",
      display_name: "Claude Code",
      username: "agent-webhook-dev-stable",
      participant_type: "agent",
    });
    expect(named.kind).toBe("agent");
    expect(named.src).toBe("/agent-puppets/rook.webp");
    expect(named.src).not.toBe("/app-logos/webhook.svg");

    const byId = resolveIdentity({
      id: "webhook-dev-stable",
      display_name: "Alerts",
      participant_type: "agent",
    });
    expect(byId.kind).toBe("agent");
    expect(byId.src).toBe(brandAvatarFor("webhook-dev-stable"));
    expect(byId.src).not.toBe("/app-logos/webhook.svg");
  });
});

describe("resolveIdentity apps and guests", () => {
  it("maps Project-Ops and Meeting-Ops onto logo tiles", () => {
    const project = resolveIdentity({
      sender_id: "project-ops",
      sender_name: "Project-Ops",
      sender_type: "system",
    });
    expect(project.kind).toBe("app");
    expect(project.src).toBe("/app-logos/project-ops.svg");
    expect(project.ring).toBe("none");
    expect(project.name).toBe("Project-Ops");

    const meeting = resolveIdentity({
      id: "meeting-ops",
      name: "Meeting-Ops",
    });
    expect(meeting.kind).toBe("app");
    expect(meeting.src).toBe("/app-logos/meeting-ops.svg");
  });

  it("maps a bare webhook-* sender onto the webhook logo", () => {
    const face = resolveIdentity({
      sender_id: "webhook-gm-alerts",
      sender_name: "webhook-gm-alerts",
      sender_type: "system",
    });
    expect(face.kind).toBe("app");
    expect(face.src).toBe("/app-logos/webhook.svg");
  });

  it("does not steal the Project-Ops assistant's puppet", () => {
    const face = resolveIdentity({
      id: "project-ops-assistant",
      display_name: "Project Ops Assistant",
      participant_type: "agent",
    });
    expect(face.kind).toBe("agent");
    expect(face.src).toBe("/agent-puppets/project-ops-assistant.webp");
  });

  it("draws a guest with a dashed ring and will use a safe picture", () => {
    const bare = resolveIdentity({
      id: "g1",
      display_name: "Pat Guest",
      participant_type: "guest",
      role: "guest",
    });
    expect(bare.kind).toBe("guest");
    expect(bare.ring).toBe("dashed");
    expect(bare.subtitle).toBe("Guest");
    expect(bare.src).toBeNull();
    expect(bare.needsPhoto).toBeFalsy();

    const pictured = resolveIdentity({
      id: "g1",
      display_name: "Pat Guest",
      participant_type: "guest",
      avatar_url: KC,
    });
    expect(pictured.src).toBe(KC);
    expect(pictured.ring).toBe("dashed");
  });
});

describe("resolveIdentity messages and rooms", () => {
  it("uses the sender on a message, not the message id", () => {
    const face = resolveIdentity({
      id: "message-1",
      room_id: "room-1",
      sender_id: "majik",
      sender_type: "agent",
      sender_name: "Majik",
      sender_avatar: "https://evil.example/x.png",
      content: "hi",
    });
    expect(face.id).toBe("majik");
    expect(face.kind).toBe("agent");
    expect(face.src).toBe("/agent-puppets/majik.webp");
  });

  it("uses sender_avatar for a human message", () => {
    const face = resolveIdentity({
      id: "message-2",
      sender_id: "p-aaron",
      sender_type: "human",
      sender_name: "Aaron Stransky",
      sender_avatar: KC,
    });
    expect(face.kind).toBe("human");
    expect(face.id).toBe("p-aaron");
    expect(face.src).toBe(KC);
  });

  it("picks the other human in a DM", () => {
    const face = resolveIdentity(
      {
        id: "room-dm",
        name: "Aaron",
        display_name: "Pat",
        type: "dm",
        member_count: 2,
        members: [
          {
            participant_id: "me",
            display_name: "Aaron",
            username: "aaron",
            participant_type: "human",
            is_self: true,
            avatar_url: OVERRIDE,
          },
          {
            participant_id: "pat",
            display_name: "Pat Lee",
            username: "pat",
            participant_type: "human",
            avatar_url: KC,
            is_online: true,
          },
        ],
      },
      { selfId: "me" },
    );
    expect(face.kind).toBe("human");
    expect(face.id).toBe("pat");
    expect(face.name).toBe("Pat Lee");
    expect(face.src).toBe(KC);
    expect(face.presence).toBe("online");
    expect(face.origin).toBe("subject");
  });

  it("resolves an agent DM from brigade_agent_id even with empty members", () => {
    const face = resolveIdentity({
      id: "room-majik",
      name: "Chat with Majik",
      display_name: "Chat with Majik",
      type: "dm",
      member_count: 2,
      members: [],
      brigade_agent_id: "majik",
    });
    expect(face.kind).toBe("agent");
    expect(face.id).toBe("majik");
    expect(face.name).toBe("Majik");
    expect(face.src).toBe("/agent-puppets/majik.webp");
    expect(face.ring).toBe("amber");
  });

  it("reads brigade id from metadata and honours type agent_hub", () => {
    const fromMeta = resolveIdentity({
      id: "room-rook",
      name: "Chat with Rook",
      type: "dm",
      member_count: 2,
      members: [],
      metadata_: { brigade_agent_id: "rook" },
    });
    expect(fromMeta.kind).toBe("agent");
    expect(fromMeta.src).toBe("/agent-puppets/rook.webp");

    const hub = resolveIdentity({
      id: "hub-1",
      name: "Zen",
      type: "agent_hub",
      member_count: 2,
      members: [],
      brigade_agent_id: "zen",
    });
    expect(hub.kind).toBe("agent");
    expect(hub.id).toBe("zen");
    expect(hub.src).toBe("/agent-puppets/zen.webp");
  });

  it("builds a group facepile of at most three, excluding self", () => {
    const members = ["a", "b", "c", "d"].map((id) => ({
      participant_id: id,
      display_name: `Person ${id}`,
      username: id,
      participant_type: "human" as const,
      avatar_url: `https://cdn.magicunicorn.dev/${id}.png`,
    }));
    const face = resolveIdentity(
      {
        id: "group-1",
        name: "Crew",
        type: "group_dm",
        member_count: 5,
        members: [
          {
            participant_id: "me",
            display_name: "Aaron",
            username: "aaron",
            participant_type: "human",
            is_self: true,
          },
          ...members,
        ],
      },
      { selfId: "me" },
    );
    expect(face.faces).toHaveLength(3);
    expect(face.faces?.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(face.faces?.every((f) => f.src?.includes("magicunicorn.dev"))).toBe(true);
    expect(face.origin).toBe("subject");
  });

  it("marks a DM with no member rows as name-only (no invented photo)", () => {
    const face = resolveIdentity({
      id: "room-empty",
      name: "Pat Lee",
      display_name: "Pat Lee",
      type: "dm",
      member_count: 2,
      members: [],
    });
    expect(face.kind).toBe("human");
    expect(face.src).toBeNull();
    expect(face.origin).toBe("name-only");
    expect(face.name).toBe("Pat Lee");
  });

  it("does not invent a channel face", () => {
    const face = resolveIdentity({
      id: "room-general",
      name: "general",
      type: "channel",
      member_count: 8,
      members: [],
    });
    expect(face.origin).toBe("channel");
    expect(face.src).toBeNull();
    expect(face.subtitle).toBe("channel");
  });

  it("uses roster art for an agent hub when members are empty", () => {
    const face = resolveIdentity(
      {
        id: "room-custom",
        name: "Chat with Unpainted",
        type: "dm",
        member_count: 2,
        members: [],
        brigade_agent_id: "no-such-agent-zz",
      },
      {
        agents: [
          {
            id: "no-such-agent-zz",
            name: "unpainted",
            display_name: "Unpainted",
            avatar_url: ROSTER,
            model: "qwen",
            capabilities: [],
          },
        ],
      },
    );
    expect(face.kind).toBe("agent");
    expect(face.name).toBe("Unpainted");
    expect(face.src).toBe(ROSTER);
  });

  it("prefers store members over an empty room.members list", () => {
    const face = resolveIdentity(
      {
        id: "room-dm",
        name: "Pat",
        type: "dm",
        member_count: 2,
        members: [],
      },
      {
        selfId: "me",
        members: [
          { participant_id: "me", display_name: "Aaron", username: "aaron", is_self: true },
          {
            participant_id: "pat",
            display_name: "Pat Lee",
            username: "pat",
            participant_type: "human",
            avatar_url: KC,
          },
        ],
      },
    );
    expect(face.id).toBe("pat");
    expect(face.src).toBe(KC);
    expect(face.origin).toBe("subject");
  });
});
