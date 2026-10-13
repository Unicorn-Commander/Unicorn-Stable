/**
 * @vitest-environment happy-dom
 *
 * Render tests for the one face. The ladder reset is asserted on the committed
 * frame: a recycled row must not paint the previous resident's rung.
 */
import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Identity, type IdentityProps } from "./Identity";
import { AGENT_RING_AMBER, AGENT_RING_GREY, safeAvatarSrc, type SafeAvatarSrc } from "@/lib/identity";
import { configureRuntimeHosts } from "@/lib/runtimeHosts";

function art(url: string): SafeAvatarSrc {
  const safe = safeAvatarSrc(url);
  if (!safe) throw new Error(`test URL rejected: ${url}`);
  return safe;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHOTO_URL = "https://cdn.example.com/aaron.png";
const NEXT_URL = "https://cdn.example.com/next.png";
let PHOTO!: SafeAvatarSrc;
let NEXT!: SafeAvatarSrc;

beforeEach(() => {
  configureRuntimeHosts([
    { trustedOrigins: ["https://cdn.example.com", "*.assets.example.com"] },
  ]);
  PHOTO = art(PHOTO_URL);
  NEXT = art(NEXT_URL);
});

function props(over: Partial<IdentityProps> = {}): IdentityProps {
  return {
    kind: "human",
    id: "p-aaron",
    name: "Aaron Stransky",
    src: null,
    fallbacks: [],
    ring: "none",
    presence: null,
    subtitle: null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

function render(node: ReactNode) {
  cleanup();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(cleanup);

function face(name: string): HTMLElement {
  const el = document.querySelector(`[aria-label="${name}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no face labelled ${name}`);
  return el;
}

function painted(name: string): HTMLElement {
  const box = face(name).querySelector("span");
  if (!(box instanceof HTMLElement)) throw new Error(`no box for ${name}`);
  return box;
}

describe("Identity rungs", () => {
  it("draws a human photo, then initials, and names the face", () => {
    render(<Identity {...props({ src: PHOTO })} />);
    const img = face("Aaron Stransky").querySelector("img");
    expect(img?.getAttribute("src")).toBe(PHOTO);
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(face("Aaron Stransky").getAttribute("role")).toBe("img");

    render(<Identity {...props()} />);
    expect(document.body.textContent).toContain("AS");
    expect(document.querySelector("img")).toBeNull();
  });

  it("draws an agent photo with an amber ring, and a unicorn when nothing is left", () => {
    render(
      <Identity
        {...props({
          kind: "agent",
          id: "majik",
          name: "Majik",
          src: art("/agent-puppets/majik.webp"),
          ring: "amber",
        })}
      />,
    );
    expect(painted("Majik").style.boxShadow).toContain(AGENT_RING_AMBER);

    render(
      <Identity
        {...props({
          kind: "agent",
          id: "no-such-agent-zz",
          name: "Unpainted",
          src: null,
          ring: "amber",
        })}
      />,
    );
    expect(face("Unpainted").querySelector("svg")).not.toBeNull();
    expect(face("Unpainted").textContent).not.toContain("UN");
  });

  it("uses the emoji glyph before the unicorn when the picture is gone", () => {
    render(
      <Identity
        {...props({
          kind: "agent",
          id: "no-such-agent-zz",
          name: "Unpainted",
          src: null,
          ring: "amber",
          emoji: "🤖",
        })}
      />,
    );
    expect(document.body.textContent).toContain("🤖");
    expect(document.querySelector("svg")).toBeNull();
  });

  it("paints a grey ring for an external vendor and a dashed ring for a guest", () => {
    render(
      <Identity
        {...props({
          kind: "agent",
          id: "grok",
          name: "Grok",
          src: art("/agent-puppets/grok.webp"),
          ring: "grey",
        })}
      />,
    );
    expect(painted("Grok").style.boxShadow).toContain(AGENT_RING_GREY);

    render(
      <Identity
        {...props({
          kind: "guest",
          id: "g1",
          name: "Pat Guest",
          ring: "dashed",
        })}
      />,
    );
    expect(painted("Pat Guest").style.border).toContain("dashed");
    expect(document.body.textContent).toContain("PG");
  });

  it("keeps an app logo square", () => {
    render(
      <Identity
        {...props({
          kind: "app",
          id: "project-ops",
          name: "Project-Ops",
          src: art("/app-logos/project-ops.svg"),
          ring: "none",
        })}
      />,
    );
    expect(painted("Project-Ops").style.borderRadius).toBe("8px");
  });

  it("uses the sticker crop when shape is rounded", () => {
    render(
      <Identity
        {...props({
          kind: "agent",
          id: "majik",
          name: "Majik",
          src: art("/agent-puppets/majik.webp"),
          ring: "amber",
          shape: "rounded",
          size: 40,
        })}
      />,
    );
    const radius = painted("Majik").style.borderRadius;
    expect(radius).not.toBe("9999px");
    expect(radius.endsWith("px")).toBe(true);
    expect(Number.parseFloat(radius)).toBeGreaterThan(4);
    expect(Number.parseFloat(radius)).toBeLessThan(20);
  });

  it("announces presence", () => {
    render(<Identity {...props({ presence: "online", src: PHOTO })} />);
    expect(document.querySelector('[aria-label="Online"]')).not.toBeNull();
    render(<Identity {...props({ presence: "available", src: PHOTO })} />);
    expect(document.querySelector('[aria-label="Available"]')).not.toBeNull();
    render(<Identity {...props({ presence: "unknown", src: PHOTO })} />);
    expect(document.querySelector('[aria-label="Presence unknown"]')).not.toBeNull();
  });

  it("lets expression reach the unicorn, and state=talking skips a still picture", () => {
    render(
      <Identity
        {...props({
          kind: "agent",
          id: "no-such-agent-zz",
          name: "Unpainted",
          src: null,
          ring: "amber",
          expression: "offline",
        })}
      />,
    );
    expect(face("Unpainted").querySelector("svg")).not.toBeNull();
    const bust = face("Unpainted").querySelector('[role="img"]');
    expect(bust?.className).toContain("opacity-50");

    render(
      <Identity
        {...props({
          kind: "agent",
          id: "majik",
          name: "Majik",
          src: art("/agent-puppets/majik.webp"),
          ring: "amber",
          state: "talking",
        })}
      />,
    );
    expect(face("Majik").querySelector("img")).toBeNull();
    expect(face("Majik").querySelector("svg")).not.toBeNull();
    expect(face("Majik").innerHTML).toContain("animate-unicorn-bob");
  });
});

describe("Identity ladder reset", () => {
  it("does not paint the previous rung when src changes", () => {
    const seen: string[] = [];
    function Probe({
      src,
      kind,
      name,
    }: {
      src: SafeAvatarSrc | null;
      kind: "human" | "agent";
      name: string;
    }) {
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        seen.push(ref.current?.innerHTML ?? "");
      });
      return (
        <div ref={ref}>
          <Identity
            {...props({
              kind,
              id: kind === "agent" ? "majik" : "p-aaron",
              name,
              src,
              ring: kind === "agent" ? "amber" : "none",
            })}
          />
        </div>
      );
    }

    render(<Probe src={PHOTO} kind="human" name="Aaron Stransky" />);
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    expect(document.body.textContent).toContain("AS");

    const mark = seen.length;
    act(() => {
      root!.render(<Probe src={NEXT} kind="agent" name="Majik" />);
    });
    const frames = seen.slice(mark);
    expect(frames.length).toBeGreaterThan(0);
    for (const html of frames) {
      expect(html).toContain(NEXT);
      expect(html).not.toContain("<svg");
      expect(html).not.toContain(">AS<");
    }
  });
});
