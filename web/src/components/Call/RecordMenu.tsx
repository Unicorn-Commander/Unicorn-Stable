import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import { api, type ApiError } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useRecordingStore } from "@/stores/recordingStore";
import {
  IDLE_RECORDING,
  showRecordControl,
  type RecordingStartKind,
} from "@/lib/recording";
import { offerPresenterMode } from "@/lib/presenterOffer";

/**
 * Call-bar Record ▾. Hidden unless the caller has `stable-recorder` and the
 * room policy is Ask or Always. Starting and stopping call the real routes;
 * the red pill does not move until `recording_state` arrives.
 */
export function RecordMenu({
  roomId,
  size = "md",
  placement = "up",
  density = "bar",
  testId = "record-menu",
}: {
  roomId: string;
  size?: "md" | "lg";
  /** Call bar opens upward; the room header opens downward. */
  placement?: "up" | "down";
  /** `header` matches the 44px room bar. `bar` is the in-call control. */
  density?: "bar" | "header";
  testId?: string;
}) {
  const roles = useAppStore((s) => s.currentUser?.roles);
  const listed = useAppStore(
    (s) => s.rooms.find((room) => room.id === roomId)?.recording_policy,
  );
  const { data } = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api.getRoom(roomId),
    staleTime: 30_000,
  });
  const policy = data?.recording_policy ?? listed ?? "off";
  const recording = useRecordingStore((s) => s.byRoom[roomId] ?? IDLE_RECORDING);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!showRecordControl({ roles, policy })) return null;

  async function start(kind: RecordingStartKind) {
    setBusy(true);
    setOpen(false);
    try {
      await api.startRecording(roomId, kind);
      offerPresenterMode();
    } catch (error) {
      const err = error as ApiError;
      useAppStore.getState().pushToast({
        title: "Couldn't start the recording",
        body:
          (typeof err?.detail === "string" && err.detail) ||
          err?.message ||
          "Request failed",
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setOpen(false);
    try {
      await api.stopRecording(roomId);
    } catch (error) {
      const err = error as ApiError;
      useAppStore.getState().pushToast({
        title: "Couldn't stop the recording",
        body:
          (typeof err?.detail === "string" && err.detail) ||
          err?.message ||
          "Request failed",
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  const tall = size === "lg" ? "h-11" : "h-10";
  const live = recording.active;
  const inHeader = density === "header";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (live) {
            void stop();
            return;
          }
          setOpen((value) => !value);
        }}
        className={clsx(
          "focus-ring flex items-center gap-1 text-xs font-semibold transition-colors disabled:opacity-60",
          inHeader
            ? "h-10 shrink-0 rounded-md px-2"
            : clsx(
                "rounded-xl border px-2.5 active:scale-[0.98]",
                tall,
              ),
          live
            ? "border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25"
            : inHeader
              ? "text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
              : "border-transparent text-slate-200 hover:bg-white/[0.06] hover:text-slate-100",
        )}
        aria-label={live ? "Stop recording" : "Record"}
        aria-haspopup={live ? undefined : "menu"}
        aria-expanded={live ? undefined : open}
        data-testid={testId}
      >
        <span aria-hidden="true" className="text-rose-400">
          ●
        </span>
        <span className={inHeader ? "hidden sm:inline" : undefined}>
          {live ? "Stop" : "Record"}
        </span>
        {!live && <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />}
      </button>
      {open && !live && (
        <div
          role="menu"
          aria-label="Record"
          className={clsx(
            "glass-heavy absolute z-40 w-44 rounded-xl p-1.5 shadow-pop",
            placement === "down"
              ? "right-0 top-full mt-1"
              : "bottom-full left-1/2 mb-2 -translate-x-1/2",
          )}
        >
          <button
            type="button"
            role="menuitem"
            className="focus-ring flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-200 hover:bg-white/[0.06]"
            onClick={() => void start("audio")}
          >
            Record audio
          </button>
          <button
            type="button"
            role="menuitem"
            className="focus-ring flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-200 hover:bg-white/[0.06]"
            onClick={() => void start("composite")}
          >
            Record video
          </button>
        </div>
      )}
    </div>
  );
}
