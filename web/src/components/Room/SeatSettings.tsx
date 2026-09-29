import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Cpu, Lock, X } from "lucide-react";
import clsx from "clsx";
import { api, type Room, type RoomAgentMember, type RoomMember } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { AGENT_MODES, AGENT_MODE_LABEL, agentModeLabel, type AgentMode } from "@/lib/conversation";
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
  seatRefusalKind,
  type SeatMemberMatch,
} from "@/lib/seatSettings";

export interface SeatSettingsProps {
  roomId: string;
  /** The room detail (`["room", roomId]`) — its `agents[]` rows carry the mode. */
  room: Room | null | undefined;
  match: SeatMemberMatch;
  /** Controlled by the room: the header chip, the phone's More entry and `?seat=1` all open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server said 409 "no runner seat here" — this room has no seat after all. */
  onNoSeat?: () => void;
  /** Mode writes need room owner/admin; others see the mode, read-only. */
  canEditMode: boolean;
  /** More than one seat in the room: the chip says whose it is. */
  labelled?: boolean;
}

const PHONE_QUERY = "(max-width: 639px)";

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY)?.matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_QUERY);
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setPhone(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}

/**
 * The brain chip and its popover (Nav v3 §2.4, C2): Model (the seat's
 * announced list), Effort (low · medium · high · max) and Mode (the existing
 * agent_mode). "Default (Fable 5.1 · high)" is the null state, named.
 *
 * Model and effort write `{metadata: {seats: {<agent_id>: …}}}` through
 * PATCH /rooms/{id} with an optimistic room update and a revert on error
 * (422/403 toast; 409 "no seat" hides the chip, 409 "archived" says so).
 * Mode writes the member row; its value is read from the room's own
 * `agents[]` row first — the members payload may not carry `agent_mode`
 * — and the write lands in that row too, so a members refetch cannot undo
 * it. A partner's seat shows a locked chip with its owner's name. On
 * phones the chip is hidden (the 44px bar is full), More carries the entry,
 * and the popover is a bottom sheet portaled to the body so nothing in the
 * room paints over it.
 */
export function SeatSettings({
  roomId,
  room,
  match,
  open,
  onOpenChange,
  onNoSeat,
  canEditMode,
  labelled = false,
}: SeatSettingsProps) {
  const qc = useQueryClient();
  const storeRoom = useAppStore((s) => s.rooms.find((r) => r.id === roomId));
  const participants = useAppStore((s) => s.participants[roomId]);
  const chipRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const phone = usePhone();

  const caps = match.member.seat_capabilities;
  const agentId = match.member.agent_id;
  const pid = match.participantId;
  const seat = readRoomSeat(storeRoom?.metadata_ ? storeRoom : room, agentId);
  const label = seatChipLabel(seat, caps);
  const editable = match.editable;
  const rowMatches = (row: { participant_id?: string | null; agent_id?: string | null }) =>
    row.participant_id === pid || (!!row.agent_id && row.agent_id === agentId);
  const mode: AgentMode | null =
    ((room?.agent_members ?? []).find(rowMatches)?.agent_mode as AgentMode | null | undefined) ??
    (participants?.find((p) => (p.participant_id || p.id || p.user_id) === pid)?.agent_mode as
      | AgentMode
      | null
      | undefined) ??
    match.agentMode;

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
      const detail = (err as { detail?: string | null }).detail;
      if (status === 409) {
        if (seatRefusalKind(detail) === "archived") {
          fail("This room is archived — its seats can't change here", err);
          return;
        }
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

  /** The mode, written into every copy of the row: the room detail, the store room, the members roster. */
  function placeMode(value: AgentMode | null) {
    const patchAgents = (rows: RoomAgentMember[] | undefined) =>
      (rows ?? []).map((row) => (rowMatches(row) ? { ...row, agent_mode: value } : row));
    const patchMembers = (rows: RoomMember[]) =>
      rows.map((p) =>
        (p.participant_id || p.id || p.user_id) === pid ? { ...p, agent_mode: value } : p,
      );
    qc.setQueryData<Room | undefined>(["room", roomId], (current) =>
      current ? { ...current, agent_members: patchAgents(current.agent_members) } : current,
    );
    const state = useAppStore.getState();
    const storeRow = state.rooms.find((r) => r.id === roomId);
    if (storeRow) state.updateRoom(roomId, { agent_members: patchAgents(storeRow.agent_members) });
    state.setParticipants(roomId, patchMembers(state.participants[roomId] ?? []));
  }

  async function writeMode(next: AgentMode) {
    if (busy || !editable || !canEditMode) return;
    setBusy("mode");
    const previous = mode;
    placeMode(next);
    try {
      const updated = await api.setAgentMode(roomId, pid, next);
      // A members row without agent_mode (older servers) means "as written".
      placeMode((updated?.agent_mode as AgentMode | null | undefined) ?? next);
      void qc.invalidateQueries({ queryKey: ["room-members", roomId] });
    } catch (err) {
      placeMode(previous);
      fail("Couldn't change the mode", err);
    } finally {
      setBusy(null);
    }
  }

  // No display utility here: each variant says `hidden sm:inline-flex` itself
  // (a `inline-flex` in the shared string beat `hidden` and drew the chip on
  // phones, over the header icons).
  const chipClass =
    "max-w-[16rem] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
  const ownerName = match.member.owner ? ownerSeatLabel(match.member.owner).replace(/ seat$/, "") : null;
  const face = (
    <Identity
      {...resolveIdentity({
        id: match.member.agent_id,
        participant_id: match.member.participant_id || undefined,
        participant_type: "agent",
        display_name: match.member.display_name,
        avatar_url: match.member.avatar_url,
        username: match.member.agent_id,
      })}
      presence={null}
      size={14}
      alt=""
    />
  );

  if (!editable) {
    if (!label) return null;
    return (
      <span
        className={clsx(chipClass, "hidden border-line bg-white/[0.03] text-slate-400 sm:inline-flex")}
        title={`${label} — ${ownerName ? `${ownerName} seat` : "a partner's seat"}; only its owner can change it`}
        data-testid="seat-chip"
        data-editable="false"
        data-agent-id={agentId}
      >
        <Lock className="h-3 w-3 shrink-0" aria-hidden="true" data-testid="seat-chip-lock" />
        <span className="truncate">
          {ownerName ? `${ownerName} ` : ""}
          {match.member.display_name} · {label}
        </span>
      </span>
    );
  }

  const models = seatModelOptions(caps);
  const efforts = seatEffortOptions(caps);
  const currentModel = effectiveModel(seat, caps);
  const currentEffort = effectiveEffort(seat, caps);

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Seat settings for ${match.member.display_name}`}
      data-testid="seat-settings"
      data-agent-id={agentId}
      className={clsx(
        "glass-heavy flex max-h-[min(70dvh,32rem)] flex-col overflow-y-auto rounded-xl py-1 shadow-pop",
        phone
          ? "fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-[60] w-auto"
          : "absolute left-0 top-full z-50 mt-1 w-72",
      )}
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

      <p id={`seat-model-heading-${agentId}`} className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Model
      </p>
      <div role="radiogroup" aria-labelledby={`seat-model-heading-${agentId}`}>
        <button
          type="button"
          role="radio"
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
              {match.member.display_name}'s own settings
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
                role="radio"
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
      </div>

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

      <p id={`seat-mode-heading-${agentId}`} className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Mode
      </p>
      {canEditMode ? (
        <div role="radiogroup" aria-labelledby={`seat-mode-heading-${agentId}`}>
          {AGENT_MODES.map((value) => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
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
        </div>
      ) : (
        <p className="px-3 py-1.5 text-sm text-slate-300" data-testid="seat-mode-readonly">
          {agentModeLabel(mode) ?? "Default"}
          <span className="block text-[11px] text-slate-500">
            Only the room's owner or an admin can change how {match.member.display_name} answers here.
          </span>
        </p>
      )}
      <p className="px-3 pb-1.5 pt-2 text-[11px] leading-snug text-slate-500">
        Applies from the next reply in this conversation only.
      </p>
    </div>
  );

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
        aria-label={`Brain for ${match.member.display_name} in this conversation: ${label ?? "seat default"}. Change model, effort or mode`}
        title={isDefaultSeat(seat) ? `${label ?? "Seat default"} — the seat's default` : `${label} — set for this conversation`}
        data-testid="seat-chip"
        data-editable="true"
        data-agent-id={agentId}
      >
        {labelled ? face : <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />}
        <span className="truncate">
          {labelled ? `${match.member.display_name} · ` : ""}
          {label ?? "Brain"}
        </span>
      </button>
      {open && (phone ? createPortal(panel, document.body) : panel)}
    </span>
  );
}
