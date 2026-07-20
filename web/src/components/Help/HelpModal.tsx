/**
 * The help centre as a standalone modal.
 *
 * `HelpCenter` is layout-agnostic and fills whatever box it is given — Settings
 * embeds it as a pane. This wrapper is for the app shell, so Help can be opened
 * on its own without going through Settings first.
 *
 * Uses the same modal a11y as every other dialog (Esc to close, focus trap,
 * focus restore) so it behaves identically to Settings and the cheatsheet.
 */
import { motion } from "framer-motion";
import { useModalA11y } from "@/hooks/useModalA11y";
import { HelpCenter } from "./HelpCenter";

export interface HelpModalProps {
  onClose: () => void;
  /** Open straight to an article, e.g. from a "learn more" link elsewhere. */
  initialArticleId?: string;
  initialTab?: "guides" | "ask";
}

export function HelpModal({ onClose, initialArticleId, initialTab }: HelpModalProps) {
  const panelRef = useModalA11y(true, onClose);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="glass-heavy flex h-[85dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <HelpCenter
          onClose={onClose}
          initialArticleId={initialArticleId}
          initialTab={initialTab}
        />
      </motion.div>
    </motion.div>
  );
}

export default HelpModal;
