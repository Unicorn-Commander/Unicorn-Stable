import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, LayoutGrid } from "lucide-react";
import { useRoomPanels } from "@/hooks/useRoomPanels";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";
import { useModalA11y } from "@/hooks/useModalA11y";
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

const BUILTINS: {
  id: BuiltinPresetId;
  label: string;
  hint: string;
  keys: string;
}[] = [
  { id: "focus", label: "Focus", hint: "Stage only", keys: "Alt+Shift+1" },
  {
    id: "studio",
    label: "Studio",
    hint: "Stage, chat, transcript",
    keys: "Alt+Shift+2",
  },
  {
    id: "text",
    label: "Text",
    hint: "Chat main, stage in Picture-in-Picture",
    keys: "Alt+Shift+3",
  },
  {
    id: "show",
    label: "Show",
    hint: "One window per click — apply again for the next panel",
    keys: "Alt+Shift+4",
  },
];

const POPPABLE: { id: RoomPanelId; label: string; keys: string }[] = [
  { id: "chat", label: "Pop out chat", keys: "Alt+Shift+C" },
  { id: "transcript", label: "Pop out transcript", keys: "Alt+Shift+T" },
  { id: "members", label: "Pop out members", keys: "Alt+Shift+M" },
  { id: "canvas", label: "Pop out canvas", keys: "Alt+Shift+A" },
  { id: "tasks", label: "Pop out tasks", keys: "Alt+Shift+K" },
];

const MENU_WIDTH = 288;

function measureMenu(trigger: HTMLElement): { left: number; bottom: number } {
  const rect = trigger.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
  );
  const bottom = Math.max(8, window.innerHeight - rect.top + 8);
  return { left, bottom };
}

function SavePresetDialog({
  roomId,
  onClose,
}: {
  roomId: string;
  onClose: () => void;
}) {
  const panelRef = useModalA11y(true, onClose);
  const [draft, setDraft] = useState("");

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-4 sm:items-center"
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-layout-title"
        className="glass-heavy w-full max-w-sm rounded-xl p-4 shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2
          id="save-layout-title"
          className="text-sm font-semibold text-slate-100"
        >
          Save layout
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Names the panels as they are right now. Apply it later from this menu.
        </p>
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = draft.trim();
            if (!name) return;
            saveCurrentLayout(roomId, name);
            onClose();
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Preset name"
            maxLength={40}
            className="focus-ring w-full rounded-md border border-line bg-slate-950/60 px-2 py-2 text-sm text-slate-100"
            aria-label="Preset name"
          />
          <span className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="focus-ring rounded-md px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/[0.06]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="focus-ring rounded-md bg-stable-purple/25 px-3 py-2 text-xs font-medium text-stable-purple-light"
            >
              Save
            </button>
          </span>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function LayoutPresetMenu({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const panels = useRoomPanels(roomId);
  const presets = usePanelChromeStore((s) => s.userPresets);
  const deleteUserPreset = usePanelChromeStore((s) => s.deleteUserPreset);

  const closeMenu = useCallback(() => setOpen(false), []);
  useMenuKeyboard(open, menuRef, triggerRef, closeMenu);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (triggerRef.current) setPos(measureMenu(triggerRef.current));
    };
    place();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const item =
    "focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-white/[0.06]";

  const menu =
    open && pos
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Layout presets"
            className="glass-heavy fixed z-[90] w-72 rounded-xl p-1.5 shadow-pop"
            style={{ left: pos.left, bottom: pos.bottom, width: MENU_WIDTH }}
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
            <div role="separator" className="my-1 h-px bg-line" />
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
                <span className="font-mono text-[10px] text-slate-500">
                  {p.keys}
                </span>
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
            {presets.length > 0 && (
              <div role="separator" className="my-1 h-px bg-line" />
            )}
            {presets.map((p) => (
              <Fragment key={p.id}>
                <button
                  type="button"
                  role="menuitem"
                  className={item}
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
                  role="menuitem"
                  className={item}
                  onClick={() => deleteUserPreset(p.id)}
                >
                  Delete {p.name}
                </button>
              </Fragment>
            ))}
            <div role="separator" className="my-1 h-px bg-line" />
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                setSaving(true);
              }}
            >
              Save current layout…
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
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
      {menu}
      {saving && (
        <SavePresetDialog roomId={roomId} onClose={() => setSaving(false)} />
      )}
    </div>
  );
}
