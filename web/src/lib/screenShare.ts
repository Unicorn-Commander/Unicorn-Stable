/**
 * screenShare — shared capture helpers for getDisplayMedia / LiveKit screen share.
 *
 * Goals from the call-UI review (P-00115):
 *   1. Prefer full-screen (monitor) capture when the browser supports it, so
 *      users aren't stuck with a windows-only picker that feels broken.
 *   2. Replace an existing share cleanly (stop → start) without leaving a
 *      half-dead track that freezes the tile / pop-out.
 *   3. Optionally add a SECOND local share when the SFU/browser allows it;
 *      otherwise surface a clear replace path + guidance.
 *   4. Detect window-vs-monitor surface after capture and tip the user when
 *      they got a window instead of a full display.
 */

import {
  Track,
  createLocalScreenTracks,
  type LocalParticipant,
  type LocalTrack,
  type ScreenShareCaptureOptions,
} from "livekit-client";

/** Preferred capture options: full display first, audio when available. */
export const PREFERRED_SCREEN_SHARE_OPTIONS: ScreenShareCaptureOptions = {
  audio: true,
  systemAudio: "include",
  // Don't offer the Stable tab itself — sharing it into the call loops audio.
  selfBrowserSurface: "exclude",
  // Let the user switch the shared surface mid-share (Chromium).
  surfaceSwitching: "include",
  // Prefer the entire monitor in Chromium's picker (user can still pick window/tab).
  video: { displaySurface: "monitor" },
  contentHint: "detail",
};

/** Video-only fallback when audio constraints cause a hard reject. */
export const VIDEO_ONLY_SCREEN_SHARE_OPTIONS: ScreenShareCaptureOptions = {
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
  video: { displaySurface: "monitor" },
  contentHint: "detail",
};

export type ScreenShareSurface = "monitor" | "window" | "browser" | "unknown";

export type ScreenShareResult =
  | { ok: true; action: "started" | "stopped" | "replaced" | "added"; surface: ScreenShareSurface }
  | { ok: false; action: "cancelled" | "failed"; error?: string };

function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null && "name" in err) {
    return String((err as { name: unknown }).name);
  }
  return "";
}

export function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "";
}

/**
 * getDisplayMedia rejections that mean "user dismissed" or "nothing to share"
 * — not a failure worth toasting or retrying.
 */
export function isUserDismissedShare(err: unknown): boolean {
  const name = errorName(err);
  return (
    name === "NotAllowedError" ||
    name === "AbortError" ||
    name === "NotFoundError"
  );
}

/** Read displaySurface from a published local video track, if the browser exposes it. */
export function surfaceOfTrack(track: LocalTrack | null | undefined): ScreenShareSurface {
  try {
    const mst = track?.mediaStreamTrack;
    const surface = mst?.getSettings?.().displaySurface as string | undefined;
    if (surface === "monitor" || surface === "window" || surface === "browser") {
      return surface;
    }
  } catch {
    /* settings may throw on ended tracks */
  }
  return "unknown";
}

export function listLocalScreenVideoPubs(lp: LocalParticipant) {
  return Array.from(lp.trackPublications.values()).filter(
    (p) => p.kind === Track.Kind.Video && p.source === Track.Source.ScreenShare && p.track,
  );
}

export function listLocalScreenAudioPubs(lp: LocalParticipant) {
  return Array.from(lp.trackPublications.values()).filter(
    (p) =>
      p.kind === Track.Kind.Audio &&
      p.source === Track.Source.ScreenShareAudio &&
      p.track,
  );
}

export function localScreenShareCount(lp: LocalParticipant): number {
  return listLocalScreenVideoPubs(lp).length;
}

/**
 * Unpublish + stop every local screen-share track (video and audio).
 * More thorough than setScreenShareEnabled(false) alone, which only knows about
 * the primary ScreenShare publication and can leave multi-share extras orphaned.
 */
export async function stopAllScreenShares(lp: LocalParticipant): Promise<void> {
  const pubs = [
    ...listLocalScreenVideoPubs(lp),
    ...listLocalScreenAudioPubs(lp),
  ];
  for (const pub of pubs) {
    const track = pub.track;
    if (!track) continue;
    try {
      await lp.unpublishTrack(track);
    } catch (e) {
      console.warn("screenShare: unpublish failed", e);
    }
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
  // LiveKit bookkeeping for the primary source flag.
  try {
    if (lp.isScreenShareEnabled) {
      await lp.setScreenShareEnabled(false);
    }
  } catch {
    /* already off / no primary */
  }
}

async function startPrimaryShare(lp: LocalParticipant): Promise<LocalTrack | null> {
  try {
    await lp.setScreenShareEnabled(true, PREFERRED_SCREEN_SHARE_OPTIONS);
  } catch (err) {
    if (isUserDismissedShare(err)) throw err;
    console.warn("screen share with audio failed; retrying video-only", err);
    await lp.setScreenShareEnabled(true, VIDEO_ONLY_SCREEN_SHARE_OPTIONS);
  }
  const pub = listLocalScreenVideoPubs(lp)[0];
  return (pub?.track as LocalTrack | undefined) ?? null;
}

/**
 * Publish an ADDITIONAL screen share alongside an existing one.
 * Uses createLocalScreenTracks + publishTrack so we don't stomp the primary
 * setScreenShareEnabled slot. Returns null when the browser/SFU rejects it.
 */
async function startExtraShare(lp: LocalParticipant): Promise<LocalTrack | null> {
  let tracks: LocalTrack[];
  try {
    tracks = await createLocalScreenTracks(PREFERRED_SCREEN_SHARE_OPTIONS);
  } catch (err) {
    if (isUserDismissedShare(err)) throw err;
    tracks = await createLocalScreenTracks(VIDEO_ONLY_SCREEN_SHARE_OPTIONS);
  }
  const stamp = Date.now();
  let video: LocalTrack | null = null;
  try {
    for (const t of tracks) {
      const isVideo = t.kind === Track.Kind.Video;
      await lp.publishTrack(t, {
        source: isVideo ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
        name: isVideo ? `screen-extra-${stamp}` : `screen-extra-audio-${stamp}`,
        // Detail-heavy content (docs, code) benefits from higher quality.
        videoEncoding: isVideo
          ? { maxBitrate: 3_000_000, maxFramerate: 30 }
          : undefined,
      });
      if (isVideo) video = t;
    }
  } catch (e) {
    // Roll back any tracks we created but failed to publish.
    for (const t of tracks) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
  return video;
}

/**
 * Toggle / start / replace / add a local screen share.
 *
 *   • `toggle`  — off→on primary, on→stop all (header / bar button)
 *   • `start`   — start primary if none
 *   • `replace` — stop all, then start primary (swap surface without freeze)
 *   • `add`     — try a second share; on hard failure fall back to replace semantics for the caller
 */
export async function runScreenShareAction(
  lp: LocalParticipant,
  mode: "toggle" | "start" | "replace" | "add" = "toggle",
): Promise<ScreenShareResult> {
  const existing = localScreenShareCount(lp);

  try {
    if (mode === "toggle" && existing > 0) {
      await stopAllScreenShares(lp);
      return { ok: true, action: "stopped", surface: "unknown" };
    }

    if (mode === "replace" && existing > 0) {
      // Stop first so the picker isn't racing a live capture, then start clean.
      await stopAllScreenShares(lp);
      const track = await startPrimaryShare(lp);
      return {
        ok: true,
        action: "replaced",
        surface: surfaceOfTrack(track),
      };
    }

    if (mode === "add" && existing > 0) {
      try {
        const track = await startExtraShare(lp);
        return {
          ok: true,
          action: "added",
          surface: surfaceOfTrack(track),
        };
      } catch (err) {
        if (isUserDismissedShare(err)) {
          return { ok: false, action: "cancelled" };
        }
        // Multi-share not supported — surface a clear failure so the UI can
        // offer Replace instead of leaving the user with a silent no-op.
        return {
          ok: false,
          action: "failed",
          error:
            errorMessage(err) ||
            "This browser or call only allows one screen share. Use Replace to switch surfaces.",
        };
      }
    }

    // start / toggle-from-off / replace-from-off / add-from-off → primary
    const track = await startPrimaryShare(lp);
    return {
      ok: true,
      action: mode === "replace" ? "replaced" : "started",
      surface: surfaceOfTrack(track),
    };
  } catch (err) {
    if (isUserDismissedShare(err)) {
      return { ok: false, action: "cancelled" };
    }
    console.error("screen share failed", err);
    return {
      ok: false,
      action: "failed",
      error: errorMessage(err) || "Your browser blocked screen sharing.",
    };
  }
}

/** Human tip when the picker returned a window instead of a full display. */
export function windowShareGuidance(): string {
  return "You shared a window. For a full-display capture, stop sharing and share again — pick Entire Screen (not a single window).";
}

export function monitorShareHint(): string {
  return "Tip: pick Entire Screen for a full-display share. Window captures crop to one app and can confuse multi-monitor setups.";
}
