import { useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, Loader2, X } from "lucide-react";
import { api, type ApiError, type Room } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useModalA11y } from "@/hooks/useModalA11y";
import { canEditVoiceSettings } from "@/lib/voiceSettings";
import type { RecordingPolicy } from "@/lib/recording";
import { RecordingPolicyForm } from "./RecordingPolicyForm";

type RecordingChoice = "audio" | "composite";

const RECORDING_FORMAT_OPTIONS: readonly {
  value: RecordingChoice;
  label: string;
}[] = [
  { value: "audio", label: "Audio" },
  { value: "composite", label: "Video" },
];

/**
 * Room recording policy. Owner/admin only — the same ladder as voice settings,
 * which is the ladder PATCH /rooms/{id} enforces for recording_policy.
 */
export function RecordingSettingsModal({
  roomId,
  roomName,
  onClose,
}: {
  roomId: string;
  roomName: string;
  onClose: () => void;
}) {
  const panelRef = useModalA11y(true, onClose);
  const qc = useQueryClient();
  const { data: room } = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api.getRoom(roomId),
    staleTime: 30_000,
  });
  const { data: members } = useQuery({
    queryKey: ["room-members", roomId],
    queryFn: () => api.getRoomMembers(roomId),
    staleTime: 30_000,
  });
  const canEdit = canEditVoiceSettings(members);
  const value: RecordingPolicy = room?.recording_policy ?? "off";
  const kind: RecordingChoice = room?.recording_kind === "composite" ? "composite" : "audio";
  const [saving, setSaving] = useState<RecordingPolicy | null>(null);
  const [savingKind, setSavingKind] = useState<RecordingChoice | null>(null);

  async function choose(next: RecordingPolicy) {
    if (!canEdit || saving || savingKind || next === value) return;
    setSaving(next);
    const previous = qc.getQueryData<Room>(["room", roomId]);
    const previousPolicy =
      useAppStore.getState().rooms.find((room) => room.id === roomId)
        ?.recording_policy ?? value;
    const patch = (policy: RecordingPolicy) => {
      qc.setQueryData<Room>(["room", roomId], (prev) =>
        prev ? { ...prev, recording_policy: policy } : prev,
      );
      useAppStore.getState().updateRoom(roomId, { recording_policy: policy });
    };
    patch(next);
    try {
      const result = await api.updateRecordingPolicy(roomId, next);
      const saved = result.recording_policy ?? next;
      patch(saved);
      void qc.invalidateQueries({ queryKey: ["room", roomId] });
      useAppStore.getState().pushToast({
        title: "Recording setting saved",
        body:
          saved === "off"
            ? "Calls in this room are not recorded."
            : saved === "always"
              ? "Every call in this room is recorded."
              : "A recorder can start a recording during a call.",
        kind: "success",
      });
    } catch (error) {
      if (previous) qc.setQueryData(["room", roomId], previous);
      else void qc.invalidateQueries({ queryKey: ["room", roomId] });
      useAppStore.getState().updateRoom(roomId, { recording_policy: previousPolicy });
      const err = error as ApiError;
      useAppStore.getState().pushToast({
        title: "Couldn't change recording",
        body:
          (typeof err?.detail === "string" && err.detail) ||
          err?.message ||
          "Request failed",
        kind: "error",
      });
    } finally {
      setSaving(null);
    }
  }

  async function chooseKind(next: RecordingChoice) {
    if (!canEdit || saving || savingKind || next === kind) return;
    setSavingKind(next);
    const previous = qc.getQueryData<Room>(["room", roomId]);
    const previousKind =
      useAppStore.getState().rooms.find((room) => room.id === roomId)?.recording_kind ?? kind;
    const patch = (recording_kind: RecordingChoice) => {
      qc.setQueryData<Room>(["room", roomId], (prev) =>
        prev ? { ...prev, recording_kind } : prev,
      );
      useAppStore.getState().updateRoom(roomId, { recording_kind });
    };
    patch(next);
    try {
      const result = await api.updateRecordingKind(roomId, next);
      const saved: RecordingChoice = result.recording_kind === "composite" ? "composite" : "audio";
      patch(saved);
      void qc.invalidateQueries({ queryKey: ["room", roomId] });
      useAppStore.getState().pushToast({
        title: "Recording format saved",
        body: saved === "composite" ? "Video recording is selected." : "Audio recording is selected.",
        kind: "success",
      });
    } catch (error) {
      if (previous) qc.setQueryData(["room", roomId], previous);
      else void qc.invalidateQueries({ queryKey: ["room", roomId] });
      useAppStore.getState().updateRoom(roomId, { recording_kind: previousKind });
      const err = error as ApiError;
      useAppStore.getState().pushToast({
        title: "Couldn't change recording format",
        body:
          (typeof err?.detail === "string" && err.detail) ||
          err?.message ||
          "Request failed",
        kind: "error",
      });
    } finally {
      setSavingKind(null);
    }
  }

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
        aria-label={`Recording for ${roomName}`}
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="glass-heavy flex w-full max-w-md flex-col rounded-2xl shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold text-slate-100">
              <Circle className="h-4 w-4 shrink-0 fill-rose-500 text-rose-500" />
              Recording — {roomName}
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Who can record this room, and whether calls record on their own.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring ml-3 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          {!canEdit && (
            <p className="mb-3 rounded-xl border border-line bg-slate-950/50 p-3 text-xs text-slate-400">
              Only the room's owner or an admin can change this.
            </p>
          )}
          <RecordingPolicyForm
            value={value}
            saving={saving}
            disabled={!canEdit || savingKind !== null}
            onChange={(next) => void choose(next)}
          />
          {value !== "off" && (
            <div className="mt-5 border-t border-line pt-4" data-testid="recording-format">
              <p className="text-sm font-medium text-slate-100">What to record</p>
              <div
                role="radiogroup"
                aria-label="Recording format"
                className="mt-2 flex gap-2"
              >
                {RECORDING_FORMAT_OPTIONS.map((option) => {
                  const active = kind === option.value;
                  const busy = savingKind === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={!canEdit || saving !== null || savingKind !== null}
                      onClick={() => void chooseKind(option.value)}
                      className={
                        "focus-ring flex flex-1 items-center justify-center gap-2 rounded-lg border p-2.5 text-sm font-medium transition-colors " +
                        (active
                          ? "border-rose-500/50 bg-rose-500/10 text-slate-100"
                          : "border-line bg-surface-2/50 text-slate-300") +
                        (!canEdit || saving !== null || savingKind !== null
                          ? " cursor-default opacity-60"
                          : " hover:border-line-strong")
                      }
                    >
                      {option.label}
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                      ) : (
                        active && <Check className="h-3.5 w-3.5 text-rose-300" />
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                Video uses more server capacity, and at most two video recordings run at once on an instance.
              </p>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
