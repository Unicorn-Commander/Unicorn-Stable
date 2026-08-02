import { describe, expect, it } from "vitest";
import {
  agentSlugFromIdentity,
  isAgentIdentity,
  isVrmSurfaceEligible,
  mapAgentState,
  selectFallbackRung,
  selectPresenceRung,
  unicornStateFor,
  type PresenceRungInput,
} from "./presenceFace";

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
