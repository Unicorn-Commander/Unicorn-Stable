import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_FACE_CONTEXTS,
  agentFaceBudget,
  agentSlugFromIdentity,
  faceMountPlan,
  isAgentIdentity,
  isVrmSurfaceEligible,
  mapAgentState,
  puppetAvailableFor,
  resolveCallTilePersona,
  isTypeShapedAgentSlug,
  selectFallbackRung,
  selectPresenceRung,
  unicornStateFor,
  withinAgentFaceBudget,
  type FaceMountPlanInput,
  type PresenceRungInput,
} from "./presenceFace";
import { hasPuppet, puppetForAgent, puppetForTexture } from "./puppetRig";
import { FACE_STYLE_ORDER, type FaceStyle } from "./facePreference";

/** The happy path: everything on, everything available. */
function input(over: Partial<PresenceRungInput> = {}): PresenceRungInput {
  return {
    flagEnabled: true,
    surface: "stage",
    webglOk: true,
    faceHealthy: true,
    portraitSrc: "https://brigade.magicunicorn.dev/avatars/majik.webp",
    vrmSrc: null,
    ...over,
  };
}

describe("isAgentIdentity", () => {
  it("accepts the agent- identity convention", () => {
    expect(isAgentIdentity("agent-majik")).toBe(true);
    expect(isAgentIdentity("agent-corporal-qwen")).toBe(true);
  });

  it("rejects the local human and real user ids", () => {
    // "local" is the synthetic id for self; it must never take a 3D face.
    expect(isAgentIdentity("local")).toBe(false);
    expect(isAgentIdentity("8f2c1b90-0000-4000-8000-000000000000")).toBe(false);
    expect(isAgentIdentity("aaron")).toBe(false);
  });

  it("is safe on missing input", () => {
    expect(isAgentIdentity(null)).toBe(false);
    expect(isAgentIdentity(undefined)).toBe(false);
    expect(isAgentIdentity("")).toBe(false);
  });

  it("does not require the Brigade roster — the whole point of the rule", () => {
    // No roster is consulted anywhere in this function. If someone reintroduces
    // a roster lookup, this identity alone will stop being sufficient and the
    // agent silently loses its face when the query is slow or empty.
    expect(isAgentIdentity("agent-never-registered-anywhere")).toBe(true);
  });
});

describe("agentSlugFromIdentity", () => {
  it("strips the prefix and is idempotent", () => {
    expect(agentSlugFromIdentity("agent-majik")).toBe("majik");
    expect(agentSlugFromIdentity("majik")).toBe("majik");
    expect(agentSlugFromIdentity(agentSlugFromIdentity("agent-majik"))).toBe(
      "majik",
    );
  });

  it("only strips a LEADING prefix", () => {
    expect(agentSlugFromIdentity("super-agent-majik")).toBe("super-agent-majik");
  });
});

describe("isVrmSurfaceEligible", () => {
  it("allows stage-class surfaces", () => {
    expect(isVrmSurfaceEligible({ size: "large" })).toBe(true);
    expect(isVrmSurfaceEligible({ size: "normal", fill: true })).toBe(true);
    expect(isVrmSurfaceEligible({ size: "normal", inPopout: true })).toBe(true);
  });

  it("REFUSES normal filmstrip/grid tiles", () => {
    // The regression this guards: gating on pixel size (>=64) instead of role
    // would mount a WebGL context on every tile in the filmstrip.
    expect(isVrmSurfaceEligible({ size: "normal" })).toBe(false);
    expect(isVrmSurfaceEligible({})).toBe(false);
    expect(isVrmSurfaceEligible({ size: "normal", fill: false })).toBe(false);
  });
});

describe("selectPresenceRung — the fallback ladder", () => {
  it("takes the face rung when everything lines up", () => {
    expect(selectPresenceRung(input())).toBe("face");
  });

  it("falls to the portrait when the flag is off", () => {
    expect(selectPresenceRung(input({ flagEnabled: false }))).toBe("portrait");
  });

  it("falls to the portrait on a non-stage surface", () => {
    expect(selectPresenceRung(input({ surface: "filmstrip" }))).toBe("portrait");
    expect(selectPresenceRung(input({ surface: "chip" }))).toBe("portrait");
  });

  it("falls to the portrait when WebGL is unavailable", () => {
    expect(selectPresenceRung(input({ webglOk: false }))).toBe("portrait");
  });

  it("falls to the portrait after the face has failed once", () => {
    expect(selectPresenceRung(input({ faceHealthy: false }))).toBe("portrait");
  });

  it("falls all the way to the unicorn when there is no portrait either", () => {
    expect(
      selectPresenceRung(input({ flagEnabled: false, portraitSrc: null })),
    ).toBe("unicorn");
  });

  it("NEVER returns a rung that renders nothing", () => {
    // Exhaustive over every combination of the boolean gates: no input may
    // produce a blank tile. "face", "portrait" and "unicorn" all draw pixels.
    const rungs = new Set<string>();
    for (const flagEnabled of [true, false]) {
      for (const surface of ["stage", "filmstrip", "chip"] as const) {
        for (const webglOk of [true, false]) {
          for (const faceHealthy of [true, false]) {
            for (const portraitSrc of ["/p.png", null]) {
              rungs.add(
                selectPresenceRung({
                  flagEnabled,
                  surface,
                  webglOk,
                  faceHealthy,
                  portraitSrc,
                  vrmSrc: null,
                }),
              );
            }
          }
        }
      }
    }
    expect([...rungs].sort()).toEqual(["face", "portrait", "unicorn"]);
  });

  it("reaches the face rung with NO vrmSrc — that is the phase-1 state", () => {
    // No brand VRM exists yet. If this ever requires a vrmSrc, the flag-on path
    // silently degrades to a static portrait and nobody's mouth moves.
    expect(selectPresenceRung(input({ vrmSrc: null }))).toBe("face");
  });
});

describe("selectPresenceRung — the branded puppet is shipped product", () => {
  it("a branded puppet reaches the face rung with the flag OFF", () => {
    // Aaron's direction: the branded 2D talking puppet IS the call face —
    // it must not hide behind the experimental talking-face flag.
    expect(
      selectPresenceRung(input({ flagEnabled: false, puppetAvailable: true })),
    ).toBe("face");
  });

  it("no puppet + flag off stays exactly the shipped 2D behavior", () => {
    expect(
      selectPresenceRung(input({ flagEnabled: false, puppetAvailable: false })),
    ).toBe("portrait");
    expect(selectPresenceRung(input({ flagEnabled: false }))).toBe("portrait");
  });

  it("the puppet still respects surface/webgl/health gates", () => {
    const base = { flagEnabled: false, puppetAvailable: true } as const;
    expect(
      selectPresenceRung(input({ ...base, surface: "filmstrip" })),
    ).toBe("portrait");
    expect(selectPresenceRung(input({ ...base, webglOk: false }))).toBe(
      "portrait",
    );
    expect(selectPresenceRung(input({ ...base, faceHealthy: false }))).toBe(
      "portrait",
    );
  });
});

describe("faceMountPlan — preference × availability × flag", () => {
  const plan = (over: Partial<FaceMountPlanInput> = {}) =>
    faceMountPlan({
      style: "auto",
      puppetAvailable: true,
      vrmAvailable: false,
      genericAllowed: false,
      ...over,
    });

  it("auto is the shipped ladder: puppet → vrm → placeholder(flag)", () => {
    expect(
      plan({ vrmAvailable: true, genericAllowed: true }),
    ).toEqual(["puppet", "vrm", "placeholder"]);
    expect(plan()).toEqual(["puppet"]);
    expect(plan({ puppetAvailable: false })).toEqual([]);
    expect(plan({ puppetAvailable: false, genericAllowed: true })).toEqual([
      "placeholder",
    ]);
  });

  it("puppet means 2D: an authored puppet or nothing — never a 3D surprise", () => {
    expect(plan({ style: "puppet" })).toEqual(["puppet"]);
    // No puppet → EMPTY, even with a VRM and the flag on: the user asked for
    // 2D, so the tile takes the still-portrait ladder instead.
    expect(
      plan({
        style: "puppet",
        puppetAvailable: false,
        vrmAvailable: true,
        genericAllowed: true,
      }),
    ).toEqual([]);
  });

  it("vrm tries the model first and keeps the puppet as the fallback", () => {
    expect(plan({ style: "vrm", vrmAvailable: true })).toEqual([
      "vrm",
      "puppet",
    ]);
    // No VRM authored (today's reality — the pack is empty): the choice
    // degrades to the puppet rather than to nothing.
    expect(plan({ style: "vrm" })).toEqual(["puppet"]);
  });

  it("portrait refuses the face rung entirely", () => {
    expect(
      plan({
        style: "portrait",
        puppetAvailable: true,
        vrmAvailable: true,
        genericAllowed: true,
      }),
    ).toEqual([]);
  });

  it("the procedural head NEVER mounts on preference alone — flag only", () => {
    for (const style of FACE_STYLE_ORDER) {
      const p = plan({
        style,
        puppetAvailable: false,
        vrmAvailable: false,
        genericAllowed: false,
      });
      expect(p).not.toContain("placeholder");
      expect(p).toEqual([]);
    }
  });
});

describe("selectPresenceRung — face-style preference", () => {
  it("omitted style is auto, bit for bit", () => {
    // Every gate combination must agree with an explicit "auto" — the
    // preference must not change a single pre-preference outcome by default.
    for (const flagEnabled of [true, false]) {
      for (const puppetAvailable of [true, false]) {
        for (const webglOk of [true, false]) {
          for (const portraitSrc of ["/p.png", null]) {
            const base = input({
              flagEnabled,
              puppetAvailable,
              webglOk,
              portraitSrc,
            });
            expect(selectPresenceRung(base)).toBe(
              selectPresenceRung({ ...base, style: "auto" }),
            );
          }
        }
      }
    }
  });

  it("portrait style never reaches the face rung", () => {
    expect(
      selectPresenceRung(input({ style: "portrait", puppetAvailable: true })),
    ).toBe("portrait");
    expect(
      selectPresenceRung(
        input({ style: "portrait", puppetAvailable: true, portraitSrc: null }),
      ),
    ).toBe("unicorn");
  });

  it("puppet style with no puppet degrades to the 2D ladder", () => {
    expect(
      selectPresenceRung(
        input({ style: "puppet", puppetAvailable: false, flagEnabled: true }),
      ),
    ).toBe("portrait");
  });

  it("vrm style rides the puppet when no model exists (probe says why)", () => {
    expect(
      selectPresenceRung(
        input({ style: "vrm", puppetAvailable: true, flagEnabled: false }),
      ),
    ).toBe("face");
    // …and with neither asset nor flag, the 2D ladder — never a blank canvas.
    expect(
      selectPresenceRung(
        input({ style: "vrm", puppetAvailable: false, flagEnabled: false }),
      ),
    ).toBe("portrait");
  });

  it("NO style may loosen a physics gate", () => {
    const styles: FaceStyle[] = [...FACE_STYLE_ORDER];
    for (const style of styles) {
      const rich = { style, puppetAvailable: true, vrmSrc: "/m.vrm" } as const;
      expect(
        selectPresenceRung(input({ ...rich, surface: "filmstrip" })),
      ).not.toBe("face");
      expect(selectPresenceRung(input({ ...rich, webglOk: false }))).not.toBe(
        "face",
      );
      expect(
        selectPresenceRung(input({ ...rich, faceHealthy: false })),
      ).not.toBe("face");
    }
  });

  it("still never returns a rung that renders nothing, under every style", () => {
    const rungs = new Set<string>();
    for (const style of FACE_STYLE_ORDER) {
      for (const flagEnabled of [true, false]) {
        for (const puppetAvailable of [true, false]) {
          for (const webglOk of [true, false]) {
            for (const portraitSrc of ["/p.png", null]) {
              rungs.add(
                selectPresenceRung({
                  flagEnabled,
                  surface: "stage",
                  webglOk,
                  faceHealthy: true,
                  portraitSrc,
                  vrmSrc: null,
                  puppetAvailable,
                  style,
                }),
              );
            }
          }
        }
      }
    }
    expect([...rungs].sort()).toEqual(["face", "portrait", "unicorn"]);
  });
});

describe("withinAgentFaceBudget", () => {
  it("allows the typical call shapes — one agent, a couple of agents", () => {
    // THE regression: a 1:1 Majik call in Gallery had zero face-eligible
    // tiles, so "in video it was just the static avatar image".
    expect(withinAgentFaceBudget(1)).toBe(true);
    expect(withinAgentFaceBudget(2)).toBe(true);
    expect(withinAgentFaceBudget(MAX_AGENT_FACE_CONTEXTS)).toBe(true);
  });

  it("refuses agent swarms — the unbounded-context case the role gate feared", () => {
    expect(withinAgentFaceBudget(MAX_AGENT_FACE_CONTEXTS + 1)).toBe(false);
    expect(withinAgentFaceBudget(12)).toBe(false);
  });

  it("zero agents means no budget question at all", () => {
    expect(withinAgentFaceBudget(0)).toBe(false);
  });
});

describe("puppetAvailableFor", () => {
  it("knows the authored characters and rejects the rest", () => {
    expect(puppetAvailableFor("majik", "Majik")).toBe(true);
    expect(puppetAvailableFor("gunny", null)).toBe(true);
    expect(puppetAvailableFor("brigade", "stable-brigade")).toBe(false);
    expect(puppetAvailableFor(null, null)).toBe(false);
  });
});

describe("resolveCallTilePersona", () => {
  it("keeps a persona-shaped identity that resolves art", () => {
    expect(resolveCallTilePersona("agent-majik", "Majik", "gunny")).toEqual({
      slug: "majik",
      name: "Majik",
    });
  });

  it("falls back to the room's brigade agent for a TYPE-shaped identity", () => {
    // THE dogfood-verified bug: the worker joins as `stable-brigade` /
    // `agent-brigade`, which names no character, so Majik rendered as the
    // generic 2D unicorn on every call.
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", "majik"),
    ).toEqual({ slug: "majik", name: "Majik" });
    expect(
      resolveCallTilePersona("stable-brigade", "stable-brigade", "majik"),
    ).toEqual({ slug: "majik", name: "Majik" });
  });

  it("derives the canonical display name for multi-word brigade ids", () => {
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", "corporal-qwen")
        .name,
    ).toBe("Corporal Qwen");
  });

  it("leaves the tile alone when nobody has art anywhere", () => {
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", "sgt-nowhere"),
    ).toEqual({ slug: "brigade", name: "stable-brigade" });
    expect(resolveCallTilePersona("agent-brigade", "stable-brigade", null)).toEqual(
      { slug: "brigade", name: "stable-brigade" },
    );
  });

  it("resolves display-name art even when the identity is opaque", () => {
    // The roster sometimes carries the persona in the NAME only.
    expect(
      resolveCallTilePersona("agent-b7f2", "Corporal Qwen", null).slug,
    ).toBe("b7f2");
    // …but the art still resolves via the name in brandAvatarFor, so the
    // tile keeps its own slug/name pair (art lookups take both).
    expect(
      resolveCallTilePersona("agent-b7f2", "Corporal Qwen", null).name,
    ).toBe("Corporal Qwen");
  });

  it("falls back to the room's ONE agent member when metadata is missing", () => {
    // THE group-DM bug (Aaron, 2026-08-10): a group room whose list row never
    // learned `brigade_agent_id` (in-room invite, stale list) left the
    // type-shaped worker unresolvable, and Majik rendered as the generic head
    // with the "brigade" identity hue — green hair. The membership roster is
    // written at invite time and names him.
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", null, [
        { slug: "majik", name: "Majik" },
      ]),
    ).toEqual({ slug: "majik", name: "Majik" });
    // A member row with no display name gets the canonical derivation.
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", null, [
        { slug: "corporal-qwen" },
      ]),
    ).toEqual({ slug: "corporal-qwen", name: "Corporal Qwen" });
  });

  it("room metadata still outranks the member roster", () => {
    // metadata is the server's "canonical responder" (most-recently-invited);
    // the roster is the fallback for when that copy is stale or unwritten.
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", "gunny", [
        { slug: "majik", name: "Majik" },
      ]).slug,
    ).toBe("gunny");
  });

  it("declines to guess between TWO artful agent members", () => {
    // One worker tile, two possible characters: either pick would be a coin
    // flip wearing a costume. The generic rungs are more honest.
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", null, [
        { slug: "majik", name: "Majik" },
        { slug: "gunny", name: "Gunny" },
      ]),
    ).toEqual({ slug: "brigade", name: "stable-brigade" });
  });

  it("gives EACH agent in a multi-agent call its own character", () => {
    // THE multi-agent bug this exists for: workers used to share one
    // type-shaped identity, so the second agent could only ever wear the
    // room's single resident face. They now join as `agent-<persona>` and the
    // membership roster names both, so each tile resolves to itself.
    const members = [
      { slug: "majik", name: "Majik" },
      { slug: "the-general", name: "The General" },
    ];
    expect(
      resolveCallTilePersona("agent-majik", "Majik", "the-general", members),
    ).toEqual({ slug: "majik", name: "Majik" });
    expect(
      resolveCallTilePersona(
        "agent-the-general",
        "The General",
        "the-general",
        members,
      ),
    ).toEqual({ slug: "the-general", name: "The General" });
  });

  it("keeps an ARTLESS agent as itself instead of borrowing the resident's face", () => {
    // A member with no drawn art used to fall through to the room's
    // `brigade_agent_id` — in a multi-agent room that is somebody else's
    // character. The roster naming the tile is enough; the 2D ladder below
    // handles "we have not drawn this one yet".
    expect(
      resolveCallTilePersona("agent-sgt-nowhere", "Sgt Nowhere", "majik", [
        { slug: "majik", name: "Majik" },
        { slug: "sgt-nowhere", name: "Sgt Nowhere" },
      ]),
    ).toEqual({ slug: "sgt-nowhere", name: "Sgt Nowhere" });
  });

  it("derives a name for a roster row that has none", () => {
    expect(
      resolveCallTilePersona("agent-corporal-qwen", null, null, [
        { slug: "corporal-qwen" },
        { slug: "majik", name: "Majik" },
      ]).name,
    ).toBe("Corporal Qwen");
  });

  it("still uses the room resident for a TYPE-shaped tile in a multi-agent room", () => {
    // A worker from before per-agent identities. Its identity names nobody, so
    // the room-level fallback is still the best information available — but
    // rule 3 already refuses to pick between two artful members, so this lands
    // on the room scalar and not on a coin flip.
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", "gunny", [
        { slug: "majik", name: "Majik" },
        { slug: "gunny", name: "Gunny" },
      ]).slug,
    ).toBe("gunny");
  });

  it("ignores agent members whose art does not resolve", () => {
    // An artless bot member must not block the one drawn character…
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", null, [
        { slug: "webhook-notifier-x9" },
        { slug: "majik", name: "Majik" },
      ]).slug,
    ).toBe("majik");
    // …and a roster of only artless members changes nothing.
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", null, [
        { slug: "webhook-notifier-x9" },
      ]),
    ).toEqual({ slug: "brigade", name: "stable-brigade" });
  });
});

/**
 * ROOK — the voice relay's tile (Aaron, 2026-08-28: "the avatar needs work and
 * the name says stable relay").
 *
 * Rook is his Claude Code seat: a TEXT agent whose messages a separate relay
 * worker speaks aloud in the call. The relay joins as Rook's own username so
 * the tile is his, which puts three things on the line at once — the name, the
 * drawing, and (through the drawing's rig) the mouth.
 */
describe("resolveCallTilePersona — Rook's relay tile", () => {
  const ROOK = {
    slug: "claude-code",
    name: "Rook",
    avatarUrl: "/agent-puppets/rook-v2.png",
  };

  it("takes the roster's NAME and the roster's ART", () => {
    const persona = resolveCallTilePersona(
      "agent-claude-code",
      // What the worker calls itself. `agent_participant_name(type, null)` in
      // agent_runtime/registry returns `stable-<type>`, which is the string
      // Aaron read off the tile.
      "stable-relay",
      null,
      [ROOK],
    );
    expect(persona.name).toBe("Rook");
    expect(persona.slug).toBe("claude-code");
    expect(persona.artUrl).toBe("/agent-puppets/rook-v2.png");
    // …and that art is a RIGGED puppet, which is what makes the mouth move.
    expect(puppetForTexture(persona.artUrl)?.label).toBe("Rook");
  });

  it("survives the runtime's 4-hex identity suffix", () => {
    // agent_runtime/base.py derives `agent-{type}-{id(self) & 0xFFFF:04x}`,
    // and live-fire on 2026-08-28 saw `agent-relay-bec0` in the room — the
    // server's duplicate guard had to switch from equality to a prefix test
    // (6cd08e8). An equality test here would miss the roster row the same way.
    const persona = resolveCallTilePersona(
      "agent-claude-code-3f9a",
      "stable-relay",
      null,
      [ROOK],
    );
    expect(persona.name).toBe("Rook");
    // The slug is the ROSTER's, not the suffixed one — `claude-code-3f9a`
    // resolves no art anywhere.
    expect(persona.slug).toBe("claude-code");
    expect(persona.artUrl).toBe("/agent-puppets/rook-v2.png");
  });

  it("does not let a DIFFERENT agent borrow Rook's face", () => {
    // The regression that matters: Majik in the same call must keep being
    // Majik, art and all, however Rook's row is written.
    const members = [ROOK, { slug: "majik", name: "Majik" }];
    const majik = resolveCallTilePersona("agent-majik", "Majik", null, members);
    expect(majik).toEqual({ slug: "majik", name: "Majik" });
    expect(majik.artUrl).toBeUndefined();
    // Rook's own tile is unaffected by the company he keeps.
    expect(
      resolveCallTilePersona("agent-claude-code", "stable-relay", null, members)
        .artUrl,
    ).toBe("/agent-puppets/rook-v2.png");
  });

  it("keeps the OTHER Claude Code seats on the shared catalogue art", () => {
    // Rook's art is bound to his PARTICIPANT, never to the `claude-code` slug —
    // which Shafen's box, the webhook dev seats and `claude-orch1` all share.
    // Binding it to the slug is precisely how his face would leak onto theirs.
    const members = [
      ROOK,
      { slug: "shafen-claude-code", name: "Claude Code", avatarUrl: null },
    ];
    const shafen = resolveCallTilePersona(
      "agent-shafen-claude-code",
      "Claude Code",
      null,
      members,
    );
    expect(shafen.artUrl).toBeUndefined();
    // It still resolves art — the generic Claude Code drawing, via the alias
    // table. Correct, and NOT Rook's.
    expect(puppetForAgent(shafen.slug, shafen.name)?.texture).toBe(
      "/agent-puppets/claude-code.webp",
    );
  });

  it("refuses to guess when a suffixed identity fits two rows", () => {
    // Two members whose slugs differ only past the strip point is not evidence
    // of anything. Same instinct as "declines to guess between TWO artful
    // agent members" above: the generic rungs beat the wrong character.
    const persona = resolveCallTilePersona("agent-bot-1a2b", "stable-relay", null, [
      { slug: "bot", name: "Bot One" },
      { slug: "bot", name: "Bot Two" },
    ]);
    expect(persona.name).toBe("stable-relay");
  });

  it("does not strip a suffix that is not the runtime's", () => {
    // `harmony-local` is a real persona, not `harmony` wearing a suffix.
    expect(
      resolveCallTilePersona("agent-harmony-local", "Harmony Local", null, [
        { slug: "harmony", name: "Harmony" },
      ]).slug,
    ).toBe("harmony-local");
  });

  it("carries no artUrl when the roster row has no picture", () => {
    // `toEqual` on the two-key shape is load-bearing: an always-present
    // `artUrl: null` would make every caller handle a value that means
    // nothing.
    expect(
      resolveCallTilePersona("agent-majik", "Majik", null, [
        { slug: "majik", name: "Majik", avatarUrl: null },
      ]),
    ).toEqual({ slug: "majik", name: "Majik" });
    expect(
      resolveCallTilePersona("agent-majik", "Majik", null, [
        { slug: "majik", name: "Majik", avatarUrl: "   " },
      ]).artUrl,
    ).toBeUndefined();
  });

  it("carries the art through the ONE-artful-member fallback too", () => {
    // A tile whose identity names nobody (a pre-per-identity worker) still
    // lands on the room's single drawn resident — and must arrive with that
    // member's picture, not just its name.
    expect(
      resolveCallTilePersona("agent-brigade", "stable-brigade", null, [ROOK]),
    ).toEqual({
      slug: "claude-code",
      name: "Rook",
      artUrl: "/agent-puppets/rook-v2.png",
    });
  });
});

describe("isTypeShapedAgentSlug", () => {
  it("recognises every identity shape that names no character", () => {
    // The historical worker identity, its `stable-` display form, and the
    // runtime's internal audit identity.
    expect(isTypeShapedAgentSlug("brigade")).toBe(true);
    expect(isTypeShapedAgentSlug("stable-brigade")).toBe(true);
    expect(isTypeShapedAgentSlug("brigade-33b0")).toBe(true);
    expect(isTypeShapedAgentSlug("triage")).toBe(true);
    expect(isTypeShapedAgentSlug("")).toBe(true);
    expect(isTypeShapedAgentSlug(null)).toBe(true);
  });

  it("does not swallow real personas", () => {
    expect(isTypeShapedAgentSlug("majik")).toBe(false);
    expect(isTypeShapedAgentSlug("the-general")).toBe(false);
    expect(isTypeShapedAgentSlug("corporal-qwen")).toBe(false);
  });
});

describe("selectFallbackRung", () => {
  it("prefers a portrait and otherwise draws the unicorn", () => {
    expect(selectFallbackRung("/agent-avatars/iris.png")).toBe("portrait");
    expect(selectFallbackRung(null)).toBe("unicorn");
  });
});

describe("mapAgentState", () => {
  it("maps the LiveKit agent lifecycle", () => {
    expect(mapAgentState("listening")).toBe("listening");
    expect(mapAgentState("thinking")).toBe("thinking");
    expect(mapAgentState("speaking")).toBe("speaking");
    expect(mapAgentState("initializing")).toBe("working");
  });

  it("falls back to the local speaking hint when there is no state", () => {
    expect(mapAgentState(null, { isSpeaking: true })).toBe("speaking");
    expect(mapAgentState(null, { isSpeaking: false })).toBe("idle");
    expect(mapAgentState(undefined)).toBe("idle");
  });

  it("offline outranks everything", () => {
    expect(mapAgentState("speaking", { isOffline: true })).toBe("offline");
  });
});

describe("unicornStateFor", () => {
  it("keeps the SVG bust in step with the expression", () => {
    expect(unicornStateFor("speaking")).toBe("talking");
    expect(unicornStateFor("thinking")).toBe("working");
    expect(unicornStateFor("working")).toBe("working");
    expect(unicornStateFor("offline")).toBe("offline");
    expect(unicornStateFor("idle")).toBe("idle");
    expect(unicornStateFor("listening")).toBe("idle");
  });
});

describe("Build In Public cast — 2026-08-28", () => {
  it("Rook's seat resolves to Rook's own art, not the old Claude Code face", () => {
    // The seat's participant username is `agent-claude-code`, so the identity
    // resolves before the name "Rook" is ever tried — the alias is what stops
    // Rook wearing the generic Claude Code drawing.
    const spec = puppetForAgent("claude-code", "Rook");
    expect(spec).not.toBeNull();
    expect(spec!.label).toBe("Rook");
    expect(spec!.texture).toContain("rook");
  });

  it("gives every on-camera cast member a puppet, so none fall back to the generated head", () => {
    for (const id of ["grok", "shox", "codex", "corporal-forge", "sprint", "rook"]) {
      expect(hasPuppet(id, null)).toBe(true);
    }
  });

  it("keeps the cast's faces distinct from each other", () => {
    const textures = ["grok", "shox", "codex", "corporal-forge", "sprint", "rook"].map(
      (id) => puppetForAgent(id, null)!.texture,
    );
    expect(new Set(textures).size).toBe(textures.length);
  });

  it("routes the model-named lanes to their role-named characters", () => {
    expect(puppetForAgent("qwen-35b", null)!.label).toBe("Corporal Forge");
    expect(puppetForAgent("deepseek-flash", null)!.label).toBe("Sprint");
    // Corporal Qwen is a different, pre-existing agent and keeps its own face.
    expect(puppetForAgent("corporal-qwen", null)!.texture).toContain("corporal-qwen");
  });
});

describe("agentFaceBudget — spent, not forfeited", () => {
  const six = ["majik", "the-general", "rook", "grok", "shox", "codex"];

  it("gives every agent a face when the room is within budget", () => {
    const ids = ["majik", "rook"];
    expect(agentFaceBudget(ids, null)).toEqual(new Set(ids));
  });

  it("still animates SOMEBODY when the room is over budget", () => {
    // The old all-or-nothing rule animated nobody here, which made the
    // failure worst exactly when the room was most interesting.
    const chosen = agentFaceBudget(six, null);
    expect(chosen.size).toBe(MAX_AGENT_FACE_CONTEXTS);
  });

  it("always spends a slot on the agent that is speaking", () => {
    const chosen = agentFaceBudget(six, "codex"); // last in tile order
    expect(chosen.has("codex")).toBe(true);
    expect(chosen.size).toBe(MAX_AGENT_FACE_CONTEXTS);
  });

  it("keeps the rest of the set stable as the speaker changes", () => {
    const a = agentFaceBudget(six, "codex");
    const b = agentFaceBudget(six, "shox");
    const stable = [...a].filter((id) => b.has(id));
    // Only the speaker slot churns; the others hold their contexts.
    expect(stable.length).toBeGreaterThanOrEqual(MAX_AGENT_FACE_CONTEXTS - 2);
  });

  it("ignores a speaker that is not an agent tile", () => {
    const chosen = agentFaceBudget(six, "aaron_1111");
    expect(chosen.has("aaron_1111")).toBe(false);
    expect(chosen.size).toBe(MAX_AGENT_FACE_CONTEXTS);
  });

  it("handles an empty room and a zero budget without throwing", () => {
    expect(agentFaceBudget([], null).size).toBe(0);
    expect(agentFaceBudget(six, "rook", 0).size).toBe(0);
  });
});
