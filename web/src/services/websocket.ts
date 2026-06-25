import { getToken } from "./auth";

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
  user_id: string;
  username: string;
  is_online: boolean;
  last_seen: string;
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

export type WsEventPayload =
  | WsMessageEvent
  | WsTypingEvent
  | WsPresenceEvent
  | WsMessageEditEvent
  | WsMessageDeleteEvent
  | WsRoomUpdateEvent;

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

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    const token = getToken();
    if (!token) {
      return;
    }

    this.intentionalClose = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = import.meta.env.VITE_API_BASE_URL
      ? new URL(import.meta.env.VITE_API_BASE_URL).host
      : window.location.host;

    const url = `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`;

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
    this.ws?.close();
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
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
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
