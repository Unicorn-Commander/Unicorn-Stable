/**
 * Voice settings — when the room's voice agent treats speech as addressed to
 * it. The room's ⋮ menu opens this (owner/admin only, and only when the room
 * HAS a voice agent — metadata.voice_relay_source); before this modal the
 * only way to change the mode was a SQL UPDATE, which is not a setting, it is
 * an incantation.
 *
 * Everything that is not rendering — the metadata reads, the owner/admin
 * gate, the mode→human-language mapping, the toast copy — lives in
 * lib/voiceSettings.ts and is tested there (the startGroupModel split).
 *
 * A change PATCHes /rooms/{id}/voice-settings, optimistically updates the
 * room-detail query (the same cache a live `relay_config` frame reconciles,
 * so this control and a change made by someone ELSE converge on one source of
 * truth), and reports through a toast: `live:false` while you're on this
 * room's call says plainly that the change waits for the next call.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Loader2, Mic, X } from "lucide-react";
import { api, type ApiError, type Room } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useModalA11y } from "@/hooks/useModalA11y";
import {
  canEditVoiceSettings,
  voiceActivationOptions,
  voiceAgentDisplayName,
  voiceRelayActivation,
  voiceRelayFlag,
  voiceRelaySource,
  voiceSettingsSavedToast,
  type VoiceActivationMode,
  type VoiceRelayFlag,
} from "@/lib/voiceSettings";

interface VoiceSettingsModalProps {
  roomId: string;
  roomName: string;
  onClose: () => void;
}

export function VoiceSettingsModal({
  roomId,
  roomName,
  onClose,
}: VoiceSettingsModalProps) {
  const panelRef = useModalA11y(true, onClose);
  const qc = useQueryClient();
  // Deduped with RoomView's own queries (same keys), so opening the modal is
  // normally free — the data is already in the cache.
  const { data: roomDetail } = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api.getRoom(roomId),
    staleTime: 30_000,
  });
  const { data: members } = useQuery({
    queryKey: ["room-members", roomId],
    queryFn: () => api.getRoomMembers(roomId),
    staleTime: 30_000,
  });
  // "Currently in a call HERE" — drives the live:false toast phrasing.
  const inCallHere = useCallUiStore((s) => s.activeCallRoomId) === roomId;

  const source = voiceRelaySource(roomDetail?.metadata_);
  const agentName = voiceAgentDisplayName(members, source);
  const currentMode = voiceRelayActivation(roomDetail?.metadata_);
  const canEdit = canEditVoiceSettings(members);
  const options = voiceActivationOptions(agentName);

  /** The mode whose PATCH is in flight (spinner on that row), if any. */
  const [saving, setSaving] = useState<VoiceActivationMode | null>(null);

  /* FACES + CAST (2026-09-02). Two room flags, both default OFF:
   *   voice_relay_video — the relay publishes a rendered puppet as its CAMERA
   *     track, so the agent is in the grid, on /broadcast and in OBS like a
   *     person on a webcam (agents/agent_runtime/puppet_video.py).
   *   voice_relay_multi — every other sender in the cast gets its own LiveKit
   *     participant, hosted by the relay (agents/voice_relay/cast.py).
   * Same PATCH as the mode; the server broadcasts the change into a live
   * call. Optimistic for the same reason the mode is. */
  const videoOn = voiceRelayFlag(roomDetail?.metadata_, "voice_relay_video");
  const multiOn = voiceRelayFlag(roomDetail?.metadata_, "voice_relay_multi");
  const [savingFlag, setSavingFlag] = useState<VoiceRelayFlag | null>(null);

  async function toggleFlag(key: VoiceRelayFlag, next: boolean) {
    if (saving || savingFlag || !canEdit) return;
    setSavingFlag(key);
    const previous = qc.getQueryData<Room>(["room", roomId]);
    const patchRoom = (value: boolean) =>
      qc.setQueryData<Room>(["room", roomId], (prev) =>
        prev
          ? { ...prev, metadata_: { ...(prev.metadata_ ?? {}), [key]: value } }
          : undefined,
      );
    patchRoom(next);
    try {
      const field = key === "voice_relay_video" ? "video" : "multi";
      const result = await api.updateVoiceSettings(roomId, currentMode, {
        [field]: next,
      });
      patchRoom(Boolean(result[field] ?? next));
      void qc.invalidateQueries({ queryKey: ["room", roomId] });
    } catch (e) {
      if (previous !== undefined) {
        qc.setQueryData<Room>(["room", roomId], previous);
      }
      void qc.invalidateQueries({ queryKey: ["room", roomId] });
      const err = e as ApiError;
      useAppStore.getState().pushToast({
        title: "Couldn't change the voice setting",
        body:
          (typeof err?.detail === "string" && err.detail) ||
          err?.message ||
          "Request failed",
        kind: "error",
      });
    } finally {
      setSavingFlag(null);
    }
  }

  const flagRows: {
    key: VoiceRelayFlag;
    on: boolean;
    label: string;
    description: string;
  }[] = [
    {
      key: "voice_relay_video",
      on: videoOn,
      label: "Faces on camera",
      description: `${agentName} publishes an animated puppet as its camera, so it shows in the grid, on broadcast pages and in OBS like anyone on a webcam.`,
    },
    {
      key: "voice_relay_multi",
      on: multiOn,
      label: "One tile per cast member",
      description:
        "Every other voice in the cast joins as its own participant, with its own mic and face, instead of speaking through this agent's tile.",
    },
  ];

  async function choose(mode: VoiceActivationMode) {
    if (saving || mode === currentMode || !canEdit) return;
    setSaving(mode);
    // Optimistic: patch the cached room detail so the ring moves immediately;
    // keep the snapshot to roll back on failure.
    const previous = qc.getQueryData<Room>(["room", roomId]);
    qc.setQueryData<Room>(["room", roomId], (prev) =>
      prev
        ? {
            ...prev,
            metadata_: {
              ...(prev.metadata_ ?? {}),
              voice_relay_activation: mode,
            },
          }
        : undefined,
    );
    try {
      const result = await api.updateVoiceSettings(roomId, mode);
      // Server truth (it may have normalized the value) + a refetch so the
      // persisted row gets the last word.
      qc.setQueryData<Room>(["room", roomId], (prev) =>
        prev
          ? {
              ...prev,
              metadata_: {
                ...(prev.metadata_ ?? {}),
                voice_relay_activation: result.activation,
              },
            }
          : undefined,
      );
      void qc.invalidateQueries({ queryKey: ["room", roomId] });
      const chosen =
        options.find((o) => o.mode === result.activation) ??
        options.find((o) => o.mode === mode)!;
      useAppStore.getState().pushToast({
        ...voiceSettingsSavedToast(chosen, result.live, inCallHere),
        kind: "success",
      });
    } catch (e) {
      // Roll the optimistic patch back — the UI must not keep asserting a
      // mode the server refused.
      if (previous !== undefined) {
        qc.setQueryData<Room>(["room", roomId], previous);
      }
      void qc.invalidateQueries({ queryKey: ["room", roomId] });
      const err = e as ApiError;
      useAppStore.getState().pushToast({
        title: "Couldn't change the voice setting",
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
        aria-label={`Voice settings for ${roomName}`}
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="glass-heavy flex max-h-[88vh] w-full max-w-md flex-col rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold text-slate-100">
              <Mic className="h-4 w-4 shrink-0 text-stable-cyan" />
              Voice settings — {roomName}
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              When {agentName} treats what&rsquo;s said on a call as addressed
              to it. Applies to everyone in the room.
            </p>
          </div>
          <button
            onClick={onClose}
            className="focus-ring ml-3 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!source ? (
            <p className="rounded-xl border border-line bg-slate-950/50 p-3 text-sm text-slate-400">
              This room has no voice agent, so there is nothing to configure
              here.
            </p>
          ) : (
            <>
              {!canEdit && (
                <p className="mb-3 rounded-xl border border-line bg-slate-950/50 p-3 text-xs text-slate-400">
                  Only the room&rsquo;s owner or an admin can change this.
                  You&rsquo;re seeing the current setting.
                </p>
              )}
              <div
                role="radiogroup"
                aria-label={`When ${agentName} listens`}
                className="flex flex-col gap-2"
              >
                {options.map((o) => {
                  const active = currentMode === o.mode;
                  const busy = saving === o.mode;
                  return (
                    <button
                      key={o.mode}
                      role="radio"
                      aria-checked={active}
                      disabled={!canEdit || saving !== null}
                      onClick={() => void choose(o.mode)}
                      className={clsx(
                        "focus-ring flex w-full items-start gap-3 rounded-lg border p-2.5 text-left transition-colors",
                        active
                          ? "border-stable-purple/60 bg-stable-purple/10"
                          : "border-line bg-surface-2/50",
                        canEdit && !active && "hover:border-line-strong",
                        !canEdit && "cursor-default",
                        saving !== null && !busy && "opacity-60",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-slate-100">
                          {o.label}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                          {o.description}
                        </span>
                      </span>
                      {busy ? (
                        <Loader2
                          aria-hidden="true"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-slate-400"
                        />
                      ) : (
                        active && (
                          <Check
                            aria-hidden="true"
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stable-purple-light"
                          />
                        )
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-col gap-2" aria-label="Faces">
                {flagRows.map((row) => {
                  const busy = savingFlag === row.key;
                  return (
                    <button
                      key={row.key}
                      role="switch"
                      aria-checked={row.on}
                      disabled={!canEdit || saving !== null || savingFlag !== null}
                      onClick={() => void toggleFlag(row.key, !row.on)}
                      className={clsx(
                        "focus-ring flex w-full items-start gap-3 rounded-lg border p-2.5 text-left transition-colors",
                        row.on
                          ? "border-stable-cyan/60 bg-stable-cyan/10"
                          : "border-line bg-surface-2/50",
                        canEdit && "hover:border-line-strong",
                        !canEdit && "cursor-default",
                        savingFlag !== null && !busy && "opacity-60",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-slate-100">
                          {row.label}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                          {row.description}
                        </span>
                      </span>
                      {busy ? (
                        <Loader2
                          aria-hidden="true"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-slate-400"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className={clsx(
                            "mt-0.5 shrink-0 text-[11px] font-medium",
                            row.on ? "text-stable-cyan" : "text-slate-500",
                          )}
                        >
                          {row.on ? "On" : "Off"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] leading-snug text-slate-500">
                A change reaches a call that&rsquo;s already running instantly
                when possible; otherwise it applies from the next call.
              </p>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
