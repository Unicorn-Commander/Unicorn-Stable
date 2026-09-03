import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCallJoinPrefs, saveCallJoinPrefs } from "./callJoinPrefs";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

describe("call join prefs", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("defaults to showing the device check", () => {
    expect(readCallJoinPrefs("u1")).toEqual({ skipDeviceCheck: false });
  });

  it("round-trips per user", () => {
    saveCallJoinPrefs("u1", { skipDeviceCheck: true });
    expect(readCallJoinPrefs("u1").skipDeviceCheck).toBe(true);
    expect(readCallJoinPrefs("u2").skipDeviceCheck).toBe(false);
    expect(readCallJoinPrefs(null).skipDeviceCheck).toBe(false);
  });

  it("only an explicit true skips — junk in storage means the dialog", () => {
    localStorage.setItem(
      "stable.call-join.v1",
      JSON.stringify({ u1: { skipDeviceCheck: "yes" } }),
    );
    expect(readCallJoinPrefs("u1").skipDeviceCheck).toBe(false);
    localStorage.setItem("stable.call-join.v1", "not json");
    expect(readCallJoinPrefs("u1").skipDeviceCheck).toBe(false);
  });

  it("survives a storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(saveCallJoinPrefs("u1", { skipDeviceCheck: true })).toEqual({
      skipDeviceCheck: true,
    });
    expect(readCallJoinPrefs("u1").skipDeviceCheck).toBe(false);
  });
});
