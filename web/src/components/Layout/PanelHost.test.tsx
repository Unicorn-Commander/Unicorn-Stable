// @vitest-environment happy-dom
import { act, useEffect, useState, type ReactNode } from "react";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "./PanelHost";
import { usePanelChromeStore } from "@/stores/panelChromeStore";

let mounts = 0;

function Probe() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <span data-probe="">chat</span>;
}

function Harness() {
  const [hidden, setHidden] = useState(false);
  const [which, setWhich] = useState<"a" | "b">("a");
  const [dockA, setDockA] = useState<HTMLDivElement | null>(null);
  const [dockB, setDockB] = useState<HTMLDivElement | null>(null);
  const dock = which === "a" ? dockA : dockB;
  return (
    <>
      <button
        type="button"
        data-action="toggle"
        onClick={() => setHidden((v) => !v)}
      >
        toggle
      </button>
      <button
        type="button"
        data-action="swap"
        onClick={() => setWhich((w) => (w === "a" ? "b" : "a"))}
      >
        swap
      </button>
      <div ref={setDockA} data-dock="a" />
      <div ref={setDockB} data-dock="b" />
      <PanelHost
        roomId="mount-room"
        panelId="chat"
        title="Chat"
        present={hidden ? "hidden" : "docked"}
        dockElement={hidden ? null : dock}
      >
        <Probe />
      </PanelHost>
    </>
  );
}

describe("PanelHost", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
    mounts = 0;
  });

  function render(node: ReactNode) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    act(() => {
      root?.render(node);
    });
  }

  it("keeps the same chat instance across hide, show, and a new dock", () => {
    render(<Harness />);
    const probe = document.querySelector("[data-probe]");
    expect(probe).not.toBeNull();
    expect(mounts).toBe(1);
    expect(document.querySelector("[data-dock='a']")?.contains(probe)).toBe(
      true,
    );

    const toggle = document.querySelector<HTMLButtonElement>(
      "[data-action='toggle']",
    );
    const swap = document.querySelector<HTMLButtonElement>(
      "[data-action='swap']",
    );
    act(() => {
      toggle?.click();
    });
    act(() => {
      toggle?.click();
    });
    expect(document.querySelector("[data-probe]")).toBe(probe);
    expect(mounts).toBe(1);

    act(() => {
      swap?.click();
    });
    expect(document.querySelector("[data-probe]")).toBe(probe);
    expect(document.querySelector("[data-dock='b']")?.contains(probe)).toBe(
      true,
    );
    expect(mounts).toBe(1);
  });

  it("docks a popped panel on mount when no window is open", () => {
    usePanelChromeStore
      .getState()
      .setPanelMode("stale-pop-room", "chat", "popped");
    expect(
      usePanelChromeStore.getState().getPanel("stale-pop-room", "chat").mode,
    ).toBe("popped");
    render(
      <PanelHost roomId="stale-pop-room" panelId="chat" title="Chat">
        <Probe />
      </PanelHost>,
    );
    expect(
      usePanelChromeStore.getState().getPanel("stale-pop-room", "chat").mode,
    ).toBe("docked");
    expect(mounts).toBe(1);
  });

  it("leaves a docked panel docked", () => {
    usePanelChromeStore.getState().ensureRoom("docked-room");
    render(
      <PanelHost roomId="docked-room" panelId="chat" title="Chat">
        <Probe />
      </PanelHost>,
    );
    expect(
      usePanelChromeStore.getState().getPanel("docked-room", "chat").mode,
    ).toBe("docked");
  });
});
