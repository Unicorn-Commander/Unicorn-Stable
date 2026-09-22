import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, X } from "lucide-react";
import { safeAvatarSrc, type SafeAvatarSrc } from "@/lib/identity";
import { useAppStore } from "@/stores/appStore";

const AUTO_DISMISS_MS = 6000;
// Errors linger: 6s is a success-chirp budget, not enough to read a failure
// and decide what to do about it.
const ERROR_DISMISS_MS = 15000;

type ToastKind = "success" | "error" | "info";

// Semantic tone for the accent bar + icon chip. Callers that pass `kind` win;
// the title regex stays as the legacy fallback for older call sites.
function kindFor(title: string, kind?: ToastKind): ToastKind {
  if (kind) return kind;
  const t = title.toLowerCase();
  if (/\b(fail|failed|error|couldn|cannot|can't|denied|invalid|not delivered)\b/.test(t)) {
    return "error";
  }
  if (/\b(saved|success|done|copied|created|sent|joined|added)\b/.test(t)) {
    return "success";
  }
  return "info";
}

function toneFor(kind: ToastKind): { bar: string; chip: string; icon: string } {
  if (kind === "error") {
    return {
      bar: "bg-rose-400",
      chip: "bg-rose-500/15",
      icon: "text-rose-400",
    };
  }
  if (kind === "success") {
    return {
      bar: "bg-emerald-400",
      chip: "bg-emerald-500/15",
      icon: "text-stable-mint",
    };
  }
  return { bar: "bg-sky-400", chip: "bg-sky-500/15", icon: "text-sky-400" };
}

function ToastIcon({
  icon,
  chip,
  iconClass,
}: {
  icon?: SafeAvatarSrc | null;
  chip: string;
  iconClass: string;
}) {
  const allowed = safeAvatarSrc(icon);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!allowed || failedSrc === allowed) {
    return (
      <div className={`mt-0.5 rounded-md p-1.5 ${chip}`}>
        <Bell className={`h-3.5 w-3.5 ${iconClass}`} />
      </div>
    );
  }
  return (
    <img
      src={allowed}
      alt=""
      width={28}
      height={28}
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(allowed)}
      className="mt-0.5 h-7 w-7 shrink-0 rounded-full object-cover"
    />
  );
}

export function ToastStack() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const navigate = useNavigate();

  useEffect(() => {
    if (toasts.length === 0) return;
    // Timers are anchored to each toast's createdAt rather than to effect
    // re-runs: the array identity changes whenever ANY toast arrives or
    // leaves, and naive `setTimeout(..., FULL_DURATION)` here silently reset
    // every surviving toast's countdown each time.
    const now = Date.now();
    const timers = toasts
      .filter((t) => !t.sticky)
      .map((t) => {
        const budget =
          kindFor(t.title, t.kind) === "error"
            ? ERROR_DISMISS_MS
            : AUTO_DISMISS_MS;
        const remaining = Math.max(0, t.createdAt + budget - now);
        return setTimeout(() => dismissToast(t.id), remaining);
      });
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 top-[max(1rem,env(safe-area-inset-top))] z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.slice(-5).map((t) => {
          const tone = toneFor(kindFor(t.title, t.kind));
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              className="glass-heavy pointer-events-auto relative overflow-hidden rounded-xl shadow-pop"
            >
              <span
                aria-hidden="true"
                className={`absolute inset-y-0 left-0 w-[3px] ${tone.bar}`}
              />
              <button
                onClick={() => {
                  if (t.roomId) navigate(`/c/${t.roomId}`);
                  dismissToast(t.id);
                }}
                className="flex w-full items-start gap-2.5 p-3 pl-4 pr-9 text-left transition-colors hover:bg-white/[0.04]"
              >
                <ToastIcon icon={t.icon} chip={tone.chip} iconClass={tone.icon} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {t.title}
                  </p>
                  {t.body && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">
                      {t.body}
                    </p>
                  )}
                </div>
              </button>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss notification"
                className="focus-ring absolute right-1.5 top-1.5 rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.08] hover:text-slate-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
