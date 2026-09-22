import clsx from "clsx";
import { Check, Loader2 } from "lucide-react";
import {
  RECORDING_POLICY_OPTIONS,
  policyOption,
  type RecordingPolicy,
} from "@/lib/recording";

/**
 * Off / Ask / Always. The sentence under the group is the consequence of the
 * choice that is selected, so the owner sees what the room will do.
 */
export function RecordingPolicyForm({
  value,
  saving,
  disabled,
  onChange,
}: {
  value: RecordingPolicy;
  saving: RecordingPolicy | null;
  disabled?: boolean;
  onChange: (next: RecordingPolicy) => void;
}) {
  const selected = policyOption(value);
  return (
    <div data-testid="recording-policy">
      <div role="radiogroup" aria-label="Recording" className="flex flex-col gap-2">
        {RECORDING_POLICY_OPTIONS.map((option) => {
          const active = value === option.value;
          const busy = saving === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled || saving !== null}
              onClick={() => onChange(option.value)}
              className={clsx(
                "focus-ring flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors",
                active
                  ? "border-rose-500/50 bg-rose-500/10"
                  : "border-line bg-surface-2/50",
                !disabled && !active && "hover:border-line-strong",
                disabled && "cursor-default",
                saving !== null && !busy && "opacity-60",
              )}
            >
              <span className="min-w-0 flex-1 text-sm font-medium text-slate-100">
                {option.label}
              </span>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />
              ) : (
                active && <Check className="h-3.5 w-3.5 shrink-0 text-rose-300" />
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-400">{selected.consequence}</p>
    </div>
  );
}
