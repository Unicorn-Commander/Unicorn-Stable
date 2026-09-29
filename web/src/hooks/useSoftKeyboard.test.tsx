import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTextEntry, keyboardLikelyOpen, useSoftKeyboard } from "./useSoftKeyboard";

const facts = (over: Partial<Parameters<typeof keyboardLikelyOpen>[0]> = {}) => ({
  coarse: false,
  focusedTextEntry: false,
  visualHeight: 844,
  visualScale: 1,
  innerHeight: 844,
  ...over,
});

describe("is the on-screen keyboard up", () => {
  it("says yes for a focused field on a touch screen, whatever the viewport says (iOS)", () => {
    expect(keyboardLikelyOpen(facts({ coarse: true, focusedTextEntry: true }))).toBe(true);
    // A mouse and a keyboard: a focused field brings up nothing.
    expect(keyboardLikelyOpen(facts({ focusedTextEntry: true }))).toBe(false);
  });

  it("says yes when the visual viewport is well short of the layout viewport (Android)", () => {
    expect(keyboardLikelyOpen(facts({ visualHeight: 508 }))).toBe(true);
    // A collapsing toolbar is not a keyboard.
    expect(keyboardLikelyOpen(facts({ visualHeight: 790 }))).toBe(false);
    // Zoomed in, the visual viewport shrinks with no keyboard at all.
    expect(keyboardLikelyOpen(facts({ visualHeight: 400, visualScale: 2 }))).toBe(false);
    expect(keyboardLikelyOpen(facts({ visualHeight: null }))).toBe(false);
  });

  it("knows which fields bring the keyboard up", () => {
    const area = document.createElement("textarea");
    expect(isTextEntry(area)).toBe(true);
    area.readOnly = true;
    expect(isTextEntry(area)).toBe(false);
    const search = document.createElement("input");
    search.type = "search";
    expect(isTextEntry(search)).toBe(true);
    const box = document.createElement("input");
    box.type = "checkbox";
    expect(isTextEntry(box)).toBe(false);
    expect(isTextEntry(document.createElement("button"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

function Probe() {
  return <p data-testid="kb">{useSoftKeyboard() ? "up" : "down"}</p>;
}

describe("useSoftKeyboard", () => {
  const original = window.matchMedia;
  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.matchMedia = original;
    document.body.innerHTML = "";
  });

  it("goes up when a field takes the focus on a touch screen and down when it lets go", () => {
    const view = render(<Probe />);
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    expect(view.getByTestId("kb").textContent).toBe("down");
    act(() => field.focus());
    expect(view.getByTestId("kb").textContent).toBe("up");
    act(() => {
      field.blur();
      vi.runAllTimers();
    });
    expect(view.getByTestId("kb").textContent).toBe("down");
  });

  it("stays up while the focus moves from one field to the next", () => {
    const view = render(<Probe />);
    const one = document.createElement("input");
    const two = document.createElement("textarea");
    document.body.append(one, two);
    act(() => one.focus());
    act(() => two.focus());
    act(() => vi.runAllTimers());
    expect(view.getByTestId("kb").textContent).toBe("up");
  });
});
