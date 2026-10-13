import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePresenterStore } from "@/stores/presenterStore";
import { PresenterBadge } from "./PresenterBadge";

describe("PresenterBadge", () => {
  beforeEach(() => {
    usePresenterStore.setState({ enabled: false, safeRoomIds: [], scopedUserId: null });
  });

  afterEach(() => {
    usePresenterStore.setState({ enabled: false, safeRoomIds: [], scopedUserId: null });
  });

  it("is absent when off and turns the device filter off when clicked", () => {
    const { rerender } = render(<PresenterBadge />);
    expect(screen.queryByTestId("presenter-badge")).toBeNull();
    usePresenterStore.getState().setEnabled(true);
    rerender(<PresenterBadge />);
    fireEvent.click(screen.getByTestId("presenter-badge"));
    expect(usePresenterStore.getState().enabled).toBe(false);
  });
});
