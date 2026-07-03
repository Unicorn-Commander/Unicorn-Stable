import { useEffect } from "react";
import { motion } from "framer-motion";
import { LogOut, X } from "lucide-react";

interface LeaveRoomModalProps {
  roomName: string;
  leaving: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * In-app confirmation for leaving a room. Replaces a blocking window.confirm()
 * so the flow matches the rest of the app's modals (CreateRoomModal /
 * CreateDmModal): framer-motion overlay, Escape / backdrop-click to cancel,
 * Cancel / Leave buttons. Rendered inside an <AnimatePresence> by the parent.
 */
export function LeaveRoomModal({
  roomName,
  leaving,
  onConfirm,
  onClose,
}: LeaveRoomModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !leaving) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, leaving]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !leaving) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Leave room"
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
            Leave room?
          </h2>
          <button
            onClick={onClose}
            disabled={leaving}
            className="focus-ring rounded-lg p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5">
          <p className="text-sm text-slate-300">
            Leave{" "}
            <span className="font-semibold text-slate-100">{roomName}</span>?
            You can rejoin from Browse channels.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={leaving}
            className="focus-ring rounded-xl px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={leaving}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-rose-500/90 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" />
            {leaving ? "Leaving…" : "Leave"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
