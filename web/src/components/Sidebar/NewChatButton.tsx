import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { SquarePen, ChevronDown, Star, Bot } from "lucide-react";
import clsx from "clsx";
import { api, type Agent } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { resolveDefaultAgent } from "./newChat";

/**
 * The ChatGPT-style "New chat" control as a split button: the primary half
 * starts a fresh conversation with the user's default agent; the caret opens a
 * picker to start a one-off chat with ANY agent and to set a new default
 * (server-side, so it follows the account). The label stays generic ("New
 * chat") — the agent is a preference, not part of the button text.
 */
export function NewChatButton({
  onStarted,
}: {
  onStarted?: (roomId: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agents = useAppStore((s) => s.agents);
  const defaultAgentId = useAppStore((s) => s.defaultAgentId);
  const setDefaultAgentId = useAppStore((s) => s.setDefaultAgentId);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const def = resolveDefaultAgent(agents, defaultAgentId);
  const agentLabel = (a: Agent) => a.display_name || a.name;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function startChatWith(agentId: string, name: string) {
    if (starting) return;
    setStarting(true);
    setOpen(false);
    try {
      const room = await api.createAgentDm(agentId, `Chat with ${name}`);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      if (onStarted) onStarted(room.id);
      else navigate(`/c/${room.id}`);
    } catch (err) {
      alert("Couldn't start a new chat — " + (err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function makeDefault(agentId: string) {
    const prev = defaultAgentId;
    setDefaultAgentId(agentId); // optimistic
    try {
      await api.setDefaultAgent(agentId);
    } catch {
      setDefaultAgentId(prev); // revert on failure
    }
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex w-full overflow-hidden rounded-lg shadow-sm">
        <button
          onClick={() => startChatWith(def.id, def.name)}
          disabled={starting}
          className="gradient-bg flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Start a new chat with ${def.name}`}
          title={`New chat with ${def.name}`}
        >
          <SquarePen className="h-4 w-4" />
          {starting ? "Starting…" : "New chat"}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="gradient-bg flex items-center border-l border-white/20 px-2 text-white transition-opacity hover:opacity-90"
          aria-label="Choose an agent or set your default"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Choose an agent or set your default"
        >
          <ChevronDown
            className={clsx("h-4 w-4 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-slate-700/60 bg-slate-900/95 p-1 shadow-xl backdrop-blur"
        >
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Start a chat with…
          </p>
          {agents.length === 0 && (
            <p className="px-2 py-2 text-xs text-slate-500">
              No agents available yet.
            </p>
          )}
          {agents.map((a) => {
            const isDefault = a.id === def.id;
            return (
              <div
                key={a.id}
                className="group flex items-center gap-1 rounded-md px-1.5 py-1.5 hover:bg-slate-800"
              >
                <button
                  onClick={() => startChatWith(a.id, agentLabel(a))}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  role="menuitem"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-xs">
                    {a.emoji ? (
                      <span aria-hidden="true">{a.emoji}</span>
                    ) : (
                      <Bot className="h-3.5 w-3.5 text-stable-purple-light" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-slate-100">
                      {agentLabel(a)}
                    </span>
                    {a.title && (
                      <span className="block truncate text-[10px] text-slate-500">
                        {a.title}
                      </span>
                    )}
                  </span>
                  {isDefault && (
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-stable-purple-light">
                      default
                    </span>
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void makeDefault(a.id);
                  }}
                  className={clsx(
                    "shrink-0 rounded p-1 transition-colors",
                    isDefault
                      ? "text-amber-300"
                      : "text-slate-500 opacity-0 hover:text-amber-300 group-hover:opacity-100",
                  )}
                  aria-label={
                    isDefault
                      ? `${agentLabel(a)} is your default for New chat`
                      : `Set ${agentLabel(a)} as your default for New chat`
                  }
                  title={
                    isDefault
                      ? "Your default for New chat"
                      : "Set as default for New chat"
                  }
                >
                  <Star className={clsx("h-3.5 w-3.5", isDefault && "fill-current")} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
