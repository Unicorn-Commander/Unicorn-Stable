import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";

const AUTO_DISMISS_MS = 6000;

// Semantic tone for the accent bar + icon chip. The store's Toast carries no
// kind field, so this is a purely presentational read of the title — success
// and error phrasing get emerald/rose, everything else is info (sky).
function toneFor(title: string): { bar: string; chip: string; icon: string } {
  const t = title.toLowerCase();
  if (/\b(fail|failed|error|couldn|cannot|can't|denied|invalid)\b/.test(t)) {
    return {
      bar: "bg-rose-400",
      chip: "bg-rose-500/15",
      icon: "text-rose-400",
    };
  }
  if (/\b(saved|success|done|copied|created|sent|joined|added)\b/.test(t)) {
    return {
      bar: "bg-emerald-400",
      chip: "bg-emerald-500/15",
      icon: "text-emerald-400",
    };
  }
  return { bar: "bg-sky-400", chip: "bg-sky-500/15", icon: "text-sky-400" };
}

export function ToastStack() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const navigate = useNavigate();

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      setTimeout(() => dismissToast(t.id), AUTO_DISMISS_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  return (
    <div className="pointer-events-none fixed right-4 top-[max(1rem,env(safe-area-inset-top))] z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.slice(-5).map((t) => {
          const tone = toneFor(t.title);
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
                className="flex w-full items-start gap-2.5 p-3 pl-4 text-left transition-colors hover:bg-white/[0.04]"
              >
                <div className={`mt-0.5 rounded-md p-1.5 ${tone.chip}`}>
                  <Bell className={`h-3.5 w-3.5 ${tone.icon}`} />
                </div>
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
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissToast(t.id);
                  }}
                  className="shrink-0 rounded-md p-2.5 -m-1.5 text-slate-500 transition-colors hover:bg-white/[0.08] hover:text-slate-200"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
