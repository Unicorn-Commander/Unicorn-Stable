import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Cpu, X } from "lucide-react";
import clsx from "clsx";
import { api, type Room, type RoomMember } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";
import { AGENT_MODES, AGENT_MODE_LABEL, type AgentMode } from "@/lib/conversation";
import { modelLabel, ownerSeatLabel, readRoomSeat } from "@/lib/crew";
import {
  applySeatToRoom,
  effectiveEffort,
  effectiveModel,
  isDefaultSeat,
  pickEffort,
  pickModel,
  resetSeat,
  seatChipLabel,
  seatDefaultLabel,
  seatEffortOptions,
  seatModelOptions,
  seatPatchBody,
  type SeatMemberMatch,
} from "@/lib/seatSettings";

export interface SeatSettingsProps {
  roomId: string;
  room: Room | null | undefined;
  match: SeatMemberMatch;
  /** Controlled by the room: the header chip, the phone's More entry and `?seat=1` all open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server said 409 — this room has no runner seat after all. */
  onNoSeat?: () => void;
}

/**
 * The brain chip and its popover (Nav v3 §2.4, C2): Model (the seat's
 * announced list), Effort (low · medium · high · max) and Mode (the existing
 * agent_mode). "Default (Fable 5.1 · high)" is the null state, named. Model
 * and effort write `{metadata: {seats: {<agent_id>: …}}}` through PATCH
 * /rooms/{id} with an optimistic update (per seat — a room with two of your
 * seats has two chips); mode writes the member row as Home does. A partner's
 * seat shows the chip read-only, and the server 403s anyone but the owner.
 * On phones the chip is hidden (the 44px bar is full) and the popover is a
 * bottom sheet opened from More.
 */
export function SeatSettings({ roomId, room, match, open, onOpenChange, onNoSeat }: SeatSettingsProps) {
  const qc = useQueryClient();
  const storeRoom = useAppStore((s) => s.rooms.find((r) => r.id === roomId));
  const participants = useAppStore((s) => s.participants[roomId]);
  const chipRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const caps = match.member.seat_capabilities;
  const agentId = match.member.agent_id;
  const seat = readRoomSeat(storeRoom?.metadata_ ? storeRoom : room, agentId);
  const label = seatChipLabel(seat, caps);
  const editable = match.editable;
  const mode: AgentMode | null =
    (participants?.find((p) => (p.participant_id || p.id || p.user_id) === match.participantId)
      ?.agent_mode as AgentMode | null | undefined) ?? match.agentMode;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      onOpenChange(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  useMenuKeyboard(open, panelRef, chipRef, () => onOpenChange(false));

  function fail(title: string, err: unknown) {
    useAppStore.getState().pushToast({
      title,
      body:
        (err as { detail?: string; message?: string }).detail ||
        (err as Error).message ||
        "Request failed",
      kind: "error",
    });
  }

  async function writeSeat(next: { model: string | null; effort: string | null }) {
    if (busy || !editable) return;
    setBusy("seat");
    const state = useAppStore.getState();
    const before = state.rooms.find((r) => r.id === roomId) ?? room ?? null;
    if (before) state.updateRoom(roomId, applySeatToRoom(before, agentId, next));
    qc.setQueryData<Room | undefined>(["room", roomId], (current) =>
      current ? applySeatToRoom(current, agentId, next) : current,
    );
    try {
      const saved = await api.updateRoom(roomId, seatPatchBody(agentId, next));
      if (saved && typeof saved === "object" && "id" in saved) {
        useAppStore.getState().updateRoom(roomId, { metadata_: saved.metadata_ ?? null });
        qc.setQueryData<Room | undefined>(["room", roomId], (current) =>
          current ? { ...current, metadata_: saved.metadata_ ?? null } : current,
        );
      }
      void qc.invalidateQueries({ queryKey: ["rooms"] });
    } catch (err) {
      if (before) useAppStore.getState().updateRoom(roomId, { metadata_: before.metadata_ ?? null });
      qc.setQueryData<Room | undefined>(["room", roomId], (current) =>
        current && before ? { ...current, metadata_: before.metadata_ ?? null } : current,
      );
      const status = (err as { status?: number }).status;
      if (status === 409) {
        onOpenChange(false);
        onNoSeat?.();
        return;
      }
      fail(
        status === 403 ? "Only the seat's owner can change this" : "Couldn't change the brain",
        err,
      );
    } finally {
      setBusy(null);
    }
  }

  async function writeMode(next: AgentMode) {
    if (busy || !editable) return;
    setBusy("mode");
    const state = useAppStore.getState();
    const roster = state.participants[roomId] ?? [];
    const patchRoster = (value: AgentMode | null | undefined, list: RoomMember[]) =>
      list.map((p) =>
        (p.participant_id || p.id || p.user_id) === match.participantId ? { ...p, agent_mode: value ?? next } : p,
      );
    state.setParticipants(roomId, patchRoster(next, roster));
    try {
      const updated = await api.setAgentMode(roomId, match.participantId, next);
      useAppStore.getState().setParticipants(
        roomId,
        patchRoster(updated.agent_mode ?? next, useAppStore.getState().participants[roomId] ?? []),
      );
      void qc.invalidateQueries({ queryKey: ["room-members", roomId] });
    } catch (err) {
      useAppStore.getState().setParticipants(roomId, roster);
      fail("Couldn't change the mode", err);
    } finally {
      setBusy(null);
    }
  }

  // No display utility here: each variant says `hidden sm:inline-flex` itself
  // (a `inline-flex` in the shared string beat `hidden` and drew the chip on
  // phones, over the header icons).
  const chipClass =
    "max-w-[12rem] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
  const ownerLabel =
    match.member.group === "partner"
      ? match.member.owner
        ? ownerSeatLabel(match.member.owner)
        : "A partner's seat"
      : null;

  if (!editable) {
    if (!label) return null;
    return (
      <span
        className={clsx(chipClass, "hidden border-line bg-white/[0.03] text-slate-400 sm:inline-flex")}
        title={`${label} — ${ownerLabel ?? "this seat"}; only its owner can change it`}
        data-testid="seat-chip"
        data-editable="false"
        data-agent-id={agentId}
      >
        <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  const models = seatModelOptions(caps);
  const efforts = seatEffortOptions(caps);
  const currentModel = effectiveModel(seat, caps);
  const currentEffort = effectiveEffort(seat, caps);

  return (
    <span className="relative inline-flex">
      <button
        ref={chipRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        className={clsx(
          chipClass,
          "focus-ring hidden transition-colors sm:inline-flex",
          isDefaultSeat(seat)
            ? "border-line bg-white/[0.03] text-slate-300 hover:border-line-strong hover:text-slate-100"
            : "border-stable-cyan/40 bg-stable-cyan/10 text-stable-cyan hover:bg-stable-cyan/15",
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Brain for this conversation: ${label ?? "seat default"}. Change model, effort or mode`}
        title={isDefaultSeat(seat) ? `${label ?? "Seat default"} — the seat's default` : `${label} — set for this conversation`}
        data-testid="seat-chip"
        data-editable="true"
        data-agent-id={agentId}
      >
        <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{label ?? "Brain"}</span>
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Seat settings"
          data-testid="seat-settings"
          className="glass-heavy z-50 flex max-h-[min(70dvh,32rem)] w-72 flex-col overflow-y-auto rounded-xl py-1 shadow-pop max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[max(0.5rem,env(safe-area-inset-bottom))] max-sm:w-auto sm:absolute sm:left-0 sm:top-full sm:mt-1"
        >
          <div className="flex items-center justify-between px-3 pb-1 pt-1.5">
            <p className="min-w-0 truncate text-xs font-semibold text-slate-100">
              {match.member.display_name} · this conversation
            </p>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="focus-ring rounded-md p-1 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100 sm:hidden"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Model
          </p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={isDefaultSeat(seat)}
            disabled={busy !== null}
            onClick={() => void writeSeat(resetSeat())}
            className={clsx(
              "focus-ring flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.06] disabled:opacity-60",
              isDefaultSeat(seat) ? "text-stable-cyan" : "text-slate-200",
            )}
            data-testid="seat-default"
          >
            <span className="min-w-0">
              <span className="block truncate">{seatDefaultLabel(caps)}</span>
              <span className="block truncate text-[11px] text-slate-500">
                {caps?.harness ? `${caps.harness} · the seat's own settings` : "The seat's own settings"}
              </span>
            </span>
            {isDefaultSeat(seat) && <Check className="h-4 w-4 shrink-0 text-stable-cyan" />}
          </button>
          {models.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-slate-500">This seat has not announced its models yet.</p>
          ) : (
            models.map((model) => {
              const active = seat.model === model.id;
              const isDefault = model.id === caps?.default_model;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={busy !== null}
                  onClick={() => void writeSeat(pickModel(seat, model.id))}
                  className={clsx(
                    "focus-ring flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.06] disabled:opacity-60",
                    active ? "text-stable-cyan" : "text-slate-200",
                  )}
                  title={model.id}
                  data-testid={`seat-model-${model.id}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{model.label || modelLabel(model.id, caps)}</span>
                    {isDefault && !active && currentModel === model.id && (
                      <span className="shrink-0 text-[10px] text-slate-500">default</span>
                    )}
                  </span>
                  {active && <Check className="h-4 w-4 shrink-0 text-stable-cyan" />}
                </button>
              );
            })
          )}

          <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Effort
          </p>
          <div className="flex flex-wrap gap-1 px-3 pb-1" role="group" aria-label="Effort">
            {efforts.map((effort) => {
              const chosen = seat.effort === effort;
              const current = currentEffort === effort;
              return (
                <button
                  key={effort}
                  type="button"
                  aria-pressed={chosen}
                  disabled={busy !== null}
                  onClick={() => void writeSeat(pickEffort(seat, chosen ? null : effort))}
                  className={clsx(
                    "focus-ring rounded-lg border px-2.5 py-1 text-xs capitalize transition-colors disabled:opacity-60",
                    chosen
                      ? "border-stable-cyan/50 bg-stable-cyan/15 text-stable-cyan"
                      : current
                        ? "border-line-strong bg-white/[0.06] text-slate-100"
                        : "border-line text-slate-400 hover:bg-white/[0.05] hover:text-slate-100",
                  )}
                  title={current && !chosen ? `${effort} — the seat's default` : effort}
                  data-testid={`seat-effort-${effort}`}
                >
                  {effort}
                </button>
              );
            })}
          </div>

          <p className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Mode
          </p>
          {AGENT_MODES.map((value) => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={busy !== null}
                onClick={() => void writeMode(value)}
                className={clsx(
                  "focus-ring flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.06] disabled:opacity-60",
                  active ? "text-stable-cyan" : "text-slate-200",
                )}
                data-testid={`seat-mode-${value}`}
              >
                <span>{AGENT_MODE_LABEL[value]}</span>
                {active && <Check className="h-4 w-4 shrink-0 text-stable-cyan" />}
              </button>
            );
          })}
          <p className="px-3 pb-1.5 pt-2 text-[11px] leading-snug text-slate-500">
            Applies from the next reply in this conversation only.
          </p>
        </div>
      )}
    </span>
  );
}
