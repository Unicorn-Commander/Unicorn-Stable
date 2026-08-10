import { DisconnectReason } from "livekit-client";

/**
 * Device-handoff semantics for a live call.
 *
 * Stable mints ONE LiveKit identity per participant (`username_<uuid>`), on
 * every device — transcripts, webhooks, and mentions all parse that format,
 * so identity is the PERSON, not the device. LiveKit's contract for a second
 * connection with the same identity is to hand the identity to the newest
 * connection and disconnect the older one with DUPLICATE_IDENTITY.
 *
 * That server behaviour IS our handoff mechanism: joining your own live call
 * from another device moves the call there. What the SDK does not provide is
 * legibility on the losing leg — without this check the older device just
 * goes silent, which reads as "my call died". Detecting the reason lets that
 * device say "moved to another device" and offer the one-click move-back
 * (the call button, which the server answers with `in_call` → plain join).
 */
export function isMovedToAnotherDevice(reason?: DisconnectReason): boolean {
  return reason === DisconnectReason.DUPLICATE_IDENTITY;
}

/** Toast shown on the leg that LOST the call to another device. */
export const MOVED_TO_ANOTHER_DEVICE_TOAST = {
  title: "Call moved to another device",
  body: "You joined this call somewhere else, so this device left it. Press the call button to move it back here.",
  kind: "info" as const,
};
