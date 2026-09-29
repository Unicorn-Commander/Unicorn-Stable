/**
 * Home's composer (Nav v3 §2.7): who it addresses, where a message lands,
 * and the sequence that turns the first line into a conversation.
 *
 * Pure, and the sequence takes its four requests as arguments, so the rules
 * — default seat, partner target, what happens when a step fails — are
 * tested without a server or a component.
 */
import type { Agent, CrewMember, Message, Room, RoomSeat } from "@/services/api";
import { CREW_GROUP_ORDER, crewFromRoster, hubRoomFor, opensHub } from "@/lib/crew";
import { buildSendRequest, newClientMsgId, type OutgoingSendRequest, type SendRequestBody } from "@/lib/sendPipeline";

/** The house's general assistant: the seat of last resort. */
export const SIDEKICK_ID = "sidekick";

function isSidekick(member: Pick<CrewMember, "agent_id" | "display_name">): boolean {
  return (
    member.agent_id === SIDEKICK_ID || member.display_name.trim().toLowerCase() === SIDEKICK_ID
  );
}

/** Sidekick when neither /crew nor the roster has it: the built-in fallback. */
function builtInSidekick(): CrewMember {
  return {
    agent_id: SIDEKICK_ID,
    participant_id: "",
    display_name: "Sidekick",
    avatar_url: null,
    role_line: null,
    backend: "brigade",
    kind: "brigade",
    owner: null,
    group: "house",
    presence: "unknown",
    hub_room_id: null,
    seat_capabilities: null,
    last_line: null,
    last_at: null,
    last_seen_at: null,
    unread: 0,
  };
}

/**
 * Who the composer can address, in the picker's order: your seats, then the
 * house — /crew's rows, each group in the server's order.
 *
 * Enter starts a NEW conversation, so the list holds only who will hear one
 * (see `opensHub`): house agents, and your seats whose runner follows you
 * into new rooms. Left out, on purpose (review 2, P1-1):
 * - a partner's seat. A line posted into a room you share, without "@name",
 *   is never answered and is read by everyone there, customers included.
 * - one of your seats whose runner does not follow you (no announced
 *   capabilities). A hub made for it would stay silent.
 *
 * Without a seat of your own the list must still hold the seat of last
 * resort, so Sidekick is added to the house (from the roster, else built in)
 * when /crew does not carry it.
 */
export function composerSeats(
  crew: readonly CrewMember[],
  roster: readonly Agent[],
): CrewMember[] {
  const rows = CREW_GROUP_ORDER.flatMap((group) =>
    crew.filter((row) => row.group === group && opensHub(row)),
  );
  if (rows.some((row) => row.group === "own_seat")) return rows;
  if (rows.some((row) => row.group === "house" && isSidekick(row))) return rows;
  const sidekick = crewFromRoster(roster).find(isSidekick) ?? builtInSidekick();
  return [...rows, sidekick];
}

/**
 * The seat the composer opens on: your default agent when it is one of your
 * seats, else your first seat. With no seat of your own: your default agent
 * when the house has it, else Sidekick, else whoever is first.
 */
export function defaultComposerSeat(
  seats: readonly CrewMember[],
  defaultAgentId: string | null | undefined,
): CrewMember | null {
  const own = seats.filter((row) => row.group === "own_seat");
  if (own.length > 0) {
    return own.find((row) => row.agent_id === defaultAgentId) ?? own[0] ?? null;
  }
  const house = seats.filter((row) => row.group === "house");
  return (
    house.find((row) => !!defaultAgentId && row.agent_id === defaultAgentId) ??
    house.find(isSidekick) ??
    house[0] ??
    seats[0] ??
    null
  );
}

export type ComposerTarget =
  /** Your seat or a house agent: Enter starts a thread under its hub. */
  | { kind: "new_conversation"; agentId: string; name: string; hubRoomId: string | null }
  /** A partner's seat: the message goes into the newest room you share. */
  | { kind: "shared_room"; agentId: string; name: string; roomId: string; roomLabel: string }
  /** Nowhere to send: the reason is said under the box. */
  | { kind: "none"; reason: string };

export function composerTarget(
  seat: CrewMember | null | undefined,
  rooms: readonly Room[],
  selfIds: readonly (string | null | undefined)[],
  crewAnswered = true,
): ComposerTarget {
  if (!seat) return { kind: "none", reason: "No agent to message yet" };
  // Defensive: composerSeats never offers these (review 2, P1-1).
  if (seat.group === "partner") {
    return {
      kind: "none",
      reason: `Talk to ${seat.display_name} in a room you share, with @${seat.display_name}`,
    };
  }
  if (!opensHub(seat)) {
    return {
      kind: "none",
      reason: `${seat.display_name} only answers in the rooms set up for it`,
    };
  }
  return {
    kind: "new_conversation",
    agentId: seat.agent_id,
    name: seat.display_name,
    // /crew's word first: the hub may not be in the room list yet.
    hubRoomId: seat.hub_room_id ?? hubRoomFor(seat, rooms, selfIds, crewAnswered)?.id ?? null,
  };
}

/** What the line under the box says before sending, or null for nothing. */
export function composerTargetLine(target: ComposerTarget): string | null {
  if (target.kind === "shared_room") return `Posts in ${target.roomLabel}, the room you share with ${target.name}`;
  if (target.kind === "none") return target.reason;
  return null;
}

/** The server titles a thread from its seed the same way: 60 characters. */
export const CONVERSATION_TITLE_CHARS = 60;

/** A new conversation is titled from its first line. Empty stays empty. */
export function conversationTitle(content: string | null | undefined): string {
  const compact = (content ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (compact.length <= CONVERSATION_TITLE_CHARS) return compact;
  return compact.slice(0, CONVERSATION_TITLE_CHARS - 1).trimEnd() + "…";
}

/**
 * What the title is made from. A command changes what is sent ("/research
 * x" goes out as a framed request): the title is what was asked, so it is
 * made from what was typed, without the command's word.
 */
export function titleSource(typed: string | null | undefined, sent: string): string {
  const text = (typed ?? "").trim();
  if (!text.startsWith("/")) return sent;
  const asked = text.replace(/^\/\S+\s*/, "").trim();
  return asked || sent;
}

/** True when the pick differs from the seat's own settings and must be written. */
export function seatNeedsWrite(seat: RoomSeat | null | undefined): seat is RoomSeat {
  return !!seat && (seat.model !== null || seat.effort !== null);
}

export interface ConversationDeps {
  /** POST /agents/{id}/hub — idempotent. */
  ensureHub: (agentId: string) => Promise<Room>;
  /** POST /rooms/{hub}/threads */
  createThread: (hubId: string, body: { title?: string | null }) => Promise<Room>;
  /** PATCH /rooms/{id} {metadata: {seats: {<agent_id>: …}}} */
  setSeat: (roomId: string, agentId: string, seat: RoomSeat) => Promise<unknown>;
  /** POST /rooms/{id}/messages */
  post: (roomId: string, body: SendRequestBody) => Promise<Message>;
}

export interface ConversationInput {
  target: ComposerTarget;
  content: string;
  attachments?: OutgoingSendRequest["attachments"];
  extraMetadata?: Record<string, unknown>;
  /** The brain picked for a NEW conversation; null or all-null = the seat's own. */
  seat?: RoomSeat | null;
  /** The room's model override for a house agent, a top-level field of the send. */
  modelOverride?: string | null;
  /** One id per message: a retry from the room's composer collapses onto it. */
  clientMsgId?: string;
  /** What the conversation's title is made from; the message by default. */
  titleFrom?: string | null;
}

export type ConversationResult =
  /** The message is in the room. */
  | { status: "sent"; roomId: string; hub: Room | null; thread: Room | null; message: Message }
  /**
   * Nothing to land in: the hub or the thread could not be made (or there
   * was no target). Stay on Home, the draft untouched.
   */
  | { status: "failed"; stage: "target" | "hub" | "thread"; error: unknown }
  /**
   * The conversation exists and the message is not in it: its brain could
   * not be set, or the post failed. Go there, the draft in its box.
   */
  | {
      status: "unsent";
      stage: "seat" | "post";
      roomId: string;
      hub: Room | null;
      thread: Room | null;
      error: unknown;
    };

/**
 * Enter on Home. For your seat or a house agent: make sure of the hub,
 * start a thread under it titled from the first line, set the thread's
 * brain when one was picked, post. For a partner's seat: post into the
 * shared room. Every step is awaited before the next, and a failed step
 * stops the sequence — a message is never posted into a conversation whose
 * brain is not the one that was picked.
 */
export async function startConversation(
  deps: ConversationDeps,
  input: ConversationInput,
): Promise<ConversationResult> {
  const { target } = input;
  if (target.kind === "none") {
    return { status: "failed", stage: "target", error: new Error(target.reason) };
  }
  const body = buildSendRequest(
    {
      clientMsgId: input.clientMsgId ?? newClientMsgId(),
      request: {
        content: input.content,
        attachments: input.attachments,
        extraMetadata: input.extraMetadata,
      },
    },
    input.modelOverride,
  );

  if (target.kind === "shared_room") {
    try {
      const message = await deps.post(target.roomId, body);
      return { status: "sent", roomId: target.roomId, hub: null, thread: null, message };
    } catch (error) {
      return { status: "unsent", stage: "post", roomId: target.roomId, hub: null, thread: null, error };
    }
  }

  let hub: Room | null = null;
  let hubId = target.hubRoomId;
  if (!hubId) {
    try {
      hub = await deps.ensureHub(target.agentId);
      hubId = hub.id;
    } catch (error) {
      return { status: "failed", stage: "hub", error };
    }
  }

  let thread: Room;
  try {
    thread = await deps.createThread(hubId, {
      title: conversationTitle(input.titleFrom ?? input.content) || null,
    });
  } catch (error) {
    return { status: "failed", stage: "thread", error };
  }
  thread = { ...thread, parent_room_id: thread.parent_room_id ?? hubId };

  if (seatNeedsWrite(input.seat)) {
    try {
      await deps.setSeat(thread.id, target.agentId, input.seat);
    } catch (error) {
      return { status: "unsent", stage: "seat", roomId: thread.id, hub, thread, error };
    }
  }

  try {
    const message = await deps.post(thread.id, body);
    return { status: "sent", roomId: thread.id, hub, thread, message };
  } catch (error) {
    return { status: "unsent", stage: "post", roomId: thread.id, hub, thread, error };
  }
}

/** What the toast says when the sequence did not end in a sent message. */
export function conversationFailureNotice(
  result: Exclude<ConversationResult, { status: "sent" }>,
  name: string,
): { title: string; body: string } {
  const detail =
    (result.error as { detail?: unknown } | null)?.detail ??
    (result.error as Error | null)?.message ??
    "";
  const words = typeof detail === "string" && detail.trim() ? detail.trim() : "The request failed";
  const said = /[.!?]$/.test(words) ? words : `${words}.`;
  if (result.status === "failed") {
    return {
      title:
        result.stage === "thread"
          ? `Couldn't start a conversation with ${name}`
          : result.stage === "hub"
            ? `Couldn't reach ${name}`
            : "Nothing to send to",
      body: `${said} Your message is still in the box.`,
    };
  }
  return {
    title: result.stage === "seat" ? "The brain was not set — not sent" : "Not sent",
    body:
      result.stage === "seat"
        ? `${said} The conversation is open and your message is in its box; set the brain there, then send.`
        : `${said} The conversation is open and your message is in its box.`,
  };
}
