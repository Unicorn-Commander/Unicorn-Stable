import { describe, expect, it } from "vitest";
import { adoptLegacySplitSize, type SplitSizeStorage } from "./useSplitPane";

function memory(): SplitSizeStorage & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (key) => dump.get(key) ?? null,
    setItem: (key, value) => {
      dump.set(key, value);
    },
  };
}

describe("adoptLegacySplitSize", () => {
  it("copies the old call-chat width once and does not overwrite a saved width", () => {
    const store = memory();
    store.setItem("stable.split.call-chat.w.v1", "420");
    adoptLegacySplitSize(store, "call-chat:room-1", "call-chat", "horizontal");
    expect(store.getItem("stable.split.call-chat:room-1.w.v1")).toBe("420");

    store.setItem("stable.split.call-chat.w.v1", "200");
    adoptLegacySplitSize(store, "call-chat:room-1", "call-chat", "horizontal");
    expect(store.getItem("stable.split.call-chat:room-1.w.v1")).toBe("420");

    adoptLegacySplitSize(store, "call-chat:room-2", "call-chat", "horizontal");
    expect(store.getItem("stable.split.call-chat:room-2.w.v1")).toBe("200");
  });
});
