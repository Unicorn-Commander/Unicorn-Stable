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
import { applySeatToRoom } from "@/lib/seatSettings";

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
  /**
   * PATCH /rooms/{id} {is_archived}. Reopens a hub you archived (it takes no
   * thread while archived), and takes back a conversation nothing was
   * posted into.
   */
  setArchived: (roomId: string, archived: boolean) => Promise<unknown>;
  /** POST /rooms/{hub}/threads */
  createThread: (hubId: string, body: { title?: string | null }) => Promise<Room>;
  /** PATCH /rooms/{id} {metadata: {seats: {<agent_id>: …}}} — answers with the room. */
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
  /** The message is in the room. The thread carries the brain it was given. */
  | { status: "sent"; roomId: string; hub: Room | null; thread: Room | null; message: Message }
  /**
   * Nothing was posted: stay on Home, the draft untouched. A conversation
   * made for it was taken back (archived); `left` is one that could not be.
   */
  | {
      status: "failed";
      stage: "target" | "hub" | "thread" | "seat" | "post";
      error: unknown;
      hub: Room | null;
      left: Room | null;
    }
  /**
   * The post got no answer (a network error, a timeout, a 5xx): it may have
   * landed. Its conversation stays, and the draft goes there with its
   * client_msg_id, so sending it again cannot post it twice.
   */
  | {
      status: "unconfirmed";
      roomId: string;
      hub: Room | null;
      thread: Room | null;
      error: unknown;
      clientMsgId: string;
      body: SendRequestBody;
    };

/**
 * The server said no (4xx): the message did not land, and the same request
 * would be refused again. Anything else — no answer, a 5xx, a gateway
 * timeout — may have landed.
 */
export function postRefused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/** The thread as the server now has it: its seats, from the PATCH's answer when it gave one. */
function withSeat(thread: Room, agentId: string, seat: RoomSeat, saved: unknown): Room {
  const metadata = (saved as { metadata_?: unknown } | null)?.metadata_;
  if (metadata && typeof metadata === "object") {
    return { ...thread, metadata_: metadata as Record<string, unknown> };
  }
  return applySeatToRoom(thread, agentId, seat);
}

/**
 * Enter on Home. For your seat or a house agent: make sure of the hub
 * (reopening it if you archived it), start a thread under it titled from
 * the first line, set the thread's brain when one was picked, post. Every
 * step is awaited before the next, and a failed step stops the sequence —
 * a message is never posted into a conversation whose brain is not the one
 * that was picked.
 *
 * No empty conversation is left behind (review 2): when the brain cannot be
 * set, or the server refuses the post, the thread just made is taken back
 * and the draft stays on Home. Only a post that got no answer keeps its
 * thread — it may have landed — and the draft moves there with its id.
 */
export async function startConversation(
  deps: ConversationDeps,
  input: ConversationInput,
): Promise<ConversationResult> {
  const { target } = input;
  if (target.kind === "none") {
    return { status: "failed", stage: "target", error: new Error(target.reason), hub: null, left: null };
  }
  const clientMsgId = input.clientMsgId ?? newClientMsgId();
  const body = buildSendRequest(
    {
      clientMsgId,
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
      if (postRefused(error)) return { status: "failed", stage: "post", error, hub: null, left: null };
      return {
        status: "unconfirmed",
        roomId: target.roomId,
        hub: null,
        thread: null,
        error,
        clientMsgId,
        body,
      };
    }
  }

  let hub: Room | null = null;
  let hubId = target.hubRoomId;
  if (!hubId) {
    try {
      hub = await deps.ensureHub(target.agentId);
      // /crew names only live hubs; one you archived comes back from the
      // ensure archived, and would refuse the thread (review 2, P2-9).
      if (hub.is_archived) {
        await deps.setArchived(hub.id, false);
        hub = { ...hub, is_archived: false };
      }
      hubId = hub.id;
    } catch (error) {
      return { status: "failed", stage: "hub", error, hub: null, left: null };
    }
  }

  let thread: Room;
  try {
    thread = await deps.createThread(hubId, {
      title: conversationTitle(input.titleFrom ?? input.content) || null,
    });
  } catch (error) {
    return { status: "failed", stage: "thread", error, hub, left: null };
  }
  thread = { ...thread, parent_room_id: thread.parent_room_id ?? hubId };
  const made = thread;

  /** Take back the conversation nothing was posted into; null once it is gone. */
  const takeBack = async (): Promise<Room | null> => {
    try {
      await deps.setArchived(made.id, true);
      return null;
    } catch {
      return made;
    }
  };

  if (seatNeedsWrite(input.seat)) {
    try {
      const saved = await deps.setSeat(thread.id, target.agentId, input.seat);
      thread = withSeat(thread, target.agentId, input.seat, saved);
    } catch (error) {
      return { status: "failed", stage: "seat", error, hub, left: await takeBack() };
    }
  }

  try {
    const message = await deps.post(thread.id, body);
    return { status: "sent", roomId: thread.id, hub, thread, message };
  } catch (error) {
    if (postRefused(error)) {
      return { status: "failed", stage: "post", error, hub, left: await takeBack() };
    }
    return { status: "unconfirmed", roomId: thread.id, hub, thread, error, clientMsgId, body };
  }
}

/**
 * What the toast says when the sequence did not end in a sent message.
 * `opened`: the conversation is on screen (Home was still showing), so the
 * words point at its box rather than at the toast.
 */
export function conversationFailureNotice(
  result: Exclude<ConversationResult, { status: "sent" }>,
  name: string,
  opened = true,
): { title: string; body: string } {
  const detail =
    (result.error as { detail?: unknown } | null)?.detail ??
    (result.error as Error | null)?.message ??
    "";
  const words = typeof detail === "string" && detail.trim() ? detail.trim() : "The request failed";
  const said = /[.!?]$/.test(words) ? words : `${words}.`;
  if (result.status === "unconfirmed") {
    return {
      title: "Not confirmed",
      body: `${said} It may have gone through. Your message is in the conversation's box${
        opened ? "" : " (open it here)"
      }; sending it again will not post it twice.`,
    };
  }
  const left = result.left ? ` An empty conversation with ${name} is left in the list.` : "";
  const kept = " Your message is still in the box.";
  switch (result.stage) {
    case "target":
      return { title: "Nothing to send to", body: `${said}${kept}` };
    case "hub":
      return { title: `Couldn't reach ${name}`, body: `${said}${kept}` };
    case "thread":
      return { title: `Couldn't start a conversation with ${name}`, body: `${said}${kept}` };
    case "seat":
      return { title: "The brain was not set — nothing was sent", body: `${said}${left}${kept}` };
    case "post":
      return { title: "Not sent", body: `${said}${left}${kept}` };
  }
}
