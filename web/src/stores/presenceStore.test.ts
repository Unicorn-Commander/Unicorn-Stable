import { beforeEach, describe, expect, it } from "vitest";
import { isPersonOnline, usePresenceStore } from "./presenceStore";

describe("presenceStore", () => {
  beforeEach(() => {
    usePresenceStore.getState().reset();
  });

  it("seeds from a directory snapshot", () => {
    usePresenceStore.getState().setFromDirectory([
      { id: "a", is_online: true },
      { id: "b", is_online: false },
    ]);
    const { byId } = usePresenceStore.getState();
    expect(byId.a?.isOnline).toBe(true);
    expect(byId.b?.isOnline).toBe(false);
    expect(byId.a?.updatedAt).toBeTypeOf("number");
  });

  it("applies live events over snapshot state", () => {
    usePresenceStore.getState().setFromDirectory([{ id: "a", is_online: false }]);
    usePresenceStore.getState().applyEvent("a", true);
    expect(usePresenceStore.getState().byId.a?.isOnline).toBe(true);
    usePresenceStore.getState().applyEvent("a", false);
    expect(usePresenceStore.getState().byId.a?.isOnline).toBe(false);
  });

  it("ignores empty participant ids on applyEvent", () => {
    usePresenceStore.getState().applyEvent("", true);
    expect(usePresenceStore.getState().byId).toEqual({});
  });

  it("reset clears all presence (federation server switch)", () => {
    usePresenceStore.getState().setFromDirectory([{ id: "a", is_online: true }]);
    usePresenceStore.getState().applyEvent("b", true);
    usePresenceStore.getState().reset();
    expect(usePresenceStore.getState().byId).toEqual({});
  });

  it("isPersonOnline prefers live store then fallback", () => {
    expect(isPersonOnline("missing", true)).toBe(true);
    expect(isPersonOnline("missing", false)).toBe(false);
    usePresenceStore.getState().applyEvent("x", true);
    expect(isPersonOnline("x", false)).toBe(true);
    usePresenceStore.getState().applyEvent("x", false);
    expect(isPersonOnline("x", true)).toBe(false);
  });
});
