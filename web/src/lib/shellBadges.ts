import type { Room } from "@/services/api";
import { countNeedsYou } from "@/lib/conversation";

export interface ShellBadges {
  /** Chats tab / Conversations rail: rooms that need you, threads included. */
  conversations: number;
  /**
   * Home tab / Home rail: what only Home holds — invites waiting on a look.
   * The rooms are Chats' number; counting them on Home too drew "2" on both
   * tabs for the same two rooms (review 2, P2-11).
   */
  home: number;
}

/**
 * The shell's two badges, each counting something the other does not.
 * Threads are counted: a seat's reply lands in a thread under its hub, and
 * a badge that skipped threads went dark exactly when the conversation
 * moved there. Muted rooms do not count; a channel thread needs a mention,
 * like a channel does.
 */
export function shellBadges(input: {
  rooms: readonly Room[];
  unreadCounts: Record<string, number>;
  mentionUnreads: Record<string, boolean>;
  isMuted: (roomId: string) => boolean;
  pendingInvites: number;
}): ShellBadges {
  const conversations = countNeedsYou(
    [...input.rooms],
    input.unreadCounts,
    input.mentionUnreads,
    input.isMuted,
  );
  return { conversations, home: Math.max(0, input.pendingInvites) };
}
