import { describe, expect, it, vi } from "vitest";
import type { Agent, CrewMember, Message, Room } from "@/services/api";
import { CREW_FIXTURE, PERSEPHONE_HUB_ID } from "@/mocks/crewFixture";
import {
  composerSeats,
  composerTarget,
  composerTargetLine,
  conversationFailureNotice,
  conversationTitle,
  defaultComposerSeat,
  seatNeedsWrite,
  postRefused,
  startConversation,
  titleSource,
  type ComposerTarget,
  type ConversationDeps,
} from "./homeComposer";

const SELF = ["p-aaron"];

function room(over: Partial<Room>): Room {
  return {
    id: "room",
    name: "room",
    display_name: "room",
    description: "",
    type: "channel",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    member_count: 2,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...over,
  } as Room;
}

function agent(id: string, name: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    display_name: name,
    description: "",
    avatar_url: null,
    status: "active",
    capabilities: [],
    model: "",
    ...over,
  } as Agent;
}

const crew = (ids: string[]): CrewMember[] =>
  ids.map((id) => {
    const row = CREW_FIXTURE.find((member) => member.agent_id === id);
    if (!row) throw new Error(`no fixture row ${id}`);
    return row;
  });

const persephone = crew(["persephone"])[0]!;
const flow = crew(["shafen-claude-code"])[0]!;
const majik = crew(["majik"])[0]!;

describe("who the composer addresses", () => {
  it("lists your seats that follow you, then the house, each in the server's order; never a partner's seat", () => {
    const seats = composerSeats(CREW_FIXTURE, []);
    const groups = seats.map((row) => row.group);
    expect(groups).toEqual([...groups].sort((a, b) => order(a) - order(b)));
    // Review 2, P1-1: no partner's seat, ever.
    expect(seats.some((row) => row.group === "partner")).toBe(false);
    // Only your seats whose runner announced capabilities (it follows you into new rooms).
    expect(seats.filter((row) => row.group === "own_seat").map((row) => row.agent_id)).toEqual(
      CREW_FIXTURE.filter((row) => row.group === "own_seat" && !!row.seat_capabilities).map((row) => row.agent_id),
    );
    expect(seats.map((row) => row.agent_id)).not.toContain("claude");
    // Every house agent stays: the server answers for it in any room.
    expect(seats.filter((row) => row.group === "house").map((row) => row.agent_id)).toEqual(
      CREW_FIXTURE.filter((row) => row.group === "house").map((row) => row.agent_id),
    );
  });

  it("opens on your default agent when it is one of your seats, else on your first seat", () => {
    const seats = composerSeats(CREW_FIXTURE, []);
    const own = seats.filter((row) => row.group === "own_seat");
    expect(own.length).toBeGreaterThan(1);
    expect(defaultComposerSeat(seats, own[1]!.agent_id)?.agent_id).toBe(own[1]!.agent_id);
    expect(defaultComposerSeat(seats, null)?.agent_id).toBe(own[0]!.agent_id);
    // A house agent as the default does not outrank a seat of your own.
    expect(defaultComposerSeat(seats, "majik")?.agent_id).toBe(own[0]!.agent_id);
    // Nor does a partner's seat.
    expect(defaultComposerSeat(seats, "shafen-claude-code")?.agent_id).toBe(own[0]!.agent_id);
  });

  it("without a seat of your own: your default house agent, else Sidekick", () => {
    const house = CREW_FIXTURE.filter((row) => row.group === "house");
    const seats = composerSeats(house, []);
    expect(defaultComposerSeat(seats, "majik")?.agent_id).toBe("majik");
    expect(defaultComposerSeat(seats, null)?.agent_id).toBe("sidekick");
    expect(defaultComposerSeat(seats, "gone-agent")?.agent_id).toBe("sidekick");
  });

  it("no crew at all: Sidekick from the roster, else built in", () => {
    const fromRoster = composerSeats([], [agent("majik", "Majik Mane"), agent("sidekick", "Sidekick")]);
    expect(fromRoster.map((row) => row.agent_id)).toEqual(["sidekick"]);
    expect(fromRoster[0]).toMatchObject({ group: "house", kind: "brigade", hub_room_id: null });
    const builtIn = composerSeats([], []);
    expect(builtIn.map((row) => [row.agent_id, row.display_name])).toEqual([["sidekick", "Sidekick"]]);
    expect(defaultComposerSeat(builtIn, null)?.agent_id).toBe("sidekick");
    // Not entitled to it: the roster's row is not used, the built-in one is.
    const refused = composerSeats([], [agent("sidekick", "Sidekick", { entitled: false })]);
    expect(refused[0]?.participant_id).toBe("");
    expect(defaultComposerSeat([], null)).toBeNull();
  });

  it("adds Sidekick to the house when you have house agents but no seat, and drops partners", () => {
    const seats = composerSeats([majik, flow], []);
    expect(seats.map((row) => row.agent_id)).toEqual(["majik", "sidekick"]);
    // The house already has Sidekick: nothing is added.
    const sidekick = crew(["sidekick"])[0]!;
    expect(composerSeats([sidekick, flow], []).map((row) => row.agent_id)).toEqual(["sidekick"]);
    // Your only seat does not follow you: it is not offered, Sidekick is.
    const claude = crew(["claude"])[0]!;
    expect(composerSeats([claude], []).map((row) => row.agent_id)).toEqual(["sidekick"]);
  });
});

function order(group: string): number {
  return ["own_seat", "house", "partner"].indexOf(group);
}

describe("where a message lands", () => {
  const hub = room({ id: PERSEPHONE_HUB_ID, type: "agent_hub" });
  const shared = room({
    id: "room-taxsq",
    name: "taxsq-portal",
    display_name: "taxsq-portal",
    type: "channel",
    brigade_agent_ids: ["persephone", "shafen-claude-code"],
    updated_at: "2026-09-28T10:00:00Z",
  } as Partial<Room>);
  const older = room({
    id: "room-old",
    name: "old-room",
    display_name: "old-room",
    type: "group_dm",
    brigade_agent_ids: ["shafen-claude-code"],
    updated_at: "2026-09-20T10:00:00Z",
  } as Partial<Room>);

  it("your seat: a new conversation under its hub", () => {
    expect(composerTarget(persephone, [hub], SELF)).toEqual({
      kind: "new_conversation",
      agentId: "persephone",
      name: "Persephone",
      hubRoomId: PERSEPHONE_HUB_ID,
    });
    // The hub is /crew's word even before the room list holds it.
    expect(composerTarget(persephone, [], SELF)).toMatchObject({ hubRoomId: PERSEPHONE_HUB_ID });
    expect(composerTargetLine(composerTarget(persephone, [hub], SELF))).toBeNull();
  });

  it("a house agent with no hub yet: a new conversation, the hub made on send", () => {
    const fresh = { ...majik, hub_room_id: null };
    expect(composerTarget(fresh, [hub], SELF)).toEqual({
      kind: "new_conversation",
      agentId: "majik",
      name: "Majik Mane",
      hubRoomId: null,
    });
  });

  it("a partner's seat: never a target; it is talked to in a room you share, with @name", () => {
    const target = composerTarget(flow, [older, shared, hub], SELF);
    expect(target).toEqual({ kind: "none", reason: "Talk to Flow in a room you share, with @Flow" });
    expect(composerTargetLine(target)).toBe("Talk to Flow in a room you share, with @Flow");
  });

  it("one of your seats that does not follow you: nowhere, and it says so", () => {
    const claude = crew(["claude"])[0]!;
    const target = composerTarget(claude, [hub], SELF);
    expect(target).toEqual({ kind: "none", reason: "Claude only answers in the rooms set up for it" });
  });

  it("no crew: nowhere", () => {
    expect(composerTarget(null, [hub], SELF)).toEqual({ kind: "none", reason: "No agent to message yet" });
  });
});

describe("a new conversation's title", () => {
  it("is the first 60 characters of the message, on one line", () => {
    expect(conversationTitle("  Plan the\n kitchen   panel ")).toBe("Plan the kitchen panel");
    const long = "word ".repeat(30);
    const title = conversationTitle(long);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
    expect(conversationTitle("")).toBe("");
    expect(conversationTitle(null)).toBe("");
  });

  it("is made from what was asked, not from a command's framing", () => {
    const sent = "🔬 Research request: how runners find rooms\n\nPlease run deep web research and cite your sources.";
    expect(titleSource("/research how runners find rooms", sent)).toBe("how runners find rooms");
    expect(titleSource("/council   is the cap right?", "is the cap right?")).toBe("is the cap right?");
    // Not a command: what was sent (emoji codes already drawn).
    expect(titleSource("ship it :rocket:", "ship it 🚀")).toBe("ship it 🚀");
    // A bare command, or nothing typed: what was sent.
    expect(titleSource("/shrug", "¯\\_(ツ)_/¯")).toBe("¯\\_(ツ)_/¯");
    expect(titleSource(null, "hello")).toBe("hello");
  });
});

describe("the sequence behind Enter", () => {
  const newConversation: ComposerTarget = {
    kind: "new_conversation",
    agentId: "persephone",
    name: "Persephone",
    hubRoomId: PERSEPHONE_HUB_ID,
  };
  const thread = room({ id: "thread-1", type: "agent_hub", parent_room_id: PERSEPHONE_HUB_ID });
  const message = { id: "msg-1", room_id: "thread-1", content: "hello" } as Message;

  function deps(over: Partial<ConversationDeps> = {}) {
    const calls: string[] = [];
    const made: ConversationDeps = {
      ensureHub: vi.fn(async (agentId: string) => {
        calls.push(`hub:${agentId}`);
        return room({ id: "hub-new", type: "agent_hub" });
      }),
      setArchived: vi.fn(async (roomId: string, archived: boolean) => {
        calls.push(`${archived ? "archive" : "unarchive"}:${roomId}`);
      }),
      createThread: vi.fn(async (hubId: string, body: { title?: string | null }) => {
        calls.push(`thread:${hubId}:${body.title ?? ""}`);
        return thread;
      }),
      setSeat: vi.fn(async (roomId: string, agentId: string) => {
        calls.push(`seat:${roomId}:${agentId}`);
        return undefined;
      }),
      post: vi.fn(async (roomId: string) => {
        calls.push(`post:${roomId}`);
        return message;
      }),
      ...over,
    };
    return { made, calls };
  }

  it("known hub: thread, then the message — no hub request, no seat write", async () => {
    const { made, calls } = deps();
    const result = await startConversation(made, { target: newConversation, content: "Plan the kitchen panel", clientMsgId: "cid-1" });
    expect(calls).toEqual([`thread:${PERSEPHONE_HUB_ID}:Plan the kitchen panel`, "post:thread-1"]);
    expect(result).toMatchObject({ status: "sent", roomId: "thread-1", hub: null });
    expect(made.post).toHaveBeenCalledWith("thread-1", {
      content: "Plan the kitchen panel",
      content_type: "text",
      client_msg_id: "cid-1",
    });
  });

  it("titles the thread from what it is told to", async () => {
    const { made, calls } = deps();
    await startConversation(made, {
      target: newConversation,
      content: "🔬 Research request: x\n\nPlease run deep web research and cite your sources.",
      titleFrom: "x",
    });
    expect(calls[0]).toBe(`thread:${PERSEPHONE_HUB_ID}:x`);
  });

  it("no hub yet: the hub is made first", async () => {
    const { made, calls } = deps();
    const result = await startConversation(made, {
      target: { ...newConversation, agentId: "majik", name: "Majik Mane", hubRoomId: null },
      content: "hi",
    });
    expect(calls).toEqual(["hub:majik", "thread:hub-new:hi", "post:thread-1"]);
    expect(result).toMatchObject({ status: "sent", hub: { id: "hub-new" } });
  });

  it("a picked brain is written to the thread before the message is posted", async () => {
    const { made, calls } = deps();
    const result = await startConversation(made, {
      target: newConversation,
      content: "hi",
      seat: { model: "claude-opus-5-5", effort: null },
    });
    expect(calls).toEqual([`thread:${PERSEPHONE_HUB_ID}:hi`, "seat:thread-1:persephone", "post:thread-1"]);
    // The thread comes back carrying the brain it was given (review 2, P2-2):
    // the room's chip must not show the default once Home is gone.
    expect(result.status === "sent" && result.thread?.metadata_).toEqual({
      seats: { persephone: { model: "claude-opus-5-5", effort: null } },
    });
    expect(made.setSeat).toHaveBeenCalledWith("thread-1", "persephone", { model: "claude-opus-5-5", effort: null });
    // The seat's own settings need no write.
    expect(seatNeedsWrite({ model: null, effort: null })).toBe(false);
    expect(seatNeedsWrite(null)).toBe(false);
    expect(seatNeedsWrite({ model: null, effort: "max" })).toBe(true);
  });

  it("takes the thread's seats from the server's answer when it gives one", async () => {
    const saved = { seats: { persephone: { model: "claude-opus-5-5", effort: "max" } }, class_floor: "private" };
    const { made } = deps({ setSeat: vi.fn(async () => ({ id: "thread-1", metadata_: saved })) });
    const result = await startConversation(made, {
      target: newConversation,
      content: "hi",
      seat: { model: "claude-opus-5-5", effort: "max" },
    });
    expect(result.status === "sent" && result.thread?.metadata_).toEqual(saved);
  });

  it("reopens a hub you archived before asking it for a thread (review 2, P2-9)", async () => {
    const { made, calls } = deps({
      ensureHub: vi.fn(async (agentId: string) => {
        calls.push(`hub:${agentId}`);
        return room({ id: "hub-old", type: "agent_hub", is_archived: true });
      }),
    });
    const result = await startConversation(made, {
      target: { ...newConversation, agentId: "majik", name: "Majik Mane", hubRoomId: null },
      content: "hi",
    });
    expect(calls).toEqual(["hub:majik", "unarchive:hub-old", "thread:hub-old:hi", "post:thread-1"]);
    expect(result).toMatchObject({ status: "sent", hub: { id: "hub-old", is_archived: false } });
  });

  it("attachments and a command's metadata ride in the post, the model beside them", async () => {
    const { made } = deps();
    const file = { url: "/f/a.png", filename: "a.png", content_type: "image/png", size: 3 };
    await startConversation(made, {
      target: newConversation,
      content: "look",
      attachments: [file],
      extraMetadata: { council: true },
      modelOverride: "qwen3.6",
      clientMsgId: "cid-2",
    });
    expect(made.post).toHaveBeenCalledWith("thread-1", {
      content: "look",
      content_type: "image",
      client_msg_id: "cid-2",
      metadata: { attachments: [file], council: true },
      model: "qwen3.6",
    });
  });

  it("the hub cannot be made: nothing else is asked, and Home keeps the draft", async () => {
    const { made, calls } = deps({ ensureHub: vi.fn(async () => Promise.reject(new Error("403"))) });
    const result = await startConversation(made, {
      target: { ...newConversation, hubRoomId: null },
      content: "hi",
    });
    expect(result).toMatchObject({ status: "failed", stage: "hub" });
    expect(calls).toEqual([]);
    expect(made.post).not.toHaveBeenCalled();
  });

  it("the thread cannot be made: nothing is posted, and Home keeps the draft", async () => {
    const { made } = deps({ createThread: vi.fn(async () => Promise.reject(new Error("archived"))) });
    const result = await startConversation(made, { target: newConversation, content: "hi" });
    expect(result).toMatchObject({ status: "failed", stage: "thread" });
    expect(made.setSeat).not.toHaveBeenCalled();
    expect(made.post).not.toHaveBeenCalled();
  });

  it("the brain cannot be set: nothing is posted, and the empty conversation is taken back", async () => {
    const { made, calls } = deps({
      setSeat: vi.fn(async () => Promise.reject({ status: 403, detail: "ask the seat's owner" })),
    });
    const result = await startConversation(made, {
      target: newConversation,
      content: "hi",
      seat: { model: null, effort: "max" },
    });
    expect(calls).toEqual([`thread:${PERSEPHONE_HUB_ID}:hi`, "archive:thread-1"]);
    expect(result).toMatchObject({ status: "failed", stage: "seat", left: null });
    expect(made.post).not.toHaveBeenCalled();
    expect(conversationFailureNotice(result as never, "Persephone")).toEqual({
      title: "The brain was not set — nothing was sent",
      body: "ask the seat's owner. Your message is still in the box.",
    });
  });

  it("the server refuses the post: the empty conversation is taken back, the draft stays on Home", async () => {
    const { made, calls } = deps({
      post: vi.fn(async () => Promise.reject({ status: 403, detail: "You can't post here" })),
    });
    const result = await startConversation(made, { target: newConversation, content: "hi" });
    expect(calls).toEqual([`thread:${PERSEPHONE_HUB_ID}:hi`, "archive:thread-1"]);
    expect(result).toMatchObject({ status: "failed", stage: "post", left: null });
    expect(conversationFailureNotice(result as never, "Persephone")).toEqual({
      title: "Not sent",
      body: "You can't post here. Your message is still in the box.",
    });
  });

  it("a conversation that cannot be taken back is named, not hidden", async () => {
    const { made } = deps({
      post: vi.fn(async () => Promise.reject({ status: 422, detail: "Too long" })),
      setArchived: vi.fn(async () => Promise.reject({ status: 500 })),
    });
    const result = await startConversation(made, { target: newConversation, content: "hi" });
    expect(result).toMatchObject({ status: "failed", stage: "post", left: { id: "thread-1" } });
    expect(conversationFailureNotice(result as never, "Persephone").body).toBe(
      "Too long. An empty conversation with Persephone is left in the list. Your message is still in the box.",
    );
  });

  it("the post gets no answer: it may have landed, so the conversation stays and the draft goes there with its id", async () => {
    for (const error of [
      { status: 0, message: "Request timed out", detail: "The server did not respond in time." },
      { status: 503, detail: "The room is not taking messages" },
      new TypeError("Failed to fetch"),
    ]) {
      const { made, calls } = deps({ post: vi.fn(async () => Promise.reject(error)) });
      const result = await startConversation(made, { target: newConversation, content: "hi", clientMsgId: "cid-7" });
      // No take-back: the message may be in there.
      expect(calls).toEqual([`thread:${PERSEPHONE_HUB_ID}:hi`]);
      expect(made.setArchived).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "unconfirmed",
        roomId: "thread-1",
        clientMsgId: "cid-7",
        thread: { id: "thread-1", parent_room_id: PERSEPHONE_HUB_ID },
        body: { content: "hi", client_msg_id: "cid-7" },
      });
    }
    expect(postRefused({ status: 404 })).toBe(true);
    expect(postRefused({ status: 500 })).toBe(false);
    expect(postRefused({ status: 0 })).toBe(false);
    expect(postRefused(new Error("x"))).toBe(false);
  });

  it("says where an unconfirmed message went, open or not", async () => {
    const { made } = deps({ post: vi.fn(async () => Promise.reject({ status: 0, detail: "The server did not respond in time." })) });
    const result = await startConversation(made, { target: newConversation, content: "hi" });
    expect(conversationFailureNotice(result as never, "Persephone")).toEqual({
      title: "Not confirmed",
      body: "The server did not respond in time. It may have gone through. Your message is in the conversation's box; sending it again will not post it twice.",
    });
    expect(conversationFailureNotice(result as never, "Persephone", false).body).toContain("(open it here)");
  });

  it("a partner's seat: one post into the shared room, nothing created", async () => {
    const { made, calls } = deps();
    const target: ComposerTarget = {
      kind: "shared_room",
      agentId: "shafen-claude-code",
      name: "Flow",
      roomId: "room-taxsq",
      roomLabel: "#taxsq-portal",
    };
    const sent = await startConversation(made, { target, content: "hi", seat: { model: "x", effort: null } });
    expect(calls).toEqual(["post:room-taxsq"]);
    expect(sent).toMatchObject({ status: "sent", roomId: "room-taxsq", thread: null });
    const failing = deps({ post: vi.fn(async () => Promise.reject(new Error("offline"))) });
    expect(await startConversation(failing.made, { target, content: "hi" })).toMatchObject({
      status: "unconfirmed",
      roomId: "room-taxsq",
    });
  });

  it("nowhere to send: nothing is asked of the server", async () => {
    const { made, calls } = deps();
    const result = await startConversation(made, {
      target: { kind: "none", reason: "No room shared with Flow yet" },
      content: "hi",
    });
    expect(result).toMatchObject({ status: "failed", stage: "target" });
    expect(calls).toEqual([]);
    expect(conversationFailureNotice(result as never, "Flow")).toEqual({
      title: "Nothing to send to",
      body: "No room shared with Flow yet. Your message is still in the box.",
    });
  });
});
