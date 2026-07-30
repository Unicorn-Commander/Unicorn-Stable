import { describe, expect, it } from "vitest";
import type { RoomMember } from "@/services/api";
import { isRoomApprover } from "./approvals";

function member(
  role: RoomMember["role"],
  overrides: Partial<RoomMember> = {},
): RoomMember {
  return {
    username: role,
    display_name: role,
    role,
    joined_at: "2026-07-29T00:00:00Z",
    ...overrides,
  };
}

describe("isRoomApprover", () => {
  it.each(["owner", "admin"] as const)(
    "allows a server-asserted self with the %s role",
    (role) => {
      expect(isRoomApprover([member(role, { is_self: true })], "keycloak-sub")).toBe(
        true,
      );
    },
  );

  it("does not expose decision controls to members or guests", () => {
    expect(
      isRoomApprover(
        [
          member("member", { is_self: true }),
          member("owner", { participant_id: "someone-else" }),
        ],
        "signed-in-user",
      ),
    ).toBe(false);
  });

  it("accepts the participant id when older payloads omit is_self", () => {
    expect(
      isRoomApprover(
        [member("admin", { participant_id: "participant-1" })],
        "participant-1",
      ),
    ).toBe(true);
  });
});
