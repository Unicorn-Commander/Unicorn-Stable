import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/stores/appStore";
import { usePresenterStore } from "@/stores/presenterStore";
import { OFFER_TITLE, offerPresenterMode } from "./presenterOffer";

describe("presenter offer", () => {
  beforeEach(() => {
    useAppStore.setState({ toasts: [] });
    usePresenterStore.setState({ enabled: false, safeRoomIds: [], scopedUserId: null });
  });

  afterEach(() => {
    useAppStore.setState({ toasts: [] });
    usePresenterStore.setState({ enabled: false, safeRoomIds: [], scopedUserId: null });
  });

  it("offers once and the action enables the local filter", () => {
    offerPresenterMode();
    offerPresenterMode();
    expect(useAppStore.getState().toasts).toHaveLength(1);
    const toast = useAppStore.getState().toasts[0];
    expect(toast).toMatchObject({ title: OFFER_TITLE, action: { label: "Turn on" } });
    toast?.action?.onClick();
    expect(usePresenterStore.getState().enabled).toBe(true);
  });

  it("does not offer while already enabled", () => {
    usePresenterStore.getState().setEnabled(true);
    offerPresenterMode();
    expect(useAppStore.getState().toasts).toEqual([]);
  });
});
