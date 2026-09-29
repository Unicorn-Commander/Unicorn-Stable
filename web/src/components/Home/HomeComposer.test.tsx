import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { api, type Message, type Room } from "@/services/api";
import { crewQueryKey } from "@/hooks/useCrew";
import { CREW_FIXTURE, PERSEPHONE_HUB_ID } from "@/mocks/crewFixture";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { getDraft } from "@/utils/drafts";
import { sendFingerprint } from "@/lib/sendPipeline";
import { HOME_DRAFT_KEY, HomeComposer } from "./HomeComposer";

vi.mock("@/hooks/useStableRoom", () => ({
  useStableRoom: () => ({ isConnected: false, isConnecting: false }),
}));
vi.mock("@/hooks/useDirectCall", () => ({ useDirectCall: () => ({ startCall: vi.fn() }) }));

// Drafts live in localStorage, which this test environment does not have.
const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, String(value)),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
    key: (index: number) => [...stored.keys()][index] ?? null,
    get length() {
      return stored.size;
    },
  },
});

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

const HUB = room({ id: PERSEPHONE_HUB_ID, name: "Persephone", display_name: "Persephone", type: "agent_hub" });
const SHARED = room({
  id: "room-taxsq",
  name: "taxsq-portal",
  display_name: "taxsq-portal",
  brigade_agent_ids: ["persephone", "shafen-claude-code"],
} as Partial<Room>);
const THREAD = room({
  id: "thread-1",
  name: "thread-1",
  display_name: "Plan the panel",
  type: "agent_hub",
  parent_room_id: PERSEPHONE_HUB_ID,
});
const MESSAGE = {
  id: "msg-1",
  room_id: "thread-1",
  sender_id: "p-aaron",
  sender_type: "human",
  sender_name: "Aaron",
  sender_avatar: null,
  content: "Plan the panel",
  content_type: "text",
  thread_id: null,
  reply_count: 0,
  edited: false,
  created_at: "2026-09-29T12:00:00Z",
  updated_at: "2026-09-29T12:00:00Z",
  metadata: {},
} as Message;

function Where() {
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="where">{useLocation().pathname}</p>
      <button type="button" data-testid="go-elsewhere" onClick={() => navigate("/c/room-elsewhere")}>
        elsewhere
      </button>
    </>
  );
}

function show() {
  const scope = useFederationStore.getState().activeInstanceId;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(crewQueryKey(scope), CREW_FIXTURE);
  client.setQueryData(["my-preferences", scope], {
    default_agent_id: null,
    favorite_people_ids: [],
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <HomeComposer />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const box = () => screen.getByLabelText("Message input") as HTMLTextAreaElement;

async function send(text: string) {
  fireEvent.change(box(), { target: { value: text, selectionStart: text.length } });
  await act(async () => {
    fireEvent.keyDown(box(), { key: "Enter" });
  });
}

const spies: Array<{ mockRestore: () => void }> = [];
function spy<T extends { mockRestore: () => void }>(made: T): T {
  spies.push(made);
  return made;
}

beforeEach(() => {
  stored.clear();
  useAppStore.setState({
    rooms: [HUB, SHARED],
    agents: [],
    messages: {},
    participants: {},
    toasts: [],
    unreadCounts: {},
  });
  useConversationUi.setState({ handedAttachments: {}, handedSends: {} });
  spy(vi.spyOn(api, "getCrew")).mockResolvedValue(CREW_FIXTURE);
  spy(vi.spyOn(api, "getMyPreferences")).mockResolvedValue({
    default_agent_id: null,
    favorite_people_ids: [],
  });
  spy(vi.spyOn(api, "getBrigadeAgents")).mockResolvedValue([]);
  spy(vi.spyOn(api, "setOnboardingChecklist")).mockResolvedValue({
    default_agent_id: null,
    favorite_people_ids: [],
    onboarding_checklist: { agent: true },
  });
});

afterEach(() => {
  cleanup();
  for (const item of spies.splice(0)) item.mockRestore();
});

describe("Home's composer", () => {
  it("addresses your first seat and says so", () => {
    show();
    expect(box().getAttribute("placeholder")).toBe("Message Persephone…");
    expect(screen.getByTestId("seat-picker")).toHaveTextContent("Persephone");
    expect(screen.getByTestId("seat-chip")).toHaveTextContent("Fable 5.1 · high");
    expect(screen.getByTestId("home-composer").getAttribute("data-target")).toBe("new_conversation");
    expect(screen.queryByTestId("home-composer-line")).toBeNull();
    // A seat takes no calls until voice ships.
    expect(screen.queryByTestId("composer-voice-call")).toBeNull();
  });

  it("sent: the thread is in the list under its hub, the message in it, and you are there", async () => {
    const thread = spy(vi.spyOn(api, "createThread")).mockResolvedValue(THREAD);
    const post = spy(vi.spyOn(api, "sendMessage")).mockResolvedValue(MESSAGE);
    const hub = spy(vi.spyOn(api, "ensureAgentHub"));
    show();
    await send("Plan the panel");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/c/thread-1"));
    expect(hub).not.toHaveBeenCalled();
    expect(thread).toHaveBeenCalledWith(PERSEPHONE_HUB_ID, { title: "Plan the panel" });
    expect(post.mock.calls[0]![0]).toBe("thread-1");
    expect(post.mock.calls[0]![1]).toMatchObject({ content: "Plan the panel", content_type: "text" });
    const state = useAppStore.getState();
    expect(state.rooms.find((r) => r.id === "thread-1")?.parent_room_id).toBe(PERSEPHONE_HUB_ID);
    expect(state.rooms.find((r) => r.id === PERSEPHONE_HUB_ID)?.thread_count).toBe(1);
    expect(state.messages["thread-1"]?.items.map((m) => m.id)).toEqual(["msg-1"]);
    expect(getDraft(HOME_DRAFT_KEY)).toBe("");
    expect(state.toasts).toEqual([]);
    // The first conversation with an agent ticks the checklist's step.
    expect(api.setOnboardingChecklist).toHaveBeenCalledWith({ agent: true });
  });

  it("titles a conversation from what was asked, not from a command's framing", async () => {
    const thread = spy(vi.spyOn(api, "createThread")).mockResolvedValue(THREAD);
    const post = spy(vi.spyOn(api, "sendMessage")).mockResolvedValue(MESSAGE);
    show();
    await send("/research how do runners find rooms");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/c/thread-1"));
    expect(thread).toHaveBeenCalledWith(PERSEPHONE_HUB_ID, { title: "how do runners find rooms" });
    expect(post.mock.calls[0]![1]).toMatchObject({
      content: expect.stringContaining("Research request: how do runners find rooms"),
      metadata: { research: { mode: "deep" } },
    });
  });

  it("the post gets no answer: on the thread, with the draft, the files and the send's id", async () => {
    spy(vi.spyOn(api, "createThread")).mockResolvedValue(THREAD);
    const post = spy(vi.spyOn(api, "sendMessage")).mockRejectedValue({
      status: 503,
      detail: "The room is not taking messages",
    });
    const archive = spy(vi.spyOn(api, "updateRoom"));
    show();
    await send("/council is the cap right?");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/c/thread-1"));
    // It may have landed: nothing is taken back.
    expect(archive).not.toHaveBeenCalled();
    // As typed: the command is still a command.
    expect(getDraft("thread-1")).toBe("/council is the cap right?");
    expect(getDraft(HOME_DRAFT_KEY)).toBe("");
    const state = useAppStore.getState();
    expect(state.rooms.some((r) => r.id === "thread-1")).toBe(true);
    expect(state.messages["thread-1"]).toBeUndefined();
    expect(state.toasts[0]).toMatchObject({
      title: "Not confirmed",
      body: "The room is not taking messages. It may have gone through. Your message is in the conversation's box; sending it again will not post it twice.",
      kind: "error",
    });
    // The room's send of the same message reuses the id (the server dedupes on it).
    const sentId = (post.mock.calls[0]![1] as { client_msg_id: string }).client_msg_id;
    const fingerprint = sendFingerprint("is the cap right?", undefined, { council: true });
    expect(useConversationUi.getState().takeHandedSend("thread-1", fingerprint)).toBe(sentId);
  });

  it("the server refuses the post: still on Home with what you typed, and no empty conversation", async () => {
    spy(vi.spyOn(api, "createThread")).mockResolvedValue(THREAD);
    spy(vi.spyOn(api, "sendMessage")).mockRejectedValue({ status: 403, detail: "You can't post here" });
    const archive = spy(vi.spyOn(api, "updateRoom")).mockResolvedValue({ ...THREAD, is_archived: true });
    show();
    await send("Status?");
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(archive).toHaveBeenCalledWith("thread-1", { is_archived: true });
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(box().value).toBe("Status?");
    expect(getDraft(HOME_DRAFT_KEY)).toBe("Status?");
    // The taken-back conversation is not put in the list.
    expect(useAppStore.getState().rooms.some((r) => r.id === "thread-1")).toBe(false);
    expect(useAppStore.getState().toasts[0]).toMatchObject({
      title: "Not sent",
      body: "You can't post here. Your message is still in the box.",
    });
  });

  it("a send that outlives Home does not pull you out of where you went", async () => {
    let finish: (room: typeof THREAD) => void = () => {};
    spy(vi.spyOn(api, "createThread")).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    spy(vi.spyOn(api, "sendMessage")).mockResolvedValue(MESSAGE);
    show();
    fireEvent.change(box(), { target: { value: "Plan the panel", selectionStart: 14 } });
    fireEvent.keyDown(box(), { key: "Enter" });
    // Elsewhere before the conversation exists.
    fireEvent.click(screen.getByTestId("go-elsewhere"));
    expect(screen.getByTestId("where").textContent).toBe("/c/room-elsewhere");
    await act(async () => finish(THREAD));
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(screen.getByTestId("where").textContent).toBe("/c/room-elsewhere");
    // It went, and the toast opens it.
    expect(useAppStore.getState().messages["thread-1"]?.items.map((m) => m.id)).toEqual(["msg-1"]);
    expect(useAppStore.getState().toasts[0]).toMatchObject({
      title: "Sent to Persephone",
      roomId: "thread-1",
      kind: "success",
    });
  });

  it("the new conversation carries the brain you picked into the list", async () => {
    spy(vi.spyOn(api, "createThread")).mockResolvedValue(THREAD);
    spy(vi.spyOn(api, "sendMessage")).mockResolvedValue(MESSAGE);
    const seats = { persephone: { model: "claude-opus-5-5", effort: "max" } };
    const patch = spy(vi.spyOn(api, "updateRoom")).mockResolvedValue({ ...THREAD, metadata_: { seats } });
    show();
    fireEvent.click(screen.getByTestId("seat-chip"));
    fireEvent.click(screen.getByTestId("seat-model-claude-opus-5-5"));
    fireEvent.click(screen.getByTestId("seat-effort-max"));
    await send("Draft the outline");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/c/thread-1"));
    expect(patch).toHaveBeenCalledWith("thread-1", { metadata: { seats } });
    // Review 2, P2-2: the room reads its chip from the list's copy.
    expect(useAppStore.getState().rooms.find((r) => r.id === "thread-1")?.metadata_).toEqual({ seats });
  });

  it("the thread cannot be made: you are still on Home with what you typed", async () => {
    spy(vi.spyOn(api, "createThread")).mockRejectedValue({ status: 403, detail: "This room is archived" });
    const post = spy(vi.spyOn(api, "sendMessage"));
    show();
    await send("Are the GPU lanes clear?");
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(post).not.toHaveBeenCalled();
    expect(box().value).toBe("Are the GPU lanes clear?");
    expect(getDraft(HOME_DRAFT_KEY)).toBe("Are the GPU lanes clear?");
    expect(useAppStore.getState().toasts[0]?.title).toBe("Couldn't start a conversation with Persephone");
  });

  it("never offers a partner's seat: a line without @name in a shared room is read by all and answered by none", async () => {
    const post = spy(vi.spyOn(api, "sendMessage"));
    show();
    fireEvent.click(screen.getByTestId("seat-picker"));
    // Review 2, P1-1: Flow and ShOX are partners' seats in the fixture.
    expect(screen.queryByTestId("seat-option-shafen-claude-code")).toBeNull();
    expect(screen.queryByTestId("seat-option-shox")).toBeNull();
    expect(screen.queryByTestId("seat-option-okapi-grok")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("never offers one of your seats whose runner does not follow you into new rooms", async () => {
    const hub = spy(vi.spyOn(api, "ensureAgentHub"));
    show();
    fireEvent.click(screen.getByTestId("seat-picker"));
    // "claude" is your seat with no announced capabilities: a hub made for it would be silent.
    expect(screen.queryByTestId("seat-option-claude")).toBeNull();
    // Seats that announced are offered.
    expect(screen.getByTestId("seat-option-persephone")).toBeTruthy();
    expect(screen.getByTestId("seat-option-grok")).toBeTruthy();
    expect(hub).not.toHaveBeenCalled();
  });

  it("a house agent: no brain chip, a hub made on the first message, a call offered", async () => {
    const hub = spy(vi.spyOn(api, "ensureAgentHub")).mockResolvedValue(
      room({ id: "hub-general", type: "agent_hub", name: "The General", display_name: "The General" }),
    );
    spy(vi.spyOn(api, "createThread")).mockResolvedValue({ ...THREAD, id: "thread-9", parent_room_id: "hub-general" });
    spy(vi.spyOn(api, "sendMessage")).mockResolvedValue({ ...MESSAGE, room_id: "thread-9" });
    show();
    fireEvent.click(screen.getByTestId("seat-picker"));
    // A house agent the fixture gives no hub to.
    const general = CREW_FIXTURE.find((row) => row.group === "house" && !row.hub_room_id)!;
    fireEvent.click(screen.getByTestId(`seat-option-${general.agent_id}`));
    expect(screen.queryByTestId("seat-chip")).toBeNull();
    expect(screen.getByTestId("composer-voice-call")).toBeTruthy();
    await send("Status?");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/c/thread-9"));
    expect(hub).toHaveBeenCalledWith(general.agent_id);
    expect(useAppStore.getState().rooms.some((r) => r.id === "hub-general")).toBe(true);
  });
});
