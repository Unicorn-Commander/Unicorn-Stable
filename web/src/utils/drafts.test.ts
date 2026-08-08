import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  getDraft,
  hasDraft,
  saveDraft,
  subscribeDrafts,
} from "./drafts";

describe("drafts", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
  });

  it("round-trips a draft and clears it", () => {
    saveDraft("room-1", "hello world");
    expect(hasDraft("room-1")).toBe(true);
    expect(getDraft("room-1")).toBe("hello world");

    clearDraft("room-1");
    expect(hasDraft("room-1")).toBe(false);
    expect(getDraft("room-1")).toBe("");
  });

  it("treats whitespace-only text as no draft", () => {
    saveDraft("room-1", "   ");
    expect(hasDraft("room-1")).toBe(false);
    expect(getDraft("room-1")).toBe("");
  });

  it("keeps drafts per room independent", () => {
    saveDraft("room-1", "a");
    saveDraft("room-2", "b");
    clearDraft("room-1");
    expect(hasDraft("room-1")).toBe(false);
    expect(getDraft("room-2")).toBe("b");
  });

  it("notifies subscribers on save and clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDrafts(listener);

    saveDraft("room-1", "x");
    expect(listener).toHaveBeenCalledTimes(1);

    saveDraft("room-1", "x");
    expect(listener).toHaveBeenCalledTimes(1);

    clearDraft("room-1");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    saveDraft("room-2", "y");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
