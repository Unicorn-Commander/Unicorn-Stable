import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";
import {
  usePresenterStore,
  PRESENTER_PREF_KEY,
  resetPresenterSessionForTests,
} from "./presenterStore";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("presenter device preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    usePresenterStore.setState({
      enabled: false,
      safeRoomIds: [],
      scopedUserId: null,
    });
    resetPresenterSessionForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists independently for each signed-in user", () => {
    const store = usePresenterStore.getState();
    store.scopeToUser("user-a");
    store.setEnabled(true);
    store.toggleSafeRoom("room-a");

    store.scopeToUser("user-b");
    store.setEnabled(false);
    store.setSafeRoom("room-b", true);
    store.scopeToUser("user-a");
    expect(usePresenterStore.getState()).toMatchObject({
      enabled: true,
      safeRoomIds: ["room-a"],
      scopedUserId: "user-a",
    });
    expect(localStorage.getItem(`${PRESENTER_PREF_KEY}::user-b`)).toContain('"enabled":false');
    expect(localStorage.getItem(`${PRESENTER_PREF_KEY}::user-b`)).toContain('"room-b"');
  });

  it("keeps a choice made before sign-in over an older saved one", () => {
    // Saved long ago for this person: off.
    localStorage.setItem(`${PRESENTER_PREF_KEY}::user-a`, JSON.stringify({ enabled: false, safeRoomIds: ["room-a"] }));
    // This page was opened with ?present=1 (or toggled on the sign-in screen).
    usePresenterStore.getState().setEnabled(true);
    usePresenterStore.getState().scopeToUser("user-a");
    expect(usePresenterStore.getState()).toMatchObject({
      enabled: true,
      safeRoomIds: ["room-a"],
      scopedUserId: "user-a",
    });
    expect(localStorage.getItem(`${PRESENTER_PREF_KEY}::user-a`)).toContain('"enabled":true');
  });

  it("loads the saved choice when nothing was chosen on this page", () => {
    localStorage.setItem(`${PRESENTER_PREF_KEY}::user-a`, JSON.stringify({ enabled: true, safeRoomIds: [] }));
    usePresenterStore.getState().scopeToUser("user-a");
    expect(usePresenterStore.getState().enabled).toBe(true);
  });

  it("does not hand one person's safe rooms to the next person on the device", () => {
    const store = usePresenterStore.getState();
    store.scopeToUser("user-a");
    store.setEnabled(true);
    store.setSafeRoom("room-a", true);
    store.scopeToUser("user-b");
    expect(usePresenterStore.getState()).toMatchObject({
      enabled: true, // the device was hiding, so it keeps hiding
      safeRoomIds: [],
      scopedUserId: "user-b",
    });
  });

  it("supports both enable toggles and safe-room checkboxes", () => {
    const store = usePresenterStore.getState();
    store.toggleEnabled();
    store.setSafeRoom("room-a", true);
    store.setSafeRoom("room-b", true);
    store.toggleSafeRoom("room-a");
    expect(usePresenterStore.getState()).toMatchObject({
      enabled: true,
      safeRoomIds: ["room-b"],
    });
  });
});
