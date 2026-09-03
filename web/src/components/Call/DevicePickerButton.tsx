import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronUp } from "lucide-react";
import clsx from "clsx";
import type { StableDeviceKind } from "@/lib/mediaDevices";

/**
 * The little chevron beside the mic / camera button: one click opens the
 * list of that kind of device, one more click switches to it — live, mid-
 * call, no Settings trip. The choice is remembered per browser/user by
 * VoiceProvider.switchDevice (the same store the pre-join dialog reads), so
 * the next call starts on it.
 *
 * Renders nothing when there is at most one device to choose from — a menu
 * with one entry is noise.
 */

const KIND_LABEL: Record<StableDeviceKind, string> = {
  audioinput: "Microphone",
  videoinput: "Camera",
  audiooutput: "Speaker",
};

interface Props {
  kind: StableDeviceKind;
  devices: MediaDeviceInfo[];
  selected: string;
  onSelect: (kind: StableDeviceKind, deviceId: string) => Promise<void>;
  /** Trigger height, matches the sibling control button. */
  size?: "sm" | "md" | "lg";
}

export function DevicePickerButton({
  kind,
  devices,
  selected,
  onSelect,
  size = "md",
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t))
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onMove = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  if (devices.length < 2) return null;

  function toggle(e: ReactMouseEvent) {
    e.stopPropagation();
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      // Opens UPWARD: the control bar lives at the bottom of the call surface.
      setPos({
        bottom: Math.max(8, window.innerHeight - r.top + 6),
        left: Math.max(8, Math.min(r.left - 8, window.innerWidth - 300)),
      });
    }
    setOpen((v) => !v);
  }

  async function pick(e: ReactMouseEvent, deviceId: string) {
    e.stopPropagation();
    if (deviceId === selected) {
      setOpen(false);
      return;
    }
    setBusy(deviceId);
    try {
      await onSelect(kind, deviceId);
      setOpen(false);
    } catch (err) {
      console.error(`switch ${kind} failed`, err);
    } finally {
      setBusy(null);
    }
  }

  const heights = { sm: "h-9", md: "h-10", lg: "h-11" } as const;
  const label = KIND_LABEL[kind];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className={clsx(
          "focus-ring -ml-1 flex w-5 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100",
          heights[size],
          open && "bg-white/[0.08] text-slate-100",
        )}
        aria-label={`Choose ${label.toLowerCase()}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Choose ${label.toLowerCase()}`}
      >
        <ChevronUp
          className={clsx("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
        />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`${label} devices`}
            className="glass-heavy fixed z-[90] w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl p-1.5 shadow-pop"
            style={{ bottom: pos.bottom, left: pos.left }}
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {label}
            </p>
            {devices.map((d, i) => {
              const active = d.deviceId === selected;
              return (
                <button
                  key={d.deviceId || i}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={busy !== null}
                  onClick={(e) => void pick(e, d.deviceId)}
                  className={clsx(
                    "focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-white/[0.08] text-slate-100"
                      : "text-slate-300 hover:bg-white/[0.06] hover:text-slate-100",
                    busy === d.deviceId && "opacity-60",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {d.label || `${label} ${i + 1}`}
                  </span>
                  {active && <Check className="h-4 w-4 shrink-0 text-emerald-400" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
