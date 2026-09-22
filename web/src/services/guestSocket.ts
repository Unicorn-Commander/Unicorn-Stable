/**
 * The guest's WebSocket — a separate, much smaller client than
 * `services/websocket.ts`.
 *
 * WHY NOT THE SHARED ONE: that socket is built around Keycloak. Its whole
 * connect path is "force-refresh the access token, check it is still usable,
 * fall back to the cache, escalate to `auth_expired` when the refresh token
 * dies". A guest has no refresh token, no IdP and no federation store to read a
 * wsUrl from, so every one of those branches is either dead code or an
 * outright wrong answer for this credential. It also holds process-wide state
 * (`ws.connect()` is a singleton the app shell owns) — a guest page must not be
 * able to disturb, or be disturbed by, an authenticated session in another tab
 * of the same browser.
 *
 * THE ONE RULE THIS FILE EXISTS FOR: a `{"type":"session_ended"}` frame, or a
 * close code that is the server's verdict on this credential, means STOP
 * RECONNECTING. The server sends that frame when the host revokes the link,
 * when it boots this guest, and on its own 4-second re-check when the session
 * or its invite has lapsed under a live socket. Retrying replays a refusal
 * forever while the browser sits there looking connected — the silent-failure
 * mode that is worth more care than the happy path.
 */
import {
  guestReconnectDelayMs,
  isAuthOkFrame,
  isSessionEndedFrame,
  shouldReconnectAfterClose,
} from "@/lib/guest";
import { guestWebSocketUrl } from "@/services/guestApi";

/** What the shell renders as a connection pill. `ended` is TERMINAL. */
export type GuestSocketStatus = "connecting" | "live" | "reconnecting" | "ended";

export interface GuestSocketHandlers {
  /** A room event: `message`, `members_changed`, `presence`, … */
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  onStatus?: (status: GuestSocketStatus) => void;
  /** Terminal. Called at most once, and never after `close()`. */
  onSessionEnded?: () => void;
}

/** How long a socket may sit in CONNECTING before we abandon it. A frozen
 *  mobile socket often fires neither onopen nor onclose. */
const HANDSHAKE_TIMEOUT_MS = 8_000;
/** How long the server gets to answer the auth frame with `auth_ok`. */
const AUTH_ACK_TIMEOUT_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;

export class GuestSocket {
  private ws: WebSocket | null = null;
  private generation = 0;
  private attempts = 0;
  private authed = false;
  /** Terminal latch. Once set, nothing reconnects and no handler fires again. */
  private ended = false;
  private closedByUs = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null;
  private lifecycleBound = false;

  constructor(
    private readonly token: string,
    private readonly handlers: GuestSocketHandlers = {},
  ) {}

  connect(): void {
    if (this.ended || this.closedByUs) return;
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.bindLifecycle();
    this.handlers.onStatus?.(this.attempts === 0 ? "connecting" : "reconnecting");

    const generation = ++this.generation;
    let socket: WebSocket;
    try {
      socket = new WebSocket(guestWebSocketUrl());
    } catch {
      // A malformed URL. Retry rather than sit with no socket and nothing
      // pending, which is indistinguishable from "offline with no explanation".
      this.scheduleReconnect(generation);
      return;
    }
    this.ws = socket;
    this.armHandshakeTimeout(socket, generation);

    socket.onopen = () => {
      if (!this.owns(socket, generation)) return;
      // The transport is up but the socket is NOT usable yet: the server has
      // not judged the credential. The token travels in the FIRST FRAME, never
      // the URL — out of access logs, proxy buffers and the 8 KiB request-line
      // limit that silently stalls uvicorn.
      try {
        socket.send(JSON.stringify({ type: "auth", token: this.token }));
      } catch {
        this.teardown(socket);
        this.scheduleReconnect(generation);
        return;
      }
      this.armAuthAckTimeout(socket, generation);
    };

    socket.onmessage = (event: MessageEvent) => {
      if (!this.owns(socket, generation)) return;
      this.resetHeartbeatDeadline();

      let frame: unknown;
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }

      // CHECKED FIRST, before auth_ok and before any event dispatch: this frame
      // can arrive at any point in the socket's life, including immediately
      // after auth on a session that was revoked a moment ago.
      if (isSessionEndedFrame(frame)) {
        this.end();
        return;
      }

      if (isAuthOkFrame(frame)) {
        this.authed = true;
        this.attempts = 0;
        this.startHeartbeat(socket, generation);
        this.handlers.onStatus?.("live");
        return;
      }

      const raw = frame as Record<string, unknown>;
      const type = typeof raw.type === "string" ? raw.type : "";
      if (!type || type === "pong") return;
      // The backend frames events two ways — {type, payload} and flat, with the
      // fields at top level. Accept both, exactly as the app socket does.
      const payload =
        raw.payload !== undefined && typeof raw.payload === "object"
          ? (raw.payload as Record<string, unknown>)
          : { ...raw };
      if (
        type === "recording_state" &&
        typeof raw.room_id === "string" &&
        typeof payload.room_id !== "string"
      ) {
        payload.room_id = raw.room_id;
      }
      this.handlers.onEvent?.(type, payload);
    };

    socket.onclose = (event: CloseEvent) => {
      if (!this.owns(socket, generation)) return;
      this.stopHeartbeat();
      this.authed = false;
      if (this.ended || this.closedByUs) return;
      if (!shouldReconnectAfterClose(event.code)) {
        // 4001/4003/4004 are judgements on THIS credential. Retrying replays a
        // refusal, so this is the same terminal state as `session_ended` —
        // arrived at through the close code instead of a frame.
        this.end();
        return;
      }
      this.scheduleReconnect(generation);
    };

    socket.onerror = () => {
      // Close THIS socket, not `this.ws` — a stale socket's error must not kill
      // a healthy connection that has since replaced it.
      try {
        socket.close();
      } catch {
        /* already torn down */
      }
    };
  }

  /** Deliberate shutdown by the page (unmount, or the guest pressed Leave).
   *  Silent: no status change, no onSessionEnded. */
  close(): void {
    this.closedByUs = true;
    this.generation++;
    this.clearTimers();
    this.stopHeartbeat();
    const socket = this.ws;
    this.ws = null;
    if (socket) this.teardown(socket);
  }

  get isLive(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  /* ---------------------------------------------------------------- */

  private owns(socket: WebSocket, generation: number): boolean {
    return this.ws === socket && generation === this.generation;
  }

  /** The terminal transition. Idempotent, because it is reachable from the
   *  frame, from the close code, and from a caller. */
  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.generation++;
    this.clearTimers();
    this.stopHeartbeat();
    const socket = this.ws;
    this.ws = null;
    if (socket) this.teardown(socket);
    this.handlers.onStatus?.("ended");
    this.handlers.onSessionEnded?.();
  }

  /** Detach BEFORE closing: a frozen socket may fire onclose much later, or
   *  never, so recovery must not depend on an event from it. */
  private teardown(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* already torn down by the browser */
    }
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private scheduleReconnect(generation: number): void {
    if (this.ended || this.closedByUs) return;
    if (generation !== this.generation) return;
    this.attempts += 1;
    this.handlers.onStatus?.("reconnecting");
    this.later(() => this.connect(), guestReconnectDelayMs(this.attempts));
  }

  private armHandshakeTimeout(socket: WebSocket, generation: number): void {
    this.later(() => {
      if (!this.owns(socket, generation)) return;
      if (socket.readyState !== WebSocket.CONNECTING) return;
      this.teardown(socket);
      this.ws = null;
      this.scheduleReconnect(generation);
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private armAuthAckTimeout(socket: WebSocket, generation: number): void {
    this.later(() => {
      if (!this.owns(socket, generation)) return;
      if (this.authed) return;
      // OPEN but dead: no `auth_ok` ever arrived, so nothing would close it or
      // schedule a retry, and the page would sit on a silent connection.
      this.teardown(socket);
      this.ws = null;
      this.scheduleReconnect(generation);
    }, AUTH_ACK_TIMEOUT_MS);
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    this.stopHeartbeat();
    this.resetHeartbeatDeadline();
    this.heartbeat = setInterval(() => {
      if (!this.owns(socket, generation)) return;
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        this.teardown(socket);
        this.ws = null;
        this.scheduleReconnect(generation);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private resetHeartbeatDeadline(): void {
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    if (this.ended || this.closedByUs) return;
    this.heartbeatDeadline = setTimeout(() => {
      // Nothing inbound for longer than the pong window. The socket may still
      // report OPEN — a backgrounded tab's socket routinely does while upstream
      // is long gone — so tear it down rather than believing readyState.
      const socket = this.ws;
      const generation = this.generation;
      if (socket) {
        this.teardown(socket);
        this.ws = null;
      }
      this.scheduleReconnect(generation);
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeat = null;
    this.heartbeatDeadline = null;
  }

  /**
   * Reconnect the moment the page comes back to the foreground or the network
   * returns. Mobile browsers freeze — and often silently kill — WebSockets when
   * a tab is backgrounded, frequently WITHOUT firing onclose, so a guest who
   * locked their phone between segments would otherwise come back to a socket
   * that looks open and delivers nothing.
   */
  private bindLifecycle(): void {
    if (this.lifecycleBound || typeof document === "undefined") return;
    this.lifecycleBound = true;
    const resume = () => {
      if (this.ended || this.closedByUs) return;
      if (this.ws?.readyState === WebSocket.OPEN) return;
      this.attempts = 0;
      this.clearTimers();
      this.connect();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resume();
    });
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
  }
}
