import clsx from "clsx";
import { MessageSquare } from "lucide-react";
import { useCallUiStore } from "@/stores/callUiStore";
import { useRoomPanels } from "@/hooks/useRoomPanels";
import { chatIsVisible, toggleCallChat } from "@/lib/callLayoutActions";
import { useIsDesktop } from "@/hooks/usePanelResize";

/**
 * Call-bar chat toggle. Pressed = chat is on screen. Hidden = the stage is
 * the full width (desktop split collapses; phone Video drops the sheet).
 */
export function ChatToggleButton({
  roomId,
  size = "md",
}: {
  roomId: string;
  size?: "md" | "lg";
}) {
  const panels = useRoomPanels(roomId);
  const mobileCallMode = useCallUiStore((s) => s.mobileCallMode);
  const desktop = useIsDesktop();
  const shown = chatIsVisible({
    mode: panels.chat.mode,
    desktop,
    mobileCallMode,
  });
  const dim = size === "lg" ? "h-11 w-11" : "h-10 w-10";

  return (
    <button
      type="button"
      onClick={() => toggleCallChat(roomId)}
      data-chat-visible={shown ? "true" : "false"}
      className={clsx(
        "focus-ring relative flex items-center justify-center rounded-xl border transition-colors active:scale-[0.98]",
        dim,
        shown
          ? "border-stable-cyan/50 bg-stable-cyan/15 text-stable-cyan"
          : "border-transparent bg-stable-purple/20 text-stable-purple-light",
      )}
      aria-pressed={shown}
      aria-keyshortcuts="c"
      aria-label={shown ? "Hide chat" : "Show chat"}
      title={
        shown
          ? "Chat is open — hide it (C). The stage takes the full width."
          : "Chat is hidden — the stage is full width. Show chat (C)."
      }
    >
      <MessageSquare className="h-5 w-5" />
      <span
        className={clsx(
          "absolute right-1 top-1 h-1.5 w-1.5 rounded-full",
          shown ? "bg-stable-cyan" : "bg-stable-purple-light/80",
        )}
        aria-hidden
      />
    </button>
  );
}
