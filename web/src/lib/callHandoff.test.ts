import { describe, expect, it } from "vitest";
import { DisconnectReason } from "livekit-client";
import {
  isMovedToAnotherDevice,
  MOVED_TO_ANOTHER_DEVICE_TOAST,
} from "./callHandoff";

describe("callHandoff", () => {
  it("recognizes a duplicate-identity disconnect as a device handoff", () => {
    expect(isMovedToAnotherDevice(DisconnectReason.DUPLICATE_IDENTITY)).toBe(
      true,
    );
  });

  it("treats every other disconnect as NOT a handoff", () => {
    // A handoff toast on a genuine failure would tell the user their call is
    // safely elsewhere when it is simply gone — these must all stay false.
    expect(isMovedToAnotherDevice(undefined)).toBe(false);
    expect(isMovedToAnotherDevice(DisconnectReason.CLIENT_INITIATED)).toBe(
      false,
    );
    expect(isMovedToAnotherDevice(DisconnectReason.SERVER_SHUTDOWN)).toBe(
      false,
    );
    expect(
      isMovedToAnotherDevice(DisconnectReason.PARTICIPANT_REMOVED),
    ).toBe(false);
    expect(isMovedToAnotherDevice(DisconnectReason.ROOM_DELETED)).toBe(false);
  });

  it("ships toast copy that names the situation and the way back", () => {
    expect(MOVED_TO_ANOTHER_DEVICE_TOAST.title).toMatch(/another device/i);
    expect(MOVED_TO_ANOTHER_DEVICE_TOAST.body).toMatch(/move it back/i);
    expect(MOVED_TO_ANOTHER_DEVICE_TOAST.kind).toBe("info");
  });
});
