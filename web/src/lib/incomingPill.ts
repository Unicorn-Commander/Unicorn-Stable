/**
 * Last message the video pill has already accounted for, per room.
 *
 * Module scope on purpose. The pill unmounts when the phone leaves Video
 * (Split / Chat), and a component ref would reset. The next message after
 * coming back would be treated as the baseline and never shown.
 */

export interface IncomingPillMessage {
  id: string;
  senderId: string | null;
  senderName?: string | null;
  text: string;
}

export type IncomingPillDecision =
  | { action: "ignore" }
  | { action: "baseline" }
  | { action: "show"; line: string };

const lastSeenByRoom = new Map<string, string>();

export function resetIncomingPillMemory(): void {
  lastSeenByRoom.clear();
}

export function decideIncomingPill(
  roomId: string,
  last: IncomingPillMessage | null,
  currentUserId: string | null,
): IncomingPillDecision {
  if (!last) return { action: "ignore" };
  const prev = lastSeenByRoom.get(roomId);
  if (prev === undefined) {
    lastSeenByRoom.set(roomId, last.id);
    return { action: "baseline" };
  }
  if (prev === last.id) return { action: "ignore" };
  lastSeenByRoom.set(roomId, last.id);
  if (currentUserId && last.senderId === currentUserId)
    return { action: "ignore" };
  const text = last.text.replace(/\s+/g, " ").trim();
  if (!text) return { action: "ignore" };
  const name = last.senderName?.trim() || "Someone";
  return { action: "show", line: `${name}: ${text}` };
}
