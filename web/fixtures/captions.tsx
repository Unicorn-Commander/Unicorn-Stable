import { createRoot } from "react-dom/client";
import { TranscriptPanel } from "../src/components/Room/TranscriptPanel";
import { captionFacts, reduceCaptionState } from "../src/lib/captionState";
import { useAppStore } from "../src/stores/appStore";
import { useCallUiStore } from "../src/stores/callUiStore";
import type { Message } from "../src/services/api";
import "../src/styles/globals.css";

const lane = new URLSearchParams(location.search).get("lane");
const started = Date.parse("2026-09-23T18:00:00Z");

if (lane === "agent") {
  useCallUiStore.setState({
    activeCallRoomId: "room-general",
    callStartedAt: started,
    showTranscript: true,
    transcript: [],
    caption: reduceCaptionState(
      captionFacts({
        audioInputId: "zoom-ams-44",
        audioInputLabel: "ZOOM AMS-44",
        agentName: "Persephone",
      }),
    ),
  });
  const message: Message = {
    id: "m-voice-1",
    room_id: "room-general",
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
      "room-general": {
        items: [message],
        nextCursor: null,
        hasMore: false,
        loading: false,
      },
    },
  });
} else {
  useCallUiStore.setState({
    activeCallRoomId: "room-general",
    callStartedAt: started,
    showTranscript: true,
    transcript: [],
    caption: reduceCaptionState(
      captionFacts({
        audioInputId: "zoom-ams-44",
        audioInputLabel: "ZOOM AMS-44",
      }),
    ),
  });
}

createRoot(document.getElementById("root")!).render(
  <main style={{ height: "100dvh", background: "#0b1020" }}>
    <TranscriptPanel />
  </main>,
);
