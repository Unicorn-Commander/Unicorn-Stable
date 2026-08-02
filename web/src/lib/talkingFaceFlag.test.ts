import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TALKING_FACE_FLAG_KEY,
  __resetTalkingFaceFlagCache,
  isTalkingFaceEnabled,
} from "./talkingFaceFlag";

/* This suite runs in the node environment, like the rest of the repo's tests —
 * the flag only needs two browser globals, and a whole jsdom for them would be
 * a devDependency the project does not otherwise carry. */

const store = new Map<string, string>();
let throwOnGet = false;

const fakeStorage = {
  getItem: (k: string) => {
    if (throwOnGet) throw new Error("SecurityError: storage blocked");
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const g = globalThis as unknown as {
  window?: { location: { search: string } };
  localStorage?: typeof fakeStorage;
};

/** Simulate a fresh document load at the given query string. */
function reload(search = "") {
  __resetTalkingFaceFlagCache();
  g.window = { location: { search } };
  g.localStorage = fakeStorage;
}

beforeEach(() => {
  store.clear();
  throwOnGet = false;
  vi.spyOn(console, "info").mockImplementation(() => {});
  reload();
});

afterAll(() => {
  delete g.window;
  delete g.localStorage;
  __resetTalkingFaceFlagCache();
  vi.restoreAllMocks();
});

describe("isTalkingFaceEnabled", () => {
  it("IS OFF BY DEFAULT", () => {
    // The single most load-bearing assertion in this file. Nothing an existing
    // user sees may change until they opt in. If this ever returns true with an
    // empty environment, every agent tile in every call becomes a WebGL surface
    // for everybody, including phones.
    expect(isTalkingFaceEnabled()).toBe(false);
  });

  it("turns on from localStorage", () => {
    for (const on of ["1", "true"]) {
      store.set(TALKING_FACE_FLAG_KEY, on);
      __resetTalkingFaceFlagCache();
      expect(isTalkingFaceEnabled()).toBe(true);
    }
  });

  it("turns off from localStorage", () => {
    for (const off of ["0", "false"]) {
      store.set(TALKING_FACE_FLAG_KEY, off);
      __resetTalkingFaceFlagCache();
      expect(isTalkingFaceEnabled()).toBe(false);
    }
  });

  it("turns on from ?talkingFace=1 and persists it", () => {
    reload("?talkingFace=1");
    expect(isTalkingFaceEnabled()).toBe(true);
    expect(store.get(TALKING_FACE_FLAG_KEY)).toBe("1");
  });

  it("lets a stored OFF beat a link that says on", () => {
    // Someone who has explicitly opted out should not be re-enrolled by a URL
    // pasted into a chat.
    store.set(TALKING_FACE_FLAG_KEY, "0");
    reload("?talkingFace=1");
    expect(isTalkingFaceEnabled()).toBe(false);
  });

  it("?talkingFace=0 turns it off and persists that too", () => {
    reload("?talkingFace=0");
    expect(isTalkingFaceEnabled()).toBe(false);
    expect(store.get(TALKING_FACE_FLAG_KEY)).toBe("0");
  });

  it("ignores values that are not an explicit yes or no", () => {
    for (const junk of ["", "yes", "on", "2", "maybe"]) {
      store.set(TALKING_FACE_FLAG_KEY, junk);
      __resetTalkingFaceFlagCache();
      expect(isTalkingFaceEnabled()).toBe(false);
    }
  });

  it("survives blocked storage (private mode) without throwing", () => {
    throwOnGet = true;
    __resetTalkingFaceFlagCache();
    expect(() => isTalkingFaceEnabled()).not.toThrow();
    expect(isTalkingFaceEnabled()).toBe(false);
  });

  it("caches — a mid-session flip must not tear down a live call", () => {
    expect(isTalkingFaceEnabled()).toBe(false);
    store.set(TALKING_FACE_FLAG_KEY, "1");
    expect(isTalkingFaceEnabled()).toBe(false); // still off until reload
    __resetTalkingFaceFlagCache();
    expect(isTalkingFaceEnabled()).toBe(true);
  });

  it("is off when there is no window at all (SSR / worker)", () => {
    __resetTalkingFaceFlagCache();
    delete g.window;
    delete g.localStorage;
    expect(isTalkingFaceEnabled()).toBe(false);
  });
});
