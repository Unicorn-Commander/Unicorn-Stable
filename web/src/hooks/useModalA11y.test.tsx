import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalA11y } from "./useModalA11y";

/**
 * jsdom lays nothing out, so `offsetParent` is always null and the hook's
 * "visible only" filter would drop every control. Stand a parent in for it.
 */
const realOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");

let frames: FrameRequestCallback[] = [];
let spies: { mockRestore: () => void }[] = [];
function runFrames() {
  const due = frames;
  frames = [];
  act(() => due.forEach((cb) => cb(0)));
}

beforeEach(() => {
  frames = [];
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentNode;
    },
  });
  spies = [
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    }),
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  // Only this file's spies: the shared setup keeps mocks of its own alive.
  spies.forEach((spy) => spy.mockRestore());
  if (realOffsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", realOffsetParent);
});

function Sheet({ onClose, ownFocus = false }: { onClose: () => void; ownFocus?: boolean }) {
  const ref = useModalA11y(true, onClose);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ownFocus) input.current?.focus();
  }, [ownFocus]);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Sheet" data-testid="sheet">
      <button type="button">First</button>
      {ownFocus && <input ref={input} aria-label="Search" />}
      <button type="button">Last</button>
    </div>
  );
}

function Harness({ ownFocus = false }: { ownFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Behind the scrim</button>
      {open && <Sheet onClose={() => setOpen(false)} ownFocus={ownFocus} />}
    </>
  );
}

function open(ownFocus = false) {
  render(<Harness ownFocus={ownFocus} />);
  const trigger = screen.getByRole("button", { name: "Open" });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, sheet: screen.getByTestId("sheet") };
}

describe("useModalA11y", () => {
  it("holds focus inside the panel before the first frame", () => {
    const { sheet } = open();
    // No frame has run: the deferred initial focus has not happened yet.
    expect(frames.length).toBeGreaterThan(0);
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it("keeps a Tab pressed before the first frame inside the trap", () => {
    const { sheet } = open();
    // The key lands on whatever has focus. Before the fix that was the
    // trigger, outside the panel, and the trap never saw it.
    const tab = fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(tab).toBe(false); // the trap handled it (default prevented)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    // The late frame must not undo what the user's Tab chose.
    runFrames();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it("moves to the first control one frame later", () => {
    open();
    runFrames();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("leaves focus the component placed itself", () => {
    open(true);
    expect(document.activeElement).toBe(screen.getByLabelText("Search"));
    runFrames();
    expect(document.activeElement).toBe(screen.getByLabelText("Search"));
  });

  it("wraps at both ends and never reaches the page behind", () => {
    const { sheet } = open();
    runFrames();
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it("returns focus to the opener on close", () => {
    const { trigger, sheet } = open();
    runFrames();
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByTestId("sheet")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
