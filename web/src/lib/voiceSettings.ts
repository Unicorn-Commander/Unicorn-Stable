/**
 * Voice-settings model — everything about the room voice-relay settings
 * surface that is not rendering, so it is testable without a DOM (the same
 * split as startGroupModel / guestInvite).
 *
 * The facts of the domain, all read from server room metadata:
 *   - a room HAS a voice agent iff `metadata_.voice_relay_source` is a
 *     non-empty string (the username whose chat messages the relay speaks);
 *   - `metadata_.voice_relay_activation` is how the relay decides a spoken
 *     line is addressed to it — absent/unknown means "name" (the server's
 *     default, mirrored in coerceVoiceActivationMode);
 *   - changing it is owner/admin only (PATCH /rooms/{id}/voice-settings uses
 *     the same role ladder as call moderation).
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Room, RoomMember } from "@/services/api";
import {
  coerceVoiceActivationMode,
  VOICE_ACTIVATION_MODES,
  type VoiceActivationMode,
} from "@/lib/roomDataProtocol";

export { VOICE_ACTIVATION_MODES };
export type { VoiceActivationMode };

/**
 * The username the room's voice relay speaks for, or null when the room has
 * no voice agent. Non-string / whitespace-only values count as "no agent" —
 * the server applies the same trim (rooms.py rejects the PATCH with 409).
 */
export function voiceRelaySource(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const raw = metadata?.voice_relay_source;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** The room's current activation mode; absent/unknown degrades to "name". */
export function voiceRelayActivation(
  metadata: Record<string, unknown> | null | undefined,
): VoiceActivationMode {
  return coerceVoiceActivationMode(metadata?.voice_relay_activation);
}

/** The relay's face / per-member participant flags (2026-09-02). */
export type VoiceRelayFlag = "voice_relay_video" | "voice_relay_multi";

/**
 * A relay flag as the room row holds it. The DB writes booleans; a hand-edit
 * or a LiveKit-metadata copy may hold "true"/"false" strings. Absent = off —
 * the same default the worker and the server apply.
 */
export function voiceRelayFlag(
  metadata: Record<string, unknown> | null | undefined,
  key: VoiceRelayFlag,
): boolean {
  const raw = metadata?.[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
  }
  return false;
}

/**
 * May this member list's caller change the voice settings? Owner/admin only —
 * the exact gate the server enforces, so a member never sees a control that
 * could only 403 (the Guest-access precedent). `is_self` is server-set and is
 * the only reliable "this is me" marker (Keycloak id ≠ participant UUID).
 */
export function canEditVoiceSettings(
  members: RoomMember[] | null | undefined,
): boolean {
  const self = members?.find((m) => m.is_self);
  return self?.role === "owner" || self?.role === "admin";
}

/** Fallback when the relay's member row can't be resolved by username. */
export const FALLBACK_AGENT_NAME = "the agent";

/**
 * The voice agent's display name, resolved from the room member whose
 * `username` equals `voice_relay_source` (that member's display_name is the
 * name the room actually knows the agent by — "Rook"). Falls back to
 * {@link FALLBACK_AGENT_NAME} rather than parroting a raw username.
 */
export function voiceAgentDisplayName(
  members: RoomMember[] | null | undefined,
  source: string | null,
): string {
  if (!source) return FALLBACK_AGENT_NAME;
  const member = members?.find((m) => m.username === source);
  return member?.display_name?.trim() || FALLBACK_AGENT_NAME;
}

export interface VoiceActivationOption {
  mode: VoiceActivationMode;
  /** Human phrasing of the mode — never the wire id. */
  label: string;
  /** One-line consequence, shown under the label. */
  description: string;
}

/**
 * The modes in HUMAN language, with the agent's actual name woven in.
 * Order is deliberate: default first, then the conversation window, then
 * increasingly open, "off" last.
 */
export function voiceActivationOptions(
  agentName: string,
): VoiceActivationOption[] {
  const name = agentName.trim() || FALLBACK_AGENT_NAME;
  return [
    {
      mode: "name",
      label: `Only when named — say “${name}, …”`,
      description: `Speech reaches ${name} only when a line starts with its name.`,
    },
    {
      mode: "window",
      label: `Named line, then a conversation`,
      description: `Say “${name}, …” once. Follow-ups for about a minute need no name. Side talk after that is ignored.`,
    },
    {
      mode: "always",
      label: "Everything I say",
      description: `Every spoken line on the call is treated as addressed to ${name}.`,
    },
    {
      mode: "ptt",
      label: "Only while my talk key is held",
      description: `${name} listens only while an external talk key (a pedal, a hotkey) is held.`,
    },
    {
      mode: "off",
      label: "Never — transcript only",
      description: `${name} still hears and transcribes the call but never replies to speech.`,
    },
  ];
}

/**
 * Reconcile the room-detail query with a voice-activation change that arrived
 * from OUTSIDE this client — a `relay_config` frame (someone else changed the
 * mode, or our own PATCH echoed back over the data channel).
 *
 * Two steps, both cheap: patch the cached `["room", id]` detail in place so a
 * mounted settings surface reflects the new mode immediately, then invalidate
 * so the server's persisted row gets the last word. Missing cache entry →
 * only the invalidate runs (returning undefined from the updater is
 * react-query's documented "leave it alone").
 */
export function applyRelayConfigToRoomQueries(
  qc: QueryClient,
  roomId: string,
  activation: VoiceActivationMode,
): void {
  qc.setQueryData<Room>(["room", roomId], (prev) =>
    prev
      ? {
          ...prev,
          metadata_: {
            ...(prev.metadata_ ?? {}),
            voice_relay_activation: activation,
          },
        }
      : undefined,
  );
  void qc.invalidateQueries({ queryKey: ["room", roomId] });
}

/**
 * Toast copy for a successful mode change. `live` is the server's word on
 * whether a live session heard the change; when it did not AND the user is on
 * a call in this room right now, say plainly that the change waits for the
 * next call — silence there would read as "the setting didn't take".
 */
export function voiceSettingsSavedToast(
  option: Pick<VoiceActivationOption, "label">,
  live: boolean,
  inCallHere: boolean,
): { title: string; body: string } {
  if (live) {
    return {
      title: "Voice setting updated",
      body: `${option.label} — the live call switched immediately.`,
    };
  }
  if (inCallHere) {
    return {
      title: "Voice setting saved",
      body: `${option.label} — the current call didn't pick it up, so it applies from the next call.`,
    };
  }
  return {
    title: "Voice setting saved",
    body: `${option.label} — applies from the next call.`,
  };
}
