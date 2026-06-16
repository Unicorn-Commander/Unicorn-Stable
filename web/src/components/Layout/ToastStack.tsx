import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";

const AUTO_DISMISS_MS = 6000;

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
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.slice(-5).map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-auto overflow-hidden rounded-lg border border-slate-700/60 bg-slate-900/95 shadow-lg backdrop-blur"
          >
            <button
              onClick={() => {
                if (t.roomId) navigate(`/c/${t.roomId}`);
                dismissToast(t.id);
              }}
              className="flex w-full items-start gap-2.5 p-3 text-left hover:bg-slate-800/60"
            >
              <div className="mt-0.5 rounded-md bg-stable-purple/20 p-1.5">
                <Bell className="h-3.5 w-3.5 text-stable-purple" />
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
                className="shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
