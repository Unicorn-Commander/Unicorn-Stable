/**
 * pipManager — the single, module-level coordinator for native
 * Picture-in-Picture.
 *
 * The DOM allows exactly ONE element in PiP per document. This singleton is the
 * source of truth for "who owns PiP", so a per-tile hook (`usePipTile`) can
 * report `isActive` truthfully and opening tile B implicitly supersedes tile A.
 * It exposes the imperative surface directly (`requestPip` / `exitPip` /
 * `isSupported` / `getActivePipId`) and a `subscribe` hook for React's
 * `useSyncExternalStore`.
 *
 * Design notes:
 *   • `requestPictureInPicture()` MUST run synchronously inside a user gesture,
 *     so `requestPip` awaits NOTHING before calling it.
 *   • Requesting PiP on B while A owns it moves the window to B automatically;
 *     A then fires `leavepictureinpicture`. We tolerate either event order.
 *   • Elements are tagged with a caller-supplied id (usePipTile passes its
 *     React `useId()`), or an auto-id, so `activePipId` identifies the owner.
 */

/** Thrown by {@link PipManager.requestPip} when PiP can't be used. */
export class PipUnsupportedError extends Error {
  constructor(
    message = "Picture-in-Picture is not supported in this browser",
  ) {
    super(message);
    this.name = "PipUnsupportedError";
  }
}

type Listener = () => void;

let autoSeq = 0;
const nextAutoId = (): string => `pip-auto-${++autoSeq}`;

class PipManager {
  private listeners = new Set<Listener>();
  private activeEl: HTMLVideoElement | null = null;
  private activeId: string | null = null;
  /** element → stable id, so `activePipId` survives across events. */
  private ids = new WeakMap<HTMLVideoElement, string>();

  /**
   * Feature-detect standard Picture-in-Picture. False on browsers without it
   * (notably iOS Safari, which exposes only the non-standard webkit presentation
   * API and reports `pictureInPictureEnabled` undefined) — callers degrade to no
   * PiP control rather than a dead button.
   */
  isSupported = (): boolean => {
    if (typeof document === "undefined") return false;
    if (typeof HTMLVideoElement === "undefined") return false;
    return (
      document.pictureInPictureEnabled === true &&
      "requestPictureInPicture" in HTMLVideoElement.prototype
    );
  };

  /** Current PiP owner's id (snapshot for useSyncExternalStore). */
  getActivePipId = (): string | null => this.activeId;

  /** Subscribe to owner changes; returns an unsubscribe fn. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private setActive(el: HTMLVideoElement | null, id: string | null): void {
    if (this.activeEl === el && this.activeId === id) return;
    this.activeEl = el;
    this.activeId = id;
    this.emit();
  }

  private handleEnter = (e: Event): void => {
    const el = e.target as HTMLVideoElement;
    this.setActive(el, this.ids.get(el) ?? null);
  };

  private handleLeave = (e: Event): void => {
    const el = e.target as HTMLVideoElement;
    el.removeEventListener("enterpictureinpicture", this.handleEnter);
    el.removeEventListener("leavepictureinpicture", this.handleLeave);
    // Only clear when THIS element is still the recorded owner. When PiP moves
    // B←A, B's `enter` may fire before A's `leave`; guarding here means the
    // late `leave` from A doesn't stomp the new owner B.
    if (this.activeEl === el) this.setActive(null, null);
  };

  /**
   * Float `el` into the OS PiP window. Assigns/keeps a stable id for it. MUST be
   * invoked synchronously from a user gesture. Rejects with
   * {@link PipUnsupportedError} when PiP is unavailable or disabled on `el`.
   */
  requestPip = async (el: HTMLVideoElement, id?: string): Promise<void> => {
    if (!this.isSupported()) throw new PipUnsupportedError();
    if (el.disablePictureInPicture) {
      throw new PipUnsupportedError(
        "Picture-in-Picture is disabled on this element",
      );
    }
    const rid = id ?? this.ids.get(el) ?? nextAutoId();
    this.ids.set(el, rid);

    // Already the PiP element → just reconcile the id and return.
    if (
      typeof document !== "undefined" &&
      document.pictureInPictureElement === el
    ) {
      this.setActive(el, rid);
      return;
    }

    el.addEventListener("enterpictureinpicture", this.handleEnter);
    el.addEventListener("leavepictureinpicture", this.handleLeave);

    // No `await` before this line — the gesture must still be "live".
    await el.requestPictureInPicture();

    // The `enter` event also fires, but its ordering vs. this resolution isn't
    // guaranteed, so reflect immediately for a snappy UI.
    this.setActive(el, rid);
  };

  /** Close the PiP window if one is open. Safe to call unconditionally. */
  exitPip = async (): Promise<void> => {
    if (typeof document === "undefined") return;
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    }
    this.setActive(null, null);
  };
}

/** The one shared PiP coordinator for the app. */
export const pipManager = new PipManager();
