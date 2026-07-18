import { getToken } from "./auth";
import { useFederationStore } from "@/stores/federationStore";

type EventCallback = (data: WsEventPayload) => void;

export interface WsMessage {
  type: string;
  payload: WsEventPayload;
}

export interface WsMessageEvent {
  room_id: string;
  message: {
    id: string;
    room_id: string;
    sender_id: string;
    sender_type: "human" | "agent" | "system";
    sender_name: string;
    sender_avatar: string | null;
    content: string;
    content_type: "text" | "action" | "system" | "image" | "file";
    thread_id: string | null;
    reply_count: number;
    edited: boolean;
    created_at: string;
    updated_at: string;
    metadata: Record<string, unknown>;
  };
  /** True when this is the live placeholder of an agent reply that is about to
   * stream — lets the client mark the message generating (and show Stop) from
   * the flag alone, rather than inferring it from the "…" content. */
  streaming?: boolean;
}

export interface WsTypingEvent {
  room_id: string;
  user_id: string;
  username: string;
  is_typing: boolean;
}

export interface WsPresenceEvent {
  /** Canonical identity the roster resolves on (Participant.id). The server
   * sends this and mirrors it as `user_id`. */
  participant_id?: string;
  /** Mirror of participant_id (what the presence hook reads today). */
  user_id?: string;
  username?: string;
  /** Boolean online flag (current server). */
  is_online?: boolean;
  /** String status ("online"/"offline") — legacy/alt shape; accepted as a fallback. */
  status?: string;
  last_seen?: string;
}

export interface WsMessageEditEvent {
  room_id: string;
  message_id: string;
  content: string;
  updated_at: string;
  /** Present (true) on incremental streaming patches of an agent reply; absent
   * on the final finalize edit. Lets the client show a live "generating" state
   * and a Stop control until the reply lands. */
  streaming?: boolean;
}

export interface WsMessageDeleteEvent {
  room_id: string;
  message_id: string;
}

export interface WsRoomUpdateEvent {
  room_id: string;
  name?: string;
  description?: string;
  member_count?: number;
}

/** Someone started a call in a room the user belongs to. */
export interface WsCallStartedEvent {
  room_id: string;
  room_type: "dm" | "group_dm" | "channel";
  room_name: string;
  caller: {
    id: string;
    display_name: string;
  };
  started_at: string;
}

export type WsEventPayload =
  | WsMessageEvent
  | WsTypingEvent
  | WsPresenceEvent
  | WsMessageEditEvent
  | WsMessageDeleteEvent
  | WsRoomUpdateEvent
  | WsCallStartedEvent;

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 35000;

class StableWebSocket {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private _connected = false;
  private lifecycleBound = false;

  get connected(): boolean {
    return this._connected;
  }

  /** Reconnect instantly + re-sync when the page returns to the foreground or
   * the network comes back. Mobile browsers freeze (and often silently kill)
   * WebSockets when a tab is backgrounded or the screen locks, frequently
   * WITHOUT firing `onclose` — so the socket looks "open" but is dead and the
   * app misses live messages until a manual refresh. On resume we force an
   * immediate reconnect (resetting backoff) if it's not truly open, and always
   * emit `resumed` so listeners (useChat) can refetch anything missed. */
  private bindLifecycle(): void {
    if (this.lifecycleBound || typeof document === "undefined") return;
    this.lifecycleBound = true;

    const resume = (): void => {
      if (this.intentionalClose) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Socket appears live — verify with a ping and let listeners resync.
        this.send("ping", {});
        this.emit("resumed", {} as WsEventPayload);
        return;
      }
      // Dead/closing socket: reconnect now rather than waiting out the backoff.
      this.reconnectAttempts = 0;
      this.cancelReconnect();
      this.connect();
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resume();
    });
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
  }

  connect(): void {
    this.bindLifecycle();
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    const token = getToken();
    if (!token) {
      return;
    }

    this.intentionalClose = false;

    // Route the socket at the ACTIVE federated instance (falls back to the
    // build-time base, then same-origin) so a server switch reconnects the WS
    // to the right backend.
    const instance = useFederationStore
      .getState()
      .accessibleInstances.find(
        (item) => item.id === useFederationStore.getState().activeInstanceId,
      );
    const url = instance?.wsUrl
      ? `${instance.wsUrl}${instance.wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._connected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emit("connected", {} as WsEventPayload);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.resetHeartbeatTimeout();

      let parsed: WsMessage;
      try {
        parsed = JSON.parse(event.data as string) as WsMessage;
      } catch {
        return;
      }

      if (parsed.type === "pong") {
        return;
      }

      // Backend events are sometimes framed as { type, payload } (new code)
      // and sometimes flat with fields at top level (legacy typing/presence).
      // Accept both by falling back to the whole message (minus `type`) when
      // `payload` isn't present.
      const raw = parsed as unknown as Record<string, unknown>;
      const payload =
        raw.payload !== undefined
          ? (raw.payload as WsEventPayload)
          : ({ ...raw } as unknown as WsEventPayload);
      this.emit(parsed.type, payload);
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.stopHeartbeat();
      this.emit("disconnected", {} as WsEventPayload);

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    this.cancelReconnect();
    const old = this.ws;
    if (old) {
      // Detach handlers BEFORE closing. A federated server switch does
      // disconnect()+connect() on this singleton; without this, the dead
      // socket's async onclose/onerror/onmessage can still fire afterwards and
      // mutate the NEW socket (onerror closes it), spawn a duplicate reconnect,
      // or emit the old server's buffered messages to the shared listener set —
      // a cross-instance bleed.
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      old.close();
    }
    this.ws = null;
    this._connected = false;
  }

  on(event: string, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  send(type: string, payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  private emit(event: string, data: WsEventPayload): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => cb(data));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.send("ping", {});
      this.heartbeatTimeout = setTimeout(() => {
        this.ws?.close();
      }, HEARTBEAT_TIMEOUT_MS - HEARTBEAT_INTERVAL_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.resetHeartbeatTimeout();
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    // Cap the exponential backoff at the ceiling, then apply FULL JITTER:
    // pick a random delay in [0, cappedExponentialDelay). When a server blip
    // drops many clients at once, deterministic backoff makes them all wake
    // and retry in lockstep — a thundering herd that hammers the server on
    // every attempt. Randomizing spreads the reconnects across the window.
    const cappedExponentialDelay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
    const delay = Math.random() * cappedExponentialDelay;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const ws = new StableWebSocket();
