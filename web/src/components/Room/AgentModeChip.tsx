import { useState } from "react";
import clsx from "clsx";
import {
  AGENT_MODES,
  AGENT_MODE_LABEL,
  agentModeLabel,
  type AgentMode,
} from "@/lib/conversation";

/**
 * How an agent behaves in this room. Owner/admin can change it in one tap;
 * the server rejects everyone else.
 */
export function AgentModeChip({
  mode,
  canEdit = false,
  onChange,
  compact = false,
  className,
}: {
  mode: string | null | undefined;
  canEdit?: boolean;
  onChange?: (mode: AgentMode) => void;
  compact?: boolean;
  /** Wrapper classes — a row can let the chip shrink before its name does. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const label = agentModeLabel(mode);
  if (!label && !canEdit) return null;
  const current = (mode ?? "when_named") as AgentMode;

  return (
    <span className={clsx("relative inline-flex", className)}>
      <button
        type="button"
        disabled={!canEdit}
        aria-haspopup={canEdit ? "menu" : undefined}
        aria-expanded={canEdit ? open : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (canEdit) setOpen((v) => !v);
        }}
        className={clsx(
          "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
          canEdit
            ? "focus-ring border-amber-400/30 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20"
            : "border-line bg-white/[0.03] text-slate-400",
          compact && "max-w-[9rem] truncate",
          className && "max-w-full",
        )}
        title={label ?? "Set how this agent answers"}
      >
        {label ?? "Set mode"}
      </button>
      {open && canEdit && (
        <span
          role="menu"
          className="glass-heavy absolute left-0 top-full z-50 mt-1 w-44 rounded-xl p-1 shadow-pop"
        >
          {AGENT_MODES.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === current}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onChange?.(value);
              }}
              className={clsx(
                "focus-ring flex w-full rounded-lg px-2 py-1.5 text-left text-xs",
                value === current
                  ? "bg-white/[0.08] text-slate-50"
                  : "text-slate-300 hover:bg-white/[0.05]",
              )}
            >
              {AGENT_MODE_LABEL[value]}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
