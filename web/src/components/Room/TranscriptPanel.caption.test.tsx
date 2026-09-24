/**
 * The caption chip has to say why the panel is empty, and it has to show an
 * agent captioner's lines when the browser lane is standing down.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { captionFacts, reduceCaptionState } from "@/lib/captionState";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import type { Message } from "@/services/api";
import { TranscriptPanel } from "./TranscriptPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useCallUiStore.getState().clearTranscript();
  useCallUiStore.setState({
    activeCallRoomId: null,
    callStartedAt: null,
    caption: reduceCaptionState(captionFacts({ inCall: false })),
    serverCaptionEnabled: false,
  });
  useAppStore.setState({ messages: {}, currentUser: null });
});

describe("TranscriptPanel caption state", () => {
  it("a selected non-default mic is mic-pinned, not a dead panel", () => {
    const caption = reduceCaptionState(
      captionFacts({
        audioInputId: "zoom-ams-44",
        audioInputLabel: "ZOOM AMS-44",
      }),
    );
    expect(caption.lane).toBe("off");
    expect(caption.reason).toBe("mic-pinned");
    useCallUiStore.setState({
      activeCallRoomId: "room-1",
      callStartedAt: Date.now(),
      caption,
      transcript: [],
    });
    const view = render(<TranscriptPanel />);
    expect(view.querySelector('[data-testid="caption-state-chip"]')?.textContent).toContain(
      "off",
    );
    expect(view.textContent).toContain(
      "Captions need the default mic or an agent in the call — you picked ZOOM AMS-44",
    );
    expect(view.querySelector('[data-testid="caption-use-default-mic"]')).toBeTruthy();
    expect(view.querySelector('[data-testid="caption-invite-agent"]')).toBeTruthy();
    expect(view.textContent).not.toContain("Human speech is captioned live");
  });

  it("an agent captioner yields state=agent and renders the persisted voice line", () => {
    const started = Date.parse("2026-09-23T18:00:00Z");
    const caption = reduceCaptionState(
      captionFacts({
        audioInputId: "zoom-ams-44",
        audioInputLabel: "ZOOM AMS-44",
        agentName: "Persephone",
      }),
    );
    expect(caption.lane).toBe("agent");
    useCallUiStore.setState({
      activeCallRoomId: "room-1",
      callStartedAt: started,
      caption,
      transcript: [],
    });
    const message: Message = {
      id: "m-voice-1",
      room_id: "room-1",
      sender_id: "p-aaron",
      sender_type: "human",
      sender_name: "Aaron",
      sender_avatar: null,
      content: "the studio mic is live",
      content_type: "text",
      thread_id: null,
      reply_count: 0,
      edited: false,
      created_at: new Date(started + 1000).toISOString(),
      updated_at: new Date(started + 1000).toISOString(),
      metadata: { via: "voice" },
    };
    useAppStore.setState({
      messages: {
        "room-1": {
          items: [message],
          nextCursor: null,
          hasMore: false,
          loading: false,
        },
      },
    });
    const view = render(<TranscriptPanel />);
    expect(view.querySelector('[data-testid="caption-state-chip"]')?.textContent).toContain(
      "agent",
    );
    expect(view.textContent).toContain("Captions are coming from Persephone's mic feed");
    expect(view.textContent).toContain("the studio mic is live");
    expect(view.textContent).toContain("Aaron");
  });
});
