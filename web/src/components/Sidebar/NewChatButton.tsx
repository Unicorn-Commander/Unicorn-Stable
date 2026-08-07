import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { SquarePen, ChevronDown, Star } from "lucide-react";
import clsx from "clsx";
import { api, type Agent } from "@/services/api";
import { identityFor } from "@/lib/identity";
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
      useAppStore.getState().pushToast({
        title: "Couldn't start a new chat",
        body: (err as Error).message,
        kind: "error",
      });
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
      <div className="shadow-glow-iris flex w-full overflow-hidden rounded-xl">
        <button
          onClick={() => startChatWith(def.id, def.name)}
          disabled={starting}
          className="focus-ring gradient-bg flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm font-semibold text-white transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Start a new chat with ${def.name}`}
          title={`New chat with ${def.name}`}
        >
          <SquarePen className="h-4 w-4" />
          {starting ? "Starting…" : "New chat"}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="focus-ring gradient-bg flex items-center justify-center border-l border-white/20 px-3 text-white transition hover:opacity-90"
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
          className="glass-heavy animate-fade-in absolute left-0 right-0 z-30 mt-1.5 max-h-80 overflow-y-auto rounded-xl p-1.5 shadow-pop"
        >
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Start a chat with…
          </p>
          {agents.length === 0 && (
            <p className="px-2 py-2 text-xs text-slate-500">
              No agents available yet.
            </p>
          )}
          {agents.map((a) => {
            const isDefault = a.id === def.id;
            const ident = identityFor(a.id, agentLabel(a));
            return (
              <div
                key={a.id}
                className="group flex items-center gap-1 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-white/[0.06]"
              >
                <button
                  onClick={() => startChatWith(a.id, agentLabel(a))}
                  className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md text-left"
                  role="menuitem"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs"
                    style={{ background: ident.soft }}
                  >
                    {a.emoji ? (
                      <span aria-hidden="true">{a.emoji}</span>
                    ) : (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: ident.color }}
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[13px] font-medium"
                      style={{ color: ident.text }}
                    >
                      {agentLabel(a)}
                    </span>
                    {a.title && (
                      <span className="block truncate text-[10px] text-slate-500">
                        {a.title}
                      </span>
                    )}
                  </span>
                  {isDefault && (
                    <span className="shrink-0 rounded-md bg-amber-300/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">
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
                    "focus-ring shrink-0 rounded-md p-1 transition-colors",
                    isDefault
                      ? "text-amber-300"
                      : "text-slate-500 opacity-100 hover:text-amber-300 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100",
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
