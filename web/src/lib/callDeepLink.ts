import type { CallKind } from "@/lib/callEntry";

/**
 * Call deep links — `/c/<roomId>?join=1&kind=voice|video&mic=…&cam=…&video=0|1&ring=0|1`.
 *
 * The contract a native control app (and anyone else) programs against is
 * written down in `~/Projects/rook-bin/specs/CALL-DEEPLINK.md`; this module
 * is its parser and its device matcher, kept pure so both are unit-tested
 * without a browser. Nothing here touches `window`.
 */

export interface CallDeepLink {
  /** Voice (default) or video call. `video=1` without a kind is a video call. */
  kind: CallKind;
  /** Requested microphone: a deviceId or a (partial) label. */
  mic: string | null;
  /** Requested camera: a deviceId or a (partial) label. */
  cam: string | null;
  /** Publish the camera on join. Default false — Stable calls are audio-first. */
  video: boolean;
  /** Ring the other human(s) in a DM / group DM. Default true (the phone button). */
  ring: boolean;
}

export const CALL_DEEPLINK_PARAMS = ["join", "kind", "mic", "cam", "video", "ring"] as const;

function kind(value: string | null, video: boolean): CallKind {
  const v = value?.trim().toLowerCase();
  if (v === "video") return "video";
  if (v === "voice" || v === "audio") return "voice";
  return video ? "video" : "voice";
}

function flag(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function text(value: string | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/**
 * Parse a location search string. Returns null unless `join=1` is present —
 * every other param is meaningless without it, so `?mic=x` alone does
 * nothing (a stray param must never silently join a call).
 */
export function parseCallDeepLink(search: string): CallDeepLink | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!flag(params.get("join"), false)) return null;
  const k = kind(params.get("kind"), flag(params.get("video"), false));
  return {
    kind: k,
    mic: text(params.get("mic")),
    cam: text(params.get("cam")),
    // `video=` is explicit when present; otherwise the kind decides. An
    // explicit voice kind is camera-off whatever the flag says.
    video: k === "voice" ? false : flag(params.get("video"), true),
    ring: flag(params.get("ring"), true),
  };
}

/** The same search string with every call param removed (may be ""). */
export function stripCallDeepLinkParams(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of CALL_DEEPLINK_PARAMS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export interface DeviceLike {
  deviceId: string;
  label: string;
}

/**
 * Resolve `wanted` (a deviceId or a label) against the enumerated devices of
 * one kind. Tiers, first hit wins, ties broken by enumeration order:
 *   1. exact deviceId
 *   2. exact label
 *   3. case-insensitive exact label
 *   4. case-insensitive label starts-with (Chrome's "(0d8c:0014)" suffixes)
 *   5. case-insensitive label contains
 * Returns null when nothing matches — the caller falls back and says so.
 */
export function matchDevice<T extends DeviceLike>(
  devices: readonly T[],
  wanted: string | null | undefined,
): T | null {
  const want = wanted?.trim();
  if (!want) return null;
  const lower = want.toLowerCase();
  const tiers: Array<(d: T) => boolean> = [
    (d) => d.deviceId === want,
    (d) => d.label === want,
    (d) => d.label.toLowerCase() === lower,
    (d) => d.label.toLowerCase().startsWith(lower),
    (d) => d.label.toLowerCase().includes(lower),
  ];
  for (const test of tiers) {
    const hit = devices.find(test);
    if (hit) return hit;
  }
  return null;
}
