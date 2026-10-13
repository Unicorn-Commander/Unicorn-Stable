import clsx from "clsx";
import { usePresenterStore } from "@/stores/presenterStore";

/** Quiet, local-only indicator. The button is the complete off switch. */
export function PresenterBadge({ className }: { className?: string }) {
  const enabled = usePresenterStore((state) => state.enabled);
  const setEnabled = usePresenterStore((state) => state.setEnabled);
  if (!enabled) return null;
  return (
    <button
      type="button"
      onClick={() => setEnabled(false)}
      className={clsx(
        "focus-ring rounded-full border border-stable-purple/30 bg-stable-purple/10 px-2 py-1 text-[10px] font-medium text-stable-purple-light transition-colors hover:bg-stable-purple/20",
        className,
      )}
      aria-label="Turn off Presenter mode"
      title="Presenter mode is a display filter on this device. Click to turn it off."
      data-testid="presenter-badge"
    >
      Presenter mode
    </button>
  );
}

