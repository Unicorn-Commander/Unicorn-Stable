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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
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
        className="glass-heavy w-full max-w-sm rounded-2xl shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-700/50 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-100">Leave room?</h2>
          <button
            onClick={onClose}
            disabled={leaving}
            className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
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

        <div className="flex justify-end gap-2 border-t border-slate-700/50 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={leaving}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={leaving}
            className="flex items-center gap-1.5 rounded-lg bg-red-500/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" />
            {leaving ? "Leaving…" : "Leave"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
