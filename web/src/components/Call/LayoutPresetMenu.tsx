import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Check, LayoutGrid, Trash2 } from "lucide-react";
import { useRoomPanels } from "@/hooks/useRoomPanels";
import {
  applyCallPreset,
  floatPanel,
  popPanel,
  presetModesMatch,
  saveCurrentLayout,
} from "@/lib/callLayoutActions";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import {
  builtinPreset,
  type BuiltinPresetId,
  type RoomPanelId,
} from "@/stores/panelRegistry";

const BUILTINS: { id: BuiltinPresetId; label: string; hint: string; keys: string }[] = [
  { id: "focus", label: "Focus", hint: "Stage only", keys: "Alt+1" },
  {
    id: "studio",
    label: "Studio",
    hint: "Stage, chat, transcript",
    keys: "Alt+2",
  },
  {
    id: "text",
    label: "Text",
    hint: "Chat main, stage in Picture-in-Picture",
    keys: "Alt+3",
  },
  {
    id: "show",
    label: "Show",
    hint: "Every panel in its own window",
    keys: "Alt+4",
  },
];

const POPPABLE: { id: RoomPanelId; label: string; keys: string }[] = [
  { id: "chat", label: "Chat", keys: "Alt+Shift+C" },
  { id: "transcript", label: "Transcript", keys: "Alt+Shift+T" },
  { id: "members", label: "Members", keys: "Alt+Shift+M" },
  { id: "canvas", label: "Canvas", keys: "Alt+Shift+A" },
  { id: "tasks", label: "Tasks", keys: "Alt+Shift+K" },
];

export function LayoutPresetMenu({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panels = useRoomPanels(roomId);
  const presets = usePanelChromeStore((s) => s.userPresets);
  const deleteUserPreset = usePanelChromeStore((s) => s.deleteUserPreset);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSaving(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const item =
    "focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-white/[0.06]";

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-transparent text-slate-200 transition-colors hover:bg-white/[0.06] hover:text-slate-100 active:scale-[0.98]",
          open && "bg-white/[0.06] text-slate-100",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Layout presets"
        title="Layout presets — Focus, Studio, Text, Show"
      >
        <LayoutGrid className="h-5 w-5" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Layout presets"
          className="glass-heavy absolute bottom-full right-0 z-40 mb-2 w-72 rounded-xl p-1.5 shadow-pop"
        >
          {BUILTINS.map((b) => {
            const active = presetModesMatch(panels, builtinPreset(b.id));
            return (
              <button
                key={b.id}
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  applyCallPreset(roomId, b.id);
                  setOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{b.label}</span>
                  <span className="text-[10px] font-normal text-slate-400">
                    {b.hint}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-slate-500">
                  {b.keys}
                </span>
                {active && <Check className="h-3.5 w-3.5 text-stable-cyan" />}
              </button>
            );
          })}
          <div className="my-1 h-px bg-line" />
          <p className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Pop out
          </p>
          {POPPABLE.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                popPanel(roomId, p.id);
                setOpen(false);
              }}
            >
              <span className="flex-1">{p.label}</span>
              <span className="font-mono text-[10px] text-slate-500">{p.keys}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              floatPanel(roomId, "chat");
              setOpen(false);
            }}
          >
            Float chat
          </button>
          {presets.length > 0 && <div className="my-1 h-px bg-line" />}
          {presets.map((p) => (
            <div key={p.id} className="flex items-center gap-1">
              <button
                type="button"
                role="menuitem"
                className={clsx(item, "min-w-0 flex-1")}
                onClick={() => {
                  applyCallPreset(roomId, p.panels);
                  setOpen(false);
                }}
              >
                <span className="truncate">{p.name}</span>
                {presetModesMatch(panels, p.panels) && (
                  <Check className="ml-auto h-3.5 w-3.5 text-stable-cyan" />
                )}
              </button>
              <button
                type="button"
                className="focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-white/[0.06] hover:text-slate-200"
                aria-label={`Delete preset ${p.name}`}
                onClick={() => deleteUserPreset(p.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="my-1 h-px bg-line" />
          {saving ? (
            <form
              className="flex items-center gap-1 px-1 py-1"
              onSubmit={(e) => {
                e.preventDefault();
                const name = draft.trim();
                if (!name) return;
                saveCurrentLayout(roomId, name);
                setDraft("");
                setSaving(false);
                setOpen(false);
              }}
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Preset name"
                maxLength={40}
                className="focus-ring min-w-0 flex-1 rounded-md border border-line bg-slate-950/60 px-2 py-1.5 text-xs text-slate-100"
                aria-label="Preset name"
              />
              <button
                type="submit"
                className="focus-ring rounded-md bg-stable-purple/25 px-2 py-1.5 text-xs font-medium text-stable-purple-light"
              >
                Save
              </button>
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => setSaving(true)}
            >
              Save current layout…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
