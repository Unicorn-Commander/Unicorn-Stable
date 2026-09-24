/**
 * @vitest-environment happy-dom
 */
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallTileName } from "./TileNamePlate";
import {
  BroadcastLowerThird,
  StageLowerThird,
} from "./LowerThird";
import type { LowerThirdLayout } from "@/lib/tileChrome";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function plate() {
  return document.querySelector("[data-testid='tile-name-plate']");
}

function strip() {
  return document.querySelector("[data-testid='lower-third']");
}

describe("local tile name plate", () => {
  it("renders the display name, with (you) after it", () => {
    render(
      <div className="group">
        <CallTileName name="Aaron Stransky" isLocal mode="always" />
      </div>,
    );
    expect(plate()?.textContent).toBe("Aaron Stransky (you)");
    expect(plate()?.textContent).not.toBe("You");
  });

  it("covers the three name-plate states", () => {
    render(<CallTileName name="Majik" isLocal={false} mode="always" />);
    expect(plate()?.getAttribute("data-name-mode")).toBe("always");
    expect(plate()?.className).not.toContain("opacity-0");

    render(<CallTileName name="Majik" isLocal={false} mode="hover" />);
    expect(plate()?.getAttribute("data-name-mode")).toBe("hover");
    expect(plate()?.className).toContain("opacity-0");
    expect(plate()?.className).toContain("group-hover:opacity-100");

    render(<CallTileName name="Majik" isLocal={false} mode="off" />);
    expect(plate()).toBeNull();
    expect(document.body.textContent).not.toContain("Majik");
  });
});

function HoldHarness({
  layout,
  optedIn = true,
}: {
  layout: LowerThirdLayout;
  optedIn?: boolean;
}) {
  const [id, setId] = useState<string | null>("ada");
  const name = id === "bob" ? "Bob" : id === "ada" ? "Ada" : "";
  const subtitle = id === "bob" ? "Engineer" : id === "ada" ? "Host" : null;
  return (
    <>
      <button type="button" data-action="bob" onClick={() => setId("bob")}>
        bob
      </button>
      <button type="button" data-action="clear" onClick={() => setId(null)}>
        clear
      </button>
      <StageLowerThird
        optedIn={optedIn}
        layout={layout}
        speakerId={id}
        name={name}
        subtitle={subtitle}
        holdMs={4000}
      />
    </>
  );
}

function click(action: string) {
  const button = document.querySelector(`[data-action='${action}']`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`no button ${action}`);
  }
  act(() => {
    button.click();
  });
}

describe("lower third", () => {
  it("shows the speaker, hides after they hold the floor, and shows the next speaker", () => {
    vi.useFakeTimers();
    render(<HoldHarness layout="stage" />);
    expect(strip()?.textContent).toContain("Ada");
    expect(strip()?.textContent).toContain("Host");

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(strip()?.textContent).toContain("Ada");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(strip()).toBeNull();

    click("bob");
    expect(strip()?.textContent).toContain("Bob");
    expect(strip()?.textContent).toContain("Engineer");
    expect(document.querySelector("button[data-testid='lower-third']")).toBeNull();
    expect(strip()?.querySelector("button")).toBeNull();
  });

  it("never mounts in compact or on the filmstrip", () => {
    vi.useFakeTimers();
    render(<HoldHarness layout="compact" />);
    expect(strip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(strip()).toBeNull();

    render(<HoldHarness layout="filmstrip" />);
    expect(strip()).toBeNull();
    expect(document.body.textContent).not.toContain("Ada");
  });

  it("stays unmounted when the call has not opted in", () => {
    render(<HoldHarness layout="stage" optedIn={false} />);
    expect(strip()).toBeNull();
  });
});

describe("broadcast lower third", () => {
  it("renders nothing unless the room or the token URL opts in", () => {
    render(
      <BroadcastLowerThird
        search="?token=sbt-abc"
        roomOptIn={false}
        speakerId="ada"
        name="Ada"
        subtitle="Host"
      />,
    );
    expect(strip()).toBeNull();
    expect(document.body.textContent?.trim()).toBe("");

    render(
      <BroadcastLowerThird
        search=""
        roomOptIn
        speakerId="ada"
        name="Ada"
        subtitle="Host"
      />,
    );
    expect(strip()?.textContent).toContain("Ada");
    expect(strip()?.textContent).toContain("Host");
    expect(strip()?.querySelector("button")).toBeNull();

    render(
      <BroadcastLowerThird
        search="?lowerThird=1&token=sbt-abc"
        roomOptIn={false}
        speakerId="ada"
        name="Ada"
      />,
    );
    expect(strip()?.textContent).toContain("Ada");
  });
});
