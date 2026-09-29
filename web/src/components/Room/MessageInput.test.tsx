import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { clearDraft, getDraft, saveDraft } from "@/utils/drafts";
import { MessageInput } from "./MessageInput";

const { startCall, begin } = vi.hoisted(() => ({ startCall: vi.fn(), begin: vi.fn() }));
vi.mock("@/hooks/useStableRoom", () => ({
  useStableRoom: () => ({ isConnected: false, isConnecting: false }),
}));
vi.mock("@/hooks/useDirectCall", () => ({ useDirectCall: () => ({ startCall }) }));
vi.mock("@/lib/beginThread", () => ({ beginThread: begin }));

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

type Props = ComponentProps<typeof MessageInput>;

function show(props: Partial<Props> & Pick<Props, "onSend">) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MessageInput roomId="room-1" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const box = () => screen.getByLabelText("Message input") as HTMLTextAreaElement;

function type(text: string) {
  fireEvent.change(box(), { target: { value: text, selectionStart: text.length } });
}

function enter() {
  fireEvent.keyDown(box(), { key: "Enter" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let roster: { mockRestore: () => void };

beforeEach(() => {
  roster = vi.spyOn(api, "getBrigadeAgents").mockResolvedValue([]);
  startCall.mockReset();
  begin.mockReset();
  stored.clear();
  for (const key of ["room-1", "home:composer"]) clearDraft(key);
  useAppStore.setState({ rooms: [], participants: {} });
  useConversationUi.setState({ handedAttachments: {} });
});

afterEach(() => {
  cleanup();
  roster.mockRestore();
});

describe("a room's composer", () => {
  it("clears the box at once: the send is optimistic", () => {
    const onSend = vi.fn();
    show({ onSend });
    type("hello");
    expect(getDraft("room-1")).toBe("hello");
    enter();
    expect(onSend).toHaveBeenCalledWith("hello", undefined, undefined, undefined);
    expect(box().value).toBe("");
    expect(getDraft("room-1")).toBe("");
  });

  it("starts a thread from /thread, calls this room, and has no slots", () => {
    const onSend = vi.fn();
    show({ onSend });
    type("/thread Launch checklist");
    enter();
    expect(onSend).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1", title: "Launch checklist" }));
    fireEvent.click(screen.getByTestId("composer-voice-call"));
    expect(startCall).toHaveBeenCalledWith("room-1", { kind: "voice" });
    expect(screen.getByTestId("composer-box").className).not.toContain("flex-wrap");
  });

  it("leaves Alt+↑ in an empty box to the sidebar walk, not to editing the last message", () => {
    const onEditLast = vi.fn();
    show({ onSend: vi.fn(), onEditLast });
    fireEvent.keyDown(box(), { key: "ArrowUp", altKey: true });
    expect(onEditLast).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(onEditLast).toHaveBeenCalledTimes(1);
    // The walk knows the box by this mark.
    expect(box().dataset.composer).toBe("message");
  });

  it("takes what was handed to it with the draft", () => {
    saveDraft("room-1", "with the file");
    useConversationUi.getState().handAttachments("room-1", [
      { url: "/f/plan.pdf", filename: "plan.pdf", content_type: "application/pdf", size: 9 },
    ]);
    const onSend = vi.fn();
    show({ onSend });
    expect(box().value).toBe("with the file");
    expect(screen.getByText("plan.pdf")).toBeTruthy();
    // Taken once.
    expect(useConversationUi.getState().handedAttachments).toEqual({});
    enter();
    expect(onSend).toHaveBeenCalledWith(
      "with the file",
      undefined,
      [{ url: "/f/plan.pdf", filename: "plan.pdf", content_type: "application/pdf", size: 9 }],
      undefined,
    );
  });
});

describe("a send that is awaited", () => {
  it("holds the box while it runs and clears it when it went", async () => {
    const gate = deferred<boolean>();
    const onSend = vi.fn(() => gate.promise);
    show({ onSend, roomId: null, draftKey: "home:composer" });
    type("Plan the panel");
    enter();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(box().value).toBe("Plan the panel");
    expect(box().readOnly).toBe(true);
    expect(screen.getByTestId("composer-send").getAttribute("aria-label")).toBe("Sending");
    // A second Enter while it runs sends nothing.
    enter();
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(true);
      await gate.promise;
    });
    await waitFor(() => expect(box().value).toBe(""));
    expect(box().readOnly).toBe(false);
    expect(getDraft("home:composer")).toBe("");
  });

  it("keeps the text and its draft when it did not go", async () => {
    const gate = deferred<boolean>();
    show({ onSend: () => gate.promise, roomId: null, draftKey: "home:composer" });
    type("Plan the panel");
    enter();
    await act(async () => {
      gate.resolve(false);
      await gate.promise;
    });
    await waitFor(() => expect(box().readOnly).toBe(false));
    expect(box().value).toBe("Plan the panel");
    expect(getDraft("home:composer")).toBe("Plan the panel");
    expect(screen.getByTestId("composer-send").getAttribute("aria-disabled")).toBe("false");
  });

  it("keeps the text when the send throws", async () => {
    const gate = deferred<boolean>();
    show({ onSend: () => gate.promise, roomId: null, draftKey: "home:composer" });
    type("Plan the panel");
    enter();
    await act(async () => {
      gate.reject(new Error("offline"));
      await gate.promise.catch(() => undefined);
    });
    await waitFor(() => expect(box().readOnly).toBe(false));
    expect(box().value).toBe("Plan the panel");
  });
});

describe("a composer with no room yet", () => {
  it("keeps its draft under its own key and sends /thread as it was typed", () => {
    const onSend = vi.fn(() => false);
    show({ onSend, roomId: null, draftKey: "home:composer" });
    type("/thread Launch checklist");
    expect(getDraft("home:composer")).toBe("/thread Launch checklist");
    expect(getDraft("room-1")).toBe("");
    enter();
    expect(begin).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("/thread Launch checklist", undefined, undefined, undefined);
    // Returned false: nothing was cleared.
    expect(box().value).toBe("/thread Launch checklist");
  });

  it("does not offer /thread in the command menu", () => {
    show({ onSend: vi.fn(), roomId: null, draftKey: "home:composer" });
    type("/t");
    const menu = screen.getByRole("listbox", { name: "Slash command suggestions" });
    expect(menu.textContent).toContain("/tableflip");
    expect(menu.textContent).not.toContain("/thread");
  });

  it("draws who it is for and its brain in the box, and calls where it is told to", () => {
    const onCall = vi.fn();
    const view = show({
      onSend: vi.fn(),
      roomId: null,
      draftKey: "home:composer",
      leading: <span data-testid="who">Persephone</span>,
      trailing: <span data-testid="brain">Fable 5.1 · high</span>,
      call: { onCall },
    });
    const inBox = screen.getByTestId("composer-box");
    expect(inBox.contains(screen.getByTestId("who"))).toBe(true);
    expect(inBox.contains(screen.getByTestId("brain"))).toBe(true);
    expect(inBox.className).toContain("max-sm:flex-wrap");
    fireEvent.click(screen.getByTestId("composer-video-call"));
    expect(onCall).toHaveBeenCalledWith("video");
    expect(startCall).not.toHaveBeenCalled();
    expect(screen.queryByTestId("composer-quiet-join")).toBeNull();
    view.unmount();

    // No room and nothing to call: no call buttons at all.
    show({ onSend: vi.fn(), roomId: null, draftKey: "home:composer", call: null });
    expect(screen.queryByTestId("composer-voice-call")).toBeNull();
    expect(screen.queryByTestId("composer-video-call")).toBeNull();
  });

  it("sends nothing while it is blocked, and says why", () => {
    const onSend = vi.fn();
    show({
      onSend,
      roomId: null,
      draftKey: "home:composer",
      blockedReason: "No room shared with ShOX yet",
    });
    type("hello");
    enter();
    fireEvent.click(screen.getByTestId("composer-send"));
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe("hello");
    const send = screen.getByTestId("composer-send");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(send.getAttribute("title")).toBe("No room shared with ShOX yet");
  });

  it("takes the cursor when asked to", () => {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <input aria-label="elsewhere" />
          <MessageInput roomId={null} draftKey="home:composer" onSend={vi.fn()} focusNonce={0} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    screen.getByLabelText("elsewhere").focus();
    expect(document.activeElement).not.toBe(box());
    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <input aria-label="elsewhere" />
          <MessageInput roomId={null} draftKey="home:composer" onSend={vi.fn()} focusNonce={1} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(document.activeElement).toBe(box());
  });
});
