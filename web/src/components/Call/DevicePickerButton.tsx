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
 * One chevron can carry more than one kind: the mic chevron lists the
 * microphones AND the speakers in one menu, each under its own heading, the
 * way Jitsi and QuickTime do it (`also`). Until 2026-10-05 the speaker could
 * only be changed from Settings, although Settings said the bar could do it.
 *
 * Renders nothing when there is at most one device to choose from across the
 * sections — a menu with one entry is noise. A section with a single device
 * still shows when another section earned the menu, so the caller can see
 * which speaker the call is playing through.
 */

const KIND_LABEL: Record<StableDeviceKind, string> = {
  audioinput: "Microphone",
  videoinput: "Camera",
  audiooutput: "Speaker",
};

export interface DeviceSection {
  kind: StableDeviceKind;
  devices: MediaDeviceInfo[];
  selected: string;
}

interface Props {
  kind: StableDeviceKind;
  devices: MediaDeviceInfo[];
  selected: string;
  /** Further kinds listed in the same menu, below the first (e.g. Speaker under the mic chevron). */
  also?: DeviceSection[];
  onSelect: (kind: StableDeviceKind, deviceId: string) => Promise<void>;
  /** Trigger height, matches the sibling control button. */
  size?: "sm" | "md" | "lg";
}

export function DevicePickerButton({
  kind,
  devices,
  selected,
  also = [],
  onSelect,
  size = "md",
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  // `${kind}:${deviceId}` — Chrome gives the OS-default mic and the OS-default
  // speaker the same id ("default"), so the id alone cannot name a row.
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

  // A kind the browser does not expose (Safari lists no speakers) is left out
  // rather than shown empty.
  const sections: DeviceSection[] = [{ kind, devices, selected }, ...also].filter(
    (s) => s.devices.length > 0,
  );
  if (!sections.some((s) => s.devices.length >= 2)) return null;

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

  async function pick(e: ReactMouseEvent, section: DeviceSection, deviceId: string) {
    e.stopPropagation();
    if (deviceId === section.selected) {
      setOpen(false);
      return;
    }
    const row = `${section.kind}:${deviceId}`;
    setBusy(row);
    try {
      await onSelect(section.kind, deviceId);
      setOpen(false);
    } catch (err) {
      console.error(`switch ${section.kind} failed`, err);
    } finally {
      setBusy(null);
    }
  }

  const heights = { sm: "h-9", md: "h-10", lg: "h-11" } as const;
  // "Choose microphone and speaker" when the menu carries both.
  const label = sections
    .map((s) => KIND_LABEL[s.kind].toLowerCase())
    .join(" and ");

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
        aria-label={`Choose ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Choose ${label}`}
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
            {sections.map((section, si) => {
              const heading = KIND_LABEL[section.kind];
              return (
                <div
                  key={section.kind}
                  role="group"
                  aria-label={heading}
                  className={clsx(si > 0 && "mt-1 border-t border-white/[0.08] pt-1")}
                >
                  <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {heading}
                  </p>
                  {section.devices.map((d, i) => {
                    const active = d.deviceId === section.selected;
                    const row = `${section.kind}:${d.deviceId}`;
                    return (
                      <button
                        key={d.deviceId || i}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        disabled={busy !== null}
                        onClick={(e) => void pick(e, section, d.deviceId)}
                        className={clsx(
                          "focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                          active
                            ? "bg-white/[0.08] text-slate-100"
                            : "text-slate-300 hover:bg-white/[0.06] hover:text-slate-100",
                          busy === row && "opacity-60",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {d.label || `${heading} ${i + 1}`}
                        </span>
                        {active && (
                          <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
