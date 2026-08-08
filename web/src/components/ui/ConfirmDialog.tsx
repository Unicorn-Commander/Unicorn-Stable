import { useEffect } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";
import { X, type LucideIcon } from "lucide-react";

interface ConfirmDialogProps {
  /** Header line, e.g. "Delete message?" */
  title: string;
  /** The question/statement body. Named subjects ("Leave #general?") go here. */
  message: React.ReactNode;
  /** Confirm-button label, e.g. "Delete" / "Remove" / "Leave". */
  confirmLabel: string;
  /** Shown while the confirm action is in flight (disables both buttons). */
  busy: boolean;
  /** Confirm button label while busy. Defaults to `confirmLabel + "…"`. */
  busyLabel?: string;
  /** Icon on the confirm button. */
  icon?: LucideIcon;
  /** danger (rose, default) or default (neutral accent). */
  tone?: "danger" | "default";
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * In-app confirmation dialog. Generalizes the old LeaveRoomModal so every
 * destructive flow shares one primitive: framer-motion overlay, Escape /
 * backdrop-click to cancel, Cancel / Confirm buttons. Rendered inside an
 * <AnimatePresence> by the parent.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  busyLabel,
  icon: Icon,
  tone = "danger",
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="glass-heavy w-full max-w-sm rounded-2xl shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="font-display text-lg font-semibold text-slate-100">
            {title}
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="focus-ring rounded-lg p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5">
          <p className="text-sm text-slate-300">{message}</p>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="focus-ring rounded-xl px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={clsx(
              "focus-ring flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
              tone === "danger"
                ? "bg-rose-500/90 hover:bg-rose-500"
                : "bg-stable-purple/90 hover:bg-stable-purple",
            )}
          >
            {Icon && <Icon className="h-4 w-4" />}
            {busy ? (busyLabel ?? `${confirmLabel}…`) : confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
