import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { focusWhenShown } from "./focusWhenShown";

/** A box that, like a real one, cannot take the focus while it has no layout. */
function parkedBox() {
  const box = document.createElement("textarea");
  document.body.appendChild(box);
  let shown = false;
  const focus = box.focus.bind(box);
  box.focus = () => {
    if (shown) focus();
  };
  box.getClientRects = () => (shown ? ([{}] as unknown as DOMRectList) : ([] as unknown as DOMRectList));
  return {
    box,
    show() {
      shown = true;
    },
  };
}

let observers: Array<{ callback: () => void; disconnected: boolean }> = [];
const RealResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = class {
    private entry: { callback: () => void; disconnected: boolean };
    constructor(callback: () => void) {
      this.entry = { callback, disconnected: false };
      observers.push(this.entry);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.entry.disconnected = true;
    }
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = RealResizeObserver;
  document.body.innerHTML = "";
});

/** What the browser does when the box gets its first box. */
function layout() {
  for (const observer of observers) if (!observer.disconnected) observer.callback();
}

describe("focusWhenShown", () => {
  it("focuses at once when the box is on screen", () => {
    const { box, show } = parkedBox();
    show();
    focusWhenShown(box);
    expect(document.activeElement).toBe(box);
    expect(observers).toHaveLength(0);
  });

  it("takes the focus the first time a parked box is shown (review 2, P2-3)", () => {
    const { box, show } = parkedBox();
    focusWhenShown(box);
    expect(document.activeElement).toBe(document.body);
    // Still parked: a resize with no box changes nothing.
    layout();
    expect(document.activeElement).toBe(document.body);
    show();
    layout();
    expect(document.activeElement).toBe(box);
    expect(observers[0]!.disconnected).toBe(true);
  });

  it("does not take the focus from where the user put it meanwhile", () => {
    const { box, show } = parkedBox();
    const search = document.createElement("input");
    document.body.appendChild(search);
    focusWhenShown(box);
    search.focus();
    show();
    layout();
    expect(document.activeElement).toBe(search);
  });

  it("takes it from where it was when asked (the row that opened the room)", () => {
    const row = document.createElement("button");
    document.body.appendChild(row);
    row.focus();
    const { box, show } = parkedBox();
    focusWhenShown(box);
    show();
    layout();
    expect(document.activeElement).toBe(box);
  });

  it("stops waiting when cancelled", () => {
    const { box, show } = parkedBox();
    const stop = focusWhenShown(box);
    stop();
    expect(observers[0]!.disconnected).toBe(true);
    show();
    expect(document.activeElement).toBe(document.body);
  });
});
