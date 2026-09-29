import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    // One row: no toolbar under the input, and Send after the calls (review 2, D8).
    expect(screen.queryByTestId("composer-toolbar")).toBeNull();
    expect(box().rows).toBe(1);
    const buttons = within(screen.getByTestId("composer-box")).getAllByRole("button");
    expect(buttons[buttons.length - 1]).toBe(screen.getByTestId("composer-send"));
    expect(buttons.indexOf(screen.getByTestId("composer-voice-call"))).toBeLessThan(buttons.length - 1);
  });

  it("leaves Enter to an IME that is composing (review 2, P2-4)", () => {
    const onSend = vi.fn();
    show({ onSend });
    type("にほんご");
    // Confirming a candidate: the keydown says it is composing.
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    // Safari reports the confirming Enter as keyCode 229 instead.
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe("にほんご");
    enter();
    expect(onSend).toHaveBeenCalledWith("にほんご", undefined, undefined, undefined);
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

  it("keeps the cursor in the box when Send is pressed (the phone's keyboard stays up)", () => {
    show({ onSend: vi.fn() });
    type("hello");
    // A default-prevented press: the box keeps the focus.
    expect(fireEvent.mouseDown(screen.getByTestId("composer-send"))).toBe(false);
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
    // Two rows at every width (review 2, D1): the input, then the toolbar —
    // who · attach · emoji … brain · calls · send.
    const toolbar = screen.getByTestId("composer-toolbar");
    expect(inBox.firstElementChild?.contains(box())).toBe(true);
    expect(toolbar.contains(box())).toBe(false);
    const order = [
      screen.getByTestId("who"),
      screen.getByLabelText("Attach file"),
      screen.getByLabelText("Insert emoji"),
      screen.getByTestId("brain"),
      screen.getByTestId("composer-video-call"),
      screen.getByTestId("composer-voice-call"),
      screen.getByTestId("composer-send"),
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Two lines to start with.
    expect(box().rows).toBe(2);
    // Send is the last control, calls or not (D8).
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons[buttons.length - 1]).toBe(screen.getByTestId("composer-send"));
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
