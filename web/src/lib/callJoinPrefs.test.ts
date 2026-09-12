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

  it("defaults to no device check (calls connect straight in)", () => {
    expect(readCallJoinPrefs("u1")).toEqual({ checkDevicesBeforeVideo: false });
  });

  it("round-trips per user", () => {
    saveCallJoinPrefs("u1", { checkDevicesBeforeVideo: true });
    expect(readCallJoinPrefs("u1").checkDevicesBeforeVideo).toBe(true);
    expect(readCallJoinPrefs("u2").checkDevicesBeforeVideo).toBe(false);
    expect(readCallJoinPrefs(null).checkDevicesBeforeVideo).toBe(false);
  });

  it("only an explicit true turns the video check on — junk in storage means straight in", () => {
    localStorage.setItem(
      "stable.call-join.v2",
      JSON.stringify({ u1: { checkDevicesBeforeVideo: "yes" } }),
    );
    expect(readCallJoinPrefs("u1").checkDevicesBeforeVideo).toBe(false);
    localStorage.setItem("stable.call-join.v2", "not json");
    expect(readCallJoinPrefs("u1").checkDevicesBeforeVideo).toBe(false);
  });

  it("ignores the v1 record (which could only ever ADD dialogs) and clears it on save", () => {
    localStorage.setItem(
      "stable.call-join.v1",
      JSON.stringify({ u1: { skipDeviceCheck: false } }),
    );
    expect(readCallJoinPrefs("u1").checkDevicesBeforeVideo).toBe(false);
    saveCallJoinPrefs("u1", { checkDevicesBeforeVideo: false });
    expect(localStorage.getItem("stable.call-join.v1")).toBeNull();
  });

  it("survives a storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(saveCallJoinPrefs("u1", { checkDevicesBeforeVideo: true })).toEqual({
      checkDevicesBeforeVideo: true,
    });
    expect(readCallJoinPrefs("u1").checkDevicesBeforeVideo).toBe(false);
  });
});
