import { describe, expect, it } from "vitest";
import {
  KEYBOARD_WALK_FREEZE_MS,
  continueWalk,
  isEmptyMessageBox,
  releaseWalk,
  roomIdFromPath,
  walkBlockedBy,
} from "./keyboardWalk";
import { stepKeyboardOrder, type KeyboardStep } from "@/components/Sidebar/sidebarModel";

const box = (value: string, composer = true) => {
  const el = document.createElement("textarea");
  el.value = value;
  if (composer) el.dataset.composer = "message";
  return el;
};

describe("the keyboard walk", () => {
  it("keeps its order while Alt is held, however slow the presses", () => {
    let calls = 0;
    const fresh = () => {
      calls += 1;
      return [[`r${calls}`]];
    };
    const first = continueWalk(null, fresh, 0);
    expect(first.entries).toEqual([["r1"]]);
    const later = continueWalk(first, fresh, 10 * KEYBOARD_WALK_FREEZE_MS);
    expect(later.entries).toBe(first.entries);
    expect(calls).toBe(1);
  });

  it("keeps its order for quick presses after Alt came up, and starts over after a pause", () => {
    let calls = 0;
    const fresh = () => {
      calls += 1;
      return [[`r${calls}`]];
    };
    const first = releaseWalk(continueWalk(null, fresh, 0));
    const quick = continueWalk(first, fresh, KEYBOARD_WALK_FREEZE_MS - 1);
    expect(quick.entries).toEqual([["r1"]]);
    const paused = continueWalk(releaseWalk(quick), fresh, 2 * KEYBOARD_WALK_FREEZE_MS);
    expect(paused.entries).toEqual([["r2"]]);
    expect(releaseWalk(null)).toBeNull();
  });

  it("reads again when the order it kept is empty (the list had not loaded)", () => {
    const empty = continueWalk(null, () => [], 0);
    expect(continueWalk(empty, () => [["a"]], 1).entries).toEqual([["a"]]);
  });

  it("walks every row once in on-screen order while the list re-sorts under it", () => {
    // The unread-first list: opening a room clears its unread and moves it
    // down. Re-reading the order on each press looped; a kept order does not.
    let order = [["general"], ["thread"], ["jason"], ["dev"], ["ops"], ["leadership"], ["war-room"]];
    const visitedMovesDown = (room: string) => {
      order = [...order.filter((ids) => ids[0] !== room), [room]];
    };
    let walk = releaseWalk(null);
    let current: string | null = "general";
    let last: number | null = null;
    const seen: string[] = [];
    for (let press = 0; press < 6; press += 1) {
      walk = continueWalk(walk, () => order, press * 100);
      const step: KeyboardStep = stepKeyboardOrder(walk.entries, current, 1, last)!;
      last = step.index;
      const target: string = step.target!;
      current = target;
      seen.push(target);
      visitedMovesDown(target);
    }
    expect(seen).toEqual(["thread", "jason", "dev", "ops", "leadership", "war-room"]);
  });
});

describe("where Alt+arrows walk", () => {
  it("goes on from an empty message box, and leaves every other field alone", () => {
    expect(walkBlockedBy(box(""))).toBe(false);
    expect(walkBlockedBy(box("   "))).toBe(false);
    expect(walkBlockedBy(box("half a thought"))).toBe(true);
    // A textarea that is not a message box keeps its line motions.
    expect(walkBlockedBy(box("", false))).toBe(true);
    expect(walkBlockedBy(document.createElement("input"))).toBe(true);
    expect(walkBlockedBy(document.body)).toBe(false);
    expect(walkBlockedBy(null)).toBe(false);
    expect(isEmptyMessageBox(document.createElement("div"))).toBe(false);
  });

  it("reads the room from the address bar", () => {
    expect(roomIdFromPath("/c/room-general")).toBe("room-general");
    expect(roomIdFromPath("/c/hub-1-t-00000001")).toBe("hub-1-t-00000001");
    expect(roomIdFromPath("/c/a%20b")).toBe("a b");
    expect(roomIdFromPath("/")).toBeNull();
    expect(roomIdFromPath("/agents")).toBeNull();
  });
});
