/**
 * @vitest-environment happy-dom
 *
 * The broadcast page is a captured feed. With no opt-in it must not grow a
 * name, a button, or any other text.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BroadcastPage } from "./BroadcastPage";

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

afterEach(cleanup);

describe("BroadcastPage", () => {
  it("renders nothing extra unless the room opts in", () => {
    window.history.replaceState({}, "", "/broadcast/room/person");
    const view = render(<BroadcastPage />);
    expect(view.querySelector("[data-testid='lower-third']")).toBeNull();
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent?.trim()).toBe("");
  });

  it("still renders nothing when the token URL has not opted in and nobody is speaking", () => {
    window.history.replaceState({}, "", "/broadcast/room/person?lowerThird=0");
    const view = render(<BroadcastPage />);
    expect(view.querySelector("[data-testid='lower-third']")).toBeNull();
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent?.trim()).toBe("");
  });
});
