import { describe, expect, it } from "vitest";
import { matchCallLayoutShortcut } from "./useRoomPanelHotkeys";

const up = {
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  repeat: false,
};

describe("matchCallLayoutShortcut", () => {
  it("uses the character, so a Dvorak C still toggles chat", () => {
    expect(matchCallLayoutShortcut({ ...up, key: "c" })).toEqual({ type: "chat" });
    expect(matchCallLayoutShortcut({ ...up, key: "C" })).toEqual({ type: "chat" });
    // Physical KeyC on Dvorak is not C. The shortcut follows e.key.
    expect(matchCallLayoutShortcut({ ...up, key: "j" })).toBeNull();
  });

  it("applies presets with Alt+Shift+1..4, not Alt+1", () => {
    expect(
      matchCallLayoutShortcut({ ...up, key: "1", altKey: true, shiftKey: true }),
    ).toEqual({ type: "preset", id: "focus" });
    expect(
      matchCallLayoutShortcut({ ...up, key: "!", altKey: true, shiftKey: true }),
    ).toEqual({ type: "preset", id: "focus" });
    expect(
      matchCallLayoutShortcut({ ...up, key: "4", altKey: true, shiftKey: true }),
    ).toEqual({ type: "preset", id: "show" });
    expect(
      matchCallLayoutShortcut({ ...up, key: "$", altKey: true, shiftKey: true }),
    ).toEqual({ type: "preset", id: "show" });
    expect(matchCallLayoutShortcut({ ...up, key: "1", altKey: true })).toBeNull();
  });

  it("pops a panel from Alt+Shift and the letter you typed", () => {
    expect(
      matchCallLayoutShortcut({ ...up, key: "c", altKey: true, shiftKey: true }),
    ).toEqual({ type: "pop", id: "chat" });
    expect(
      matchCallLayoutShortcut({ ...up, key: "K", altKey: true, shiftKey: true }),
    ).toEqual({ type: "pop", id: "tasks" });
  });

  it("ignores chords that belong to the browser or to typing", () => {
    expect(matchCallLayoutShortcut({ ...up, key: "c", metaKey: true })).toBeNull();
    expect(matchCallLayoutShortcut({ ...up, key: "c", ctrlKey: true })).toBeNull();
    expect(matchCallLayoutShortcut({ ...up, key: "c", repeat: true })).toBeNull();
  });
});
