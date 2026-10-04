import { usePresenterStore, PRESENTER_PREF_KEY } from "./presenterStore";

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
