import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Message } from "@/services/api";
import { sendFingerprint } from "@/lib/sendPipeline";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { useChat } from "./useChat";

vi.mock("@/services/websocket", () => ({ ws: { on: () => () => {} } }));

const ROOM = "thread-1";

let hook: ReturnType<typeof useChat> | null = null;
function Probe() {
  hook = useChat(ROOM);
  return null;
}

const spies: Array<{ mockRestore: () => void }> = [];
function spy<T extends { mockRestore: () => void }>(made: T): T {
  spies.push(made);
  return made;
}

function answer(id: string): Message {
  return {
    id,
    room_id: ROOM,
    sender_id: "p-aaron",
    sender_type: "human",
    sender_name: "Aaron",
    sender_avatar: null,
    content: "x",
    content_type: "text",
    thread_id: null,
    reply_count: 0,
    edited: false,
    created_at: "2026-09-29T12:00:00Z",
    updated_at: "2026-09-29T12:00:00Z",
    metadata: {},
  } as Message;
}

beforeEach(() => {
  hook = null;
  useAppStore.setState({ messages: {}, rooms: [], toasts: [] });
  useConversationUi.setState({ handedSends: {} });
  spy(vi.spyOn(api, "getMessages")).mockResolvedValue({ items: [], next_cursor: null, has_more: false });
});

afterEach(() => {
  cleanup();
  for (const item of spies.splice(0)) item.mockRestore();
});

describe("a send handed over from Home (review 2, P2-6)", () => {
  it("keeps its id when the same message is sent again, so the server answers with the original", async () => {
    const post = spy(vi.spyOn(api, "sendMessage")).mockResolvedValue(answer("msg-original"));
    useConversationUi.getState().handSend(ROOM, {
      clientMsgId: "cid-from-home",
      fingerprint: sendFingerprint("is the cap right?", undefined, { council: true }),
    });
    render(<Probe />);
    await act(async () => {
      await hook!.sendMessage("is the cap right?", undefined, undefined, { council: true });
    });
    expect((post.mock.calls[0]![1] as { client_msg_id: string }).client_msg_id).toBe("cid-from-home");
    // Taken once.
    expect(useConversationUi.getState().handedSends).toEqual({});
  });

  it("gives an edited message a new id: the old one would be answered with the original", async () => {
    const post = spy(vi.spyOn(api, "sendMessage")).mockResolvedValue(answer("msg-new"));
    useConversationUi.getState().handSend(ROOM, {
      clientMsgId: "cid-from-home",
      fingerprint: sendFingerprint("is the cap right?"),
    });
    render(<Probe />);
    await act(async () => {
      await hook!.sendMessage("is the cap right, really?");
    });
    expect((post.mock.calls[0]![1] as { client_msg_id: string }).client_msg_id).not.toBe("cid-from-home");
    expect(useConversationUi.getState().handedSends).toEqual({});
  });
});
