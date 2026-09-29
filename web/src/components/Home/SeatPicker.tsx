import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";
import clsx from "clsx";
import type { CrewMember } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import {
  crewPresence,
  defaultBrainLabel,
  groupCrew,
  ownerSeatLabel,
} from "@/lib/crew";

const PHONE_QUERY = "(max-width: 639px)";

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY)?.matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_QUERY);
    if (!mq) return;
    const onChange = (event: MediaQueryListEvent) => setPhone(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}

function Face({ seat, size }: { seat: CrewMember; size: number }) {
  return (
    <Identity
      {...resolveIdentity({
        id: seat.agent_id,
        participant_id: seat.participant_id || undefined,
        participant_type: "agent",
        display_name: seat.display_name,
        avatar_url: seat.avatar_url,
        username: seat.agent_id,
      })}
      presence={null}
      size={size}
      alt=""
    />
  );
}

/** The second line of a row: what a seat runs, whose a partner's seat is, what a house agent is for. */
export function seatPickerLine(seat: CrewMember): string | null {
  if (seat.group === "partner") {
    return seat.owner ? ownerSeatLabel(seat.owner) : "A partner's seat";
  }
  if (seat.kind === "seat") return defaultBrainLabel(seat.seat_capabilities);
  return seat.role_line?.trim() || null;
}

/**
 * Who the message is for (Nav v3 §2.7): a face and a name at the left of
 * Home's composer, opening the crew in the rail's own order — your seats,
 * the house, partners. A listbox: arrows move, Enter picks, Escape closes.
 * On a phone it is a sheet.
 */
export function SeatPicker({
  seats,
  selected,
  onSelect,
  loading = false,
}: {
  seats: readonly CrewMember[];
  selected: CrewMember | null;
  onSelect: (seat: CrewMember) => void;
  /** /crew has not answered yet: the button says so and opens nothing. */
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const phone = usePhone();
  const listId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupCrew(seats), [seats]);
  const flat = useMemo(() => groups.flatMap((group) => group.members), [groups]);

  function show() {
    if (loading || flat.length === 0) return;
    const at = selected ? flat.findIndex((seat) => seat.agent_id === selected.agent_id) : 0;
    setActive(at >= 0 ? at : 0);
    setOpen(true);
  }

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function pick(seat: CrewMember | undefined) {
    if (!seat) return;
    onSelect(seat);
    close();
  }

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (flat.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index - 1 + flat.length) % flat.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(flat.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(flat[active]);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const name = selected?.display_name ?? (loading ? "Loading" : "Nobody");
  let index = -1;

  const panel = (
    <div
      ref={panelRef}
      id={listId}
      role="listbox"
      tabIndex={-1}
      aria-label="Who the message is for"
      aria-activedescendant={open && flat[active] ? `${listId}-${flat[active]!.agent_id}` : undefined}
      onKeyDown={onKeyDown}
      data-testid="seat-picker-list"
      className={clsx(
        "flex max-h-[min(70dvh,26rem)] flex-col overflow-y-auto rounded-xl py-1 shadow-pop outline-none",
        // The sheet hangs from the body and is glass. The popover hangs
        // inside the composer's box, whose own backdrop filter leaves a
        // glass child nothing to blur: there it is a solid surface, or the
        // page reads through it.
        phone
          ? "glass-heavy fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-[60]"
          : "absolute left-0 top-full z-50 mt-1 w-72 border border-line bg-surface-1",
      )}
    >
      {phone && (
        <div className="flex items-center justify-between px-3 pb-1 pt-1.5">
          <p className="text-xs font-semibold text-slate-100">Message</p>
          <button
            type="button"
            onClick={() => close()}
            className="focus-ring rounded-md p-1 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {groups.map((group) => (
        <div key={group.group} role="group" aria-label={group.label} data-testid={`seat-picker-group-${group.group}`}>
          <p className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            {group.label}
          </p>
          {group.members.map((seat) => {
            index += 1;
            const at = index;
            const chosen = selected?.agent_id === seat.agent_id;
            const presence = crewPresence(seat);
            const line = seatPickerLine(seat);
            return (
              <div
                key={seat.agent_id}
                id={`${listId}-${seat.agent_id}`}
                role="option"
                aria-selected={chosen}
                data-index={at}
                data-active={at === active || undefined}
                data-testid={`seat-option-${seat.agent_id}`}
                onPointerMove={() => setActive(at)}
                onClick={() => pick(seat)}
                className={clsx(
                  "flex cursor-pointer items-center gap-2.5 px-3 py-1.5 max-sm:min-h-11",
                  at === active ? "bg-white/[0.06]" : "",
                )}
              >
                <span className="relative shrink-0">
                  <Face seat={seat} size={24} />
                  {presence.dotClass && (
                    <span
                      role="img"
                      aria-label={presence.label}
                      title={presence.label}
                      className={clsx(
                        "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border",
                        presence.dotClass,
                      )}
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100">{seat.display_name}</span>
                  {line && <span className="block truncate text-[11px] text-slate-500">{line}</span>}
                </span>
                {chosen && <Check className="h-4 w-4 shrink-0 text-stable-cyan" aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  return (
    <span ref={rootRef} className="relative inline-flex min-w-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            show();
          }
        }}
        disabled={loading || flat.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={selected ? `Message ${name}. Change who the message is for` : name}
        data-testid="seat-picker"
        data-agent-id={selected?.agent_id}
        className="focus-ring inline-flex min-w-0 max-w-[12rem] items-center gap-1.5 rounded-full border border-line bg-white/[0.03] py-1 pl-1 pr-2 text-xs font-medium text-slate-200 transition-colors hover:border-line-strong hover:text-slate-50 disabled:opacity-60 max-sm:min-h-9 max-sm:pl-1.5 max-sm:pr-2.5"
      >
        {selected ? (
          <Face seat={selected} size={20} />
        ) : (
          <span className="h-5 w-5 shrink-0 rounded-full bg-white/[0.06]" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
      </button>
      {open && (phone ? createPortal(panel, document.body) : panel)}
    </span>
  );
}
