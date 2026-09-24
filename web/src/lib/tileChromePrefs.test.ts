import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TILE_CHROME_PREFS,
  readTileChromePrefs,
  writeTileChromePrefs,
} from "./tileChromePrefs";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

describe("tile chrome prefs", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("defaults to names always and the lower third off", () => {
    expect(readTileChromePrefs("u1")).toEqual(DEFAULT_TILE_CHROME_PREFS);
    expect(DEFAULT_TILE_CHROME_PREFS).toEqual({
      tileNames: "always",
      lowerThird: false,
    });
  });

  it("round-trips the three name modes per user", () => {
    expect(writeTileChromePrefs("u1", { tileNames: "hover" }).tileNames).toBe(
      "hover",
    );
    expect(readTileChromePrefs("u1").tileNames).toBe("hover");
    writeTileChromePrefs("u1", { tileNames: "off" });
    expect(readTileChromePrefs("u1").tileNames).toBe("off");
    writeTileChromePrefs("u2", { tileNames: "hover", lowerThird: true });
    expect(readTileChromePrefs("u1")).toEqual({
      tileNames: "off",
      lowerThird: false,
    });
    expect(readTileChromePrefs("u2")).toEqual({
      tileNames: "hover",
      lowerThird: true,
    });
  });

  it("treats junk as the default", () => {
    localStorage.setItem(
      "stable.tile-chrome.v1",
      JSON.stringify({ u1: { tileNames: "sometimes", lowerThird: "yes" } }),
    );
    expect(readTileChromePrefs("u1")).toEqual(DEFAULT_TILE_CHROME_PREFS);
    localStorage.setItem("stable.tile-chrome.v1", "not json");
    expect(readTileChromePrefs("u1")).toEqual(DEFAULT_TILE_CHROME_PREFS);
  });
});
