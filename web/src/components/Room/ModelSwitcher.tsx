import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, X } from "lucide-react";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { api, type ChatModel } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";

interface ModelSwitcherProps {
  roomId: string;
  /** Optional extra classes for the trigger button. */
  className?: string;
}

/**
 * OpenWebUI-style mid-conversation model switcher. Overrides the LLM used for
 * this room (client-side, per-room) until cleared. The override is stored in
 * the appStore modelOverrides map and read at send-time by useChat (chat) and
 * VoiceProvider (the spoken agent), so picking a model here changes both.
 */
export function ModelSwitcher({ roomId, className }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const override = useAppStore((s) => s.modelOverrides[roomId]);
  const setModelOverride = useAppStore((s) => s.setModelOverride);

  const { data: models = [] } = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => api.getModels(),
    staleTime: 5 * 60_000,
  });

  // Close on outside click (the keyboard hook handles Esc + focus).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useMenuKeyboard(open, menuRef, btnRef, () => setOpen(false));

  const selected = useMemo(
    () => models.find((m) => m.id === override),
    [models, override],
  );

  // Group models by family for a labeled list (OpenWebUI-style).
  const groups = useMemo(() => {
    const byFamily = new Map<string, ChatModel[]>();
    for (const m of models) {
      const key = m.family || "Other";
      const list = byFamily.get(key);
      if (list) list.push(m);
      else byFamily.set(key, [m]);
    }
    return Array.from(byFamily.entries());
  }, [models]);

  // Show the chosen model, or its raw id if the list hasn't loaded yet, or the
  // default label when there's no override.
  const triggerLabel = selected?.label ?? override ?? "Default model";

  function choose(modelId: string | null) {
    setModelOverride(roomId, modelId);
    setOpen(false);
  }

  return (
    <div className="relative flex items-center gap-1" ref={wrapRef}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "flex max-w-[10rem] items-center gap-1.5 rounded-lg border px-2 py-2.5 text-xs transition-colors focus-ring md:max-w-[12rem] md:py-1.5",
          override
            ? "border-stable-cyan/40 bg-stable-cyan/10 text-stable-cyan hover:border-stable-cyan/60 hover:bg-stable-cyan/15"
            : "border-line bg-white/[0.03] text-slate-300 hover:border-line-strong hover:bg-white/[0.05] hover:text-slate-100",
          className,
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch model for this conversation"
        title={
          override
            ? `Overridden for this room: ${triggerLabel} — the agent's default is unchanged elsewhere`
            : "Using the agent's default model (click to override for this room)"
        }
      >
        <Cpu className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </button>
      {override && (
        <button
          onClick={() => choose(null)}
          className="focus-ring rounded-md p-1 text-stable-cyan/70 transition-colors hover:bg-stable-cyan/10 hover:text-stable-cyan"
          aria-label="Reset to the agent's default model"
          title="Reset to the agent's default model"
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="glass-heavy absolute left-0 top-full z-50 mt-1 max-h-80 w-64 overflow-auto rounded-xl py-1 shadow-pop animate-fade-in"
        >
          {/* Default row — clears the override. */}
          <button
            role="menuitemradio"
            aria-checked={!override}
            onClick={() => choose(null)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
          >
            <span className="flex flex-col min-w-0">
              <span className="truncate">Auto — agent's default</span>
              <span className="truncate text-xs text-slate-500">
                Brigade decides; the agent runs on its configured model
              </span>
            </span>
            {!override && (
              <Check className="h-4 w-4 shrink-0 text-stable-cyan" />
            )}
          </button>

          {models.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">
              No models available.
            </div>
          ) : (
            groups.map(([family, list]) => (
              <div key={family}>
                <div className="my-1 h-px bg-white/[0.06]" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  {family}
                </div>
                {list.map((m) => {
                  const active = m.id === override;
                  return (
                    <button
                      key={m.id}
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => choose(m.id)}
                      className={clsx(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-white/[0.06] focus-ring",
                        active ? "text-stable-cyan" : "text-slate-200",
                      )}
                      title={m.id}
                    >
                      <span className="flex flex-col min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate">{m.label}</span>
                          {m.badge && (
                            <span
                              className={clsx(
                                "shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide",
                                m.badge === "Local"
                                  ? "bg-stable-mint/15 text-stable-mint"
                                  : "bg-sky-400/15 text-sky-300",
                              )}
                            >
                              {m.badge}
                            </span>
                          )}
                          {m.cost === "$" && (
                            <span
                              className="shrink-0 text-[10px] font-semibold text-amber-300/90"
                              title="Paid cloud lane"
                            >
                              $
                            </span>
                          )}
                        </span>
                        <span
                          className="truncate text-xs text-slate-500"
                          title={m.id}
                        >
                          {m.desc || m.id}
                        </span>
                      </span>
                      {active && (
                        <Check className="h-4 w-4 shrink-0 text-stable-cyan" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
