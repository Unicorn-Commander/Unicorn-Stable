import type { RoomMember } from "@/services/api";

/** UI affordance only; the API independently enforces the same role rule. */
export function isRoomApprover(
  members: RoomMember[],
  currentUserId: string | undefined,
): boolean {
  return members.some(
    (member) =>
      (member.is_self ||
        member.participant_id === currentUserId ||
        member.user_id === currentUserId) &&
      (member.role === "owner" || member.role === "admin"),
  );
}
