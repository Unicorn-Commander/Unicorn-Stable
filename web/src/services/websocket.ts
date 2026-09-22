import {
  getToken,
  forceRefreshToken,
  getAuthSessionState,
  isAccessTokenUsable,
} from "./auth";
import { useFederationStore } from "@/stores/federationStore";
import { useAppStore } from "@/stores/appStore";

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
    /** "guest" for a room guest — see RoomMember.participant_type. */
    sender_type: "human" | "agent" | "system" | "guest";
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

/**
 * A HUMAN is typing. Distinct on purpose from `agent_typing` / `agent_relay`
 * (see lib/agentStatus.ts): those assert that an agent is genuinely generating
 * a reply, or that a gateway bridge has an uncollected message. "A person has
 * their hands on a keyboard" is a third, different fact, and the three must
 * never be rendered as one state.
 *
 * Identity mirrors the presence convention: the server sends the Participant
 * UUID as `participant_id` and repeats it as `user_id`, because the Keycloak id
 * never equals the participant UUID and room members resolve on the latter.
 */
export interface WsTypingEvent {
  room_id: string;
  /** Canonical identity (Participant.id). */
  participant_id?: string;
  /** Mirror of participant_id — what the typing hook has always read. */
  user_id: string;
  username: string;
  /** Always "human" from this event; present so an unexpected value can be
   * filtered rather than trusted. */
  participant_type?: "human" | "agent";
  is_typing: boolean;
  /** The server's own key lifetime. The client derives its last-resort local
   * expiry from this so the two can't drift apart. */
  ttl_seconds?: number;
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
  /**
   * Server call id. OPTIONAL on the type, required in practice from the
   * producer added alongside this field (api/calls.py). It is optional here
   * because this event's shape predates any producer at all, and a receiver
   * that cannot accept an id-less frame would be asserting something about a
   * server it has not met. With no id the banner degrades to join/dismiss —
   * accept/decline are server transitions and need one.
   */
  call_id?: string;
  room_id: string;
  room_type: "dm" | "group_dm" | "channel";
  room_name: string;
  caller: {
    id: string;
    display_name: string;
    /** Added with the ringing producer: the callee must see WHO is calling. */
    avatar_url?: string | null;
  };
  started_at: string;
  /** Server's ring deadline. Client timers derive from this — see the note in
   *  incomingCallStore — so the two ends share ONE clock. */
  expires_at?: string;
  ring_timeout_seconds?: number;
}

/** Caller-side outcome of a ring. Delivered on `user:{participant_id}`. */
export interface WsCallRingStateEvent {
  call_id: string;
  room_id: string;
  /** accepted | declined | canceled | timeout */
  state: string;
  by: { id: string | null; display_name: string | null } | null;
}

/** Callee-side "stop ringing" — fans out to EVERY device of that identity. */
export interface WsCallResolvedEvent {
  call_id: string;
  room_id: string;
  /** accepted | declined | canceled | timeout */
  reason: string;
  by_participant_id: string | null;
}

/**
 * Room-scoped occupancy fact from the server's LiveKit webhook: somebody
 * joined or left a room's call, and this is the occupancy AFTER that change.
 * Distinct on purpose from `call_started` (a RING — "someone is calling YOU",
 * delivered per-user): this event carries no offer and must never raise the
 * incoming-call banner. It feeds the shared live-calls source of truth
 * (sidebar badges / in-room banner / cross-room toast — see useLiveCalls).
 */
export interface WsCallOccupancyEvent {
  room_id: string;
  room_type: "dm" | "group_dm" | "channel";
  room_name: string;
  /** Occupancy after the join/leave. 0 ⇒ the call ended. */
  participant_count: number;
  has_agent?: boolean;
  /** Who JOINED (participant-id space). null/absent on leaves. */
  by?: { id: string | null; display_name: string | null } | null;
}

export type WsEventPayload =
  | WsMessageEvent
  | WsTypingEvent
  | WsPresenceEvent
  | WsMessageEditEvent
  | WsMessageDeleteEvent
  | WsRoomUpdateEvent
  | WsCallStartedEvent
  | WsCallRingStateEvent
  | WsCallResolvedEvent
  | WsCallOccupancyEvent;

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 35000;
/**
 * How long a socket may sit in CONNECTING before we abandon it.
 *
 * connect() treats CONNECTING as busy (overwriting `this.ws` mid-handshake
 * orphans a live socket whose handlers still fire), which means a socket that
 * NEVER completes its handshake — the classic mobile case, where the tab is
 * backgrounded mid-connect and the browser freezes the socket without ever
 * firing onopen or onclose — would block every future connect() forever.
 * startHeartbeat() only runs on onopen, so the heartbeat cannot watchdog this.
 * Nothing else would. Hence an explicit handshake deadline.
 */
const HANDSHAKE_TIMEOUT_MS = 8000;

/**
 * After this many consecutive handshake timeouts, alternate between the
 * configured wsUrl and the same-origin `/ws` fallback on every further pair of
 * attempts. This exists because a CDN/proxy in front of ONE of the two paths
 * can stall WebSocket upgrades indefinitely while the other path is healthy —
 * observed 2026-07-31: Chrome switched to HTTP/3 via Alt-Svc and Cloudflare
 * then hung every WS extended-CONNECT in CONNECTING forever, while a direct
 * (non-proxied) host completed instantly. Alternating means neither a broken
 * CDN path nor a broken bypass host can permanently strand the client.
 */
const TRANSPORT_FLIP_AFTER_TIMEOUTS = 2;

/**
 * How long after `onopen` the server gets to answer the auth frame with
 * `auth_ok`. The token now travels in the FIRST FRAME, not the URL: real
 * uchub access tokens overflow a query string (uvicorn silently never answers
 * a request line past ~8 KiB, so the handshake just hangs), and a frame also
 * keeps the token out of URLs, access logs, and proxy buffers.
 */
const AUTH_ACK_TIMEOUT_MS = 8000;
/**
 * Hard deadline on the token refresh.
 *
 * keycloak-js `updateToken()` issues a bare `fetch()` to the token endpoint
 * with NO timeout of its own, and the browser's own network timeout is many
 * minutes (or never, if the TCP connection stays open). So a Keycloak that
 * HANGS rather than fails — connection accepted, response never written, which
 * is exactly how the IdP host wedged on 2026-07-21 — leaves the awaited promise
 * pending forever. Without this deadline the connect attempt never settles, the
 * `connecting` guard never releases, no socket is ever opened and no retry is
 * ever armed: permanently, silently offline. That is the ORIGINAL bug, so the
 * refresh path gets an explicit bound.
 */
const REFRESH_TIMEOUT_MS = 15000;
/**
 * Backstop deadline on the `connecting` guard itself.
 *
 * `connecting` suppresses every subsequent connect() while an attempt is in
 * flight, so a stuck flag is indistinguishable from "permanently offline with
 * no explanation". Every await on the connect path is individually bounded
 * above, which SHOULD make this unreachable — but "should be unreachable" is
 * what the last two attempts assumed about their own hang, so the flag carries
 * a watchdog that can always force it back to false and re-arm a retry. Set
 * comfortably past REFRESH_TIMEOUT_MS so it never pre-empts the normal path.
 */
const CONNECT_GUARD_TIMEOUT_MS = REFRESH_TIMEOUT_MS + 5000;
/**
 * Consecutive failed connect attempts before the reconnecting banner escalates
 * to an actionable "sign in again" surface (`auth_stalled`).
 *
 * Retrying stays armed — this only UPGRADES what the user is told. A transient
 * "reconnecting…" is honest for a few seconds; after this many failures it is
 * no longer an accurate account of what the user is experiencing, and they need
 * an escape hatch. Deliberately NOT terminal: unlike `auth_expired`, the socket
 * keeps trying, so a Keycloak or backend that recovers on its own still heals
 * without the user touching anything.
 */
const STALL_ESCALATION_ATTEMPTS = 5;

/** Resolution sentinel for a refresh that blew its deadline. */
const REFRESH_TIMED_OUT = Symbol("refresh-timed-out");

class StableWebSocket {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive CONNECTING-state timeouts; drives the transport alternation
   * (see TRANSPORT_FLIP_AFTER_TIMEOUTS). Reset the moment any socket opens. */
  private handshakeTimeouts = 0;
  /** What actually failed most recently: token acquisition ("auth") or the
   * socket/transport ("transport"). The stalled banner uses this to say the
   * true thing — "Session refresh failed" over a healthy network sends the
   * user to re-login for a problem sign-in cannot fix. */
  private lastFailureCause: "auth" | "transport" = "transport";
  /** Watchdog for an OPEN socket awaiting `auth_ok` — see AUTH_ACK_TIMEOUT_MS. */
  private authAckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Watchdog for a socket stuck in CONNECTING — see HANDSHAKE_TIMEOUT_MS. */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private _connected = false;
  private lifecycleBound = false;
  /** True from the moment connect() starts acquiring a token until a socket
   * exists (or the attempt is abandoned). connect() acquires its token
   * ASYNCHRONOUSLY, so without this flag two callers — e.g. a scheduled
   * reconnect landing on the same tick as a `focus` resume — would each await
   * and then each assign `this.ws`, orphaning the first socket with its
   * handlers still attached (its onclose would spawn a second reconnect loop). */
  private connecting = false;
  /** Watchdog that force-releases `connecting` — see CONNECT_GUARD_TIMEOUT_MS. */
  private connectGuardTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive connect attempts that produced no open socket. Reset on
   * onopen. Drives the `auth_stalled` escalation only; the retry schedule is
   * driven by `reconnectAttempts`. */
  private failedAttempts = 0;
  /** True once `auth_stalled` has been emitted, so it is emitted once per
   * outage rather than on every subsequent retry. */
  private stalled = false;
  /** Bumped by disconnect(). An in-flight connect attempt captures the value
   * at entry and abandons itself if it no longer matches, so a federated server
   * switch during token acquisition can never open a socket to the OLD server. */
  private connectGeneration = 0;
  /** Terminal state: the refresh token itself is dead, so no retry can ever
   * succeed. We stop reconnecting and surface it (see the `auth_expired` event)
   * instead of looping invisibly. Only a fresh login clears it, which is a full
   * page navigation — so there is no in-app path that silently resumes. */
  private authExpired = false;

  get connected(): boolean {
    return this._connected;
  }

  /** The refresh token is dead — the user must sign in again. Listeners render
   * this; nothing in-app clears it. */
  get sessionExpired(): boolean {
    return this.authExpired;
  }

  /** Reconnecting, but it has been failing long enough that the user should be
   * offered a sign-in escape hatch. Retries are still running — this is a
   * message upgrade, not a terminal state. */
  get connectionStalled(): boolean {
    return this.stalled;
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
        // Socket appears live — but a backgrounded tab's socket is often a
        // zombie the browser still reports OPEN (frozen with the tab, upstream
        // long gone, onclose never fired). Verify with a DEADLINED ping: if
        // nothing comes back inside the pong window the probe tears it down
        // and reconnects (see probeLiveness). Listeners resync either way.
        // Pre-auth sockets are skipped — the auth-ack watchdog owns that phase.
        if (this._connected) {
          this.probeLiveness(this.ws, this.connectGeneration);
        }
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

  /**
   * Open the socket, ALWAYS with a token that is still valid.
   *
   * This is the fix for the "Stable went offline but the server was fine" bug
   * class. The old code read `getToken()` synchronously and handed whatever was
   * cached to the server. Keycloak's token is kept fresh by a 30s `setInterval`
   * in auth.ts, but browsers throttle and then fully suspend timers in
   * backgrounded tabs and on a sleeping laptop — so the token lapses. The
   * server then rejected the handshake, `onclose` fired, `scheduleReconnect()`
   * ran `connect()` again WITH THE SAME EXPIRED TOKEN, and the loop could never
   * converge (1,613 `jwt_validation_failed` in two hours, zero restarts). The
   * page still rendered at HTTP 200, so it looked online while nothing was live.
   *
   * Synchronous entry point is preserved because scheduleReconnect(), the
   * resume handler and external callers all fire-and-forget it. The actual work
   * is async and guarded — see `connecting` and `connectGeneration`.
   */
  /**
   * User-initiated recovery from the stalled banner. Clears the stall latch,
   * cancels a pending reconnect timer, and starts a fresh connect attempt
   * with a forced token refresh — without a full page reload / login.
   */
  manualReconnect(): void {
    this.authExpired = false;
    this.stalled = false;
    this.failedAttempts = 0;
    this.reconnectAttempts = 0;
    this.cancelReconnect();
    this.clearAuthAckTimeout();
    // The old socket's heartbeat must not survive it: a leftover probe
    // deadline would fire against whatever socket is current by then.
    this.stopHeartbeat();
    // Force a new generation so any in-flight open is abandoned.
    this.connectGeneration++;
    this.endConnecting();
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this._connected = false;
    this.connect();
  }

  connect(): void {
    this.bindLifecycle();
    // Dead session: retrying cannot help and would hammer Keycloak. The
    // `auth_expired` surface is already up.
    if (this.authExpired) return;
    // CONNECTING counts as busy: overwriting `this.ws` mid-handshake orphans a
    // live socket whose handlers still fire.
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    if (this.connecting) return;

    // connect() IS the intent to be connected. Clearing the flag here (rather
    // than only after a token is in hand) means a connect attempt that has to
    // back off does not leave `intentionalClose` set — which would make the
    // focus/online resume handler no-op for the whole outage.
    this.intentionalClose = false;
    this.beginConnecting();
    void this.openWithValidToken(this.connectGeneration);
  }

  /**
   * Claim the connect guard AND arm its watchdog in one place, so the flag can
   * never be set without something able to clear it.
   */
  private beginConnecting(): void {
    this.connecting = true;
    this.clearConnectGuard();
    const generation = this.connectGeneration;
    this.connectGuardTimer = setTimeout(() => {
      this.connectGuardTimer = null;
      if (!this.connecting) return;
      if (generation !== this.connectGeneration) return;
      // Reaching here means an await on the connect path did not settle inside
      // its own bound. Release the guard and re-arm a retry rather than sit
      // wedged: no path may end with no socket and nothing pending.
      this.connecting = false;
      this.retryLater(generation);
    }, CONNECT_GUARD_TIMEOUT_MS);
  }

  private endConnecting(): void {
    this.connecting = false;
    this.clearConnectGuard();
  }

  private clearConnectGuard(): void {
    if (this.connectGuardTimer) {
      clearTimeout(this.connectGuardTimer);
      this.connectGuardTimer = null;
    }
  }

  /**
   * Bound a promise. Resolves with REFRESH_TIMED_OUT if `promise` has not
   * settled within `ms`; the original promise is left to settle (or not) on its
   * own — abandoning it is the point, and keycloak-js owns its own internal
   * refresh queue, so we must not reject into it.
   */
  private withDeadline<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<T | typeof REFRESH_TIMED_OUT> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(REFRESH_TIMED_OUT);
      }, ms);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error as Error);
        },
      );
    });
  }

  /**
   * A connect attempt failed WITHOUT producing a socket. Make it visible and
   * make sure something is pending.
   *
   * The `disconnected` emit matters as much as the retry: `onclose` is what
   * normally tells the UI the connection is down, and on this path no socket
   * ever existed, so onclose never fires. Every earlier version fell straight
   * into scheduleReconnect() here — which retries invisibly, leaving the app
   * rendering at HTTP 200 with no banner and no live data. That is precisely
   * the symptom this whole fix exists to eliminate, so it is centralised here
   * and every socket-less failure path routes through it.
   */
  private retryLater(generation: number): void {
    if (generation !== this.connectGeneration) return;
    this._connected = false;
    this.failedAttempts++;
    this.emit("disconnected", {} as WsEventPayload);
    if (this.failedAttempts >= STALL_ESCALATION_ATTEMPTS && !this.stalled) {
      // Upgrade the message, do NOT stop retrying — see STALL_ESCALATION_ATTEMPTS.
      this.stalled = true;
      this.emit("auth_stalled", {
        cause: this.lastFailureCause,
      } as unknown as WsEventPayload);
    }
    this.scheduleReconnect();
  }

  /**
   * Acquire a definitely-valid token, then open the socket.
   *
   * A reconnect is evidence that the cached access token may be unusable, even
   * when keycloak-js's local clock says otherwise. Force-refresh here
   * (`updateToken(-1)`) so a sleeping/mobile tab or clock skew cannot replay the
   * exact token the backend already rejected. Reconnects are exceptional, and
   * keycloak-js coalesces genuinely concurrent refreshes through its queue.
   */
  private async openWithValidToken(generation: number): Promise<void> {
    try {
      let token: string | null = null;
      try {
        const result = await this.withDeadline(
          forceRefreshToken(),
          REFRESH_TIMEOUT_MS,
        );
        if (result === REFRESH_TIMED_OUT) {
          // Keycloak hung. ONLY reuse the cache if it is still usable — opening
          // the socket with a known-expired access token is what produced the
          // "Session refresh failed" stall loop (backend ws_auth_failed/expired
          // every ~15s). Prefer backoff + retry over burning failedAttempts.
          token = getToken();
          if (!isAccessTokenUsable(token)) {
            this.retryLater(generation);
            return;
          }
        } else {
          token = result;
          // Null from forceRefresh means not authenticated / unusable after
          // refresh. Fall back to cache only when it still has life left.
          if (!isAccessTokenUsable(token)) {
            const cached = getToken();
            token = isAccessTokenUsable(cached) ? cached : null;
          }
        }
      } catch {
        // The refresh itself failed. keycloak-js clears the token on a 400
        // (invalid_grant) — i.e. the refresh token is genuinely dead — but
        // leaves it in place for a transient network failure.
        if (getAuthSessionState() === "expired") {
          this.failSession(generation);
          return;
        }
        const cached = getToken();
        if (!isAccessTokenUsable(cached)) {
          // No usable access token and refresh failed: back off, do NOT open
          // a socket we know the server will reject as expired.
          this.retryLater(generation);
          return;
        }
        token = cached;
      }

      if (generation !== this.connectGeneration) return;
      // Final gate: never attach a socket with an unusable access token.
      if (!isAccessTokenUsable(token)) {
        token = null;
      }
      if (!token) {
        // forceRefreshToken() resolved NULL rather than throwing. The original
        // author read this as "always transient" on the belief that
        // keycloak-js `clearToken()` leaves `authenticated` true, so a dead
        // session would converge on the throwing branch above within a tick.
        // It does not: keycloak.js:1591 sets `authenticated = false` (verified
        // against the installed 26.2.3). auth.ts `refreshInstanceToken()` then
        // short-circuits on `!client?.authenticated` and resolves null WITHOUT
        // EVER CALLING updateToken() — so on a cleared session this branch is
        // not a transient stop on the way to the terminal state, it IS the
        // permanent destination. Falling through to scheduleReconnect() re-arms
        // the timer forever: no socket, no `auth_expired`, no banner. That is
        // the original silent-offline bug wearing a new hat, and strictly
        // harder to diagnose because not even a failed handshake shows up.
        //
        // Reachable whenever the auth.ts 30s refresh interval or
        // client.onTokenExpired takes the 400 before this code does — nothing
        // arbitrates that race.
        //
        // So distinguish the two causes at the source instead of guessing:
        // "expired" means the client finished init() and is now unauthenticated
        // — unrecoverable without a real login. Anything else (no active
        // instance yet, or a client still initialising, e.g. a federated switch
        // mid-flight) genuinely is transient and must keep retrying, or a boot
        // race would strand the user behind a false "session expired".
        if (getAuthSessionState() === "expired") {
          this.failSession(generation);
          return;
        }
        this.retryLater(generation);
        return;
      }

      this.intentionalClose = false;

      // Route the socket at the ACTIVE federated instance (falls back to the
      // build-time base, then same-origin) so a server switch reconnects the WS
      // to the right backend. Read AFTER the await so a switch that lands
      // during token acquisition is honoured rather than raced.
      const instance = useFederationStore
        .getState()
        .accessibleInstances.find(
          (item) => item.id === useFederationStore.getState().activeInstanceId,
        );
      const sameOrigin = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
      const configured = instance?.wsUrl || sameOrigin;
      // Normally use the configured endpoint. Once handshakes have timed out
      // TRANSPORT_FLIP_AFTER_TIMEOUTS times in a row, alternate between the
      // two candidate paths every further pair of attempts so one stalled
      // middlebox path cannot strand the client (see the constant's comment).
      let base = configured;
      if (
        configured !== sameOrigin &&
        this.handshakeTimeouts >= TRANSPORT_FLIP_AFTER_TIMEOUTS &&
        Math.floor(this.handshakeTimeouts / TRANSPORT_FLIP_AFTER_TIMEOUTS) % 2 === 1
      ) {
        base = sameOrigin;
      }
      // No token in the URL — it goes in the first frame (see
      // AUTH_ACK_TIMEOUT_MS). Real access tokens are far past the size where
      // query-string transport is survivable.
      const url = base;

      try {
        this.attach(new WebSocket(url), generation, token);
      } catch {
        // The WebSocket constructor throws on a malformed URL (a bad
        // instance.wsUrl). Previously this propagated out of a synchronous
        // connect(); now it would be swallowed by the fire-and-forget caller
        // and leave the app stalled with no socket and no pending retry —
        // silently offline, the very failure this change exists to remove.
        this.retryLater(generation);
      }
    } catch {
      // Nothing above is expected to throw past its own handler, but an
      // unexpected throw here would abandon the attempt with no socket and
      // nothing pending — silently offline. Catch it and retry visibly.
      this.retryLater(generation);
    } finally {
      // Only release the guard if we still own it. A disconnect()+connect()
      // that landed during the await has already handed ownership to a newer
      // attempt, and clearing the flag here would corrupt its state.
      if (generation === this.connectGeneration) this.endConnecting();
    }
  }

  /**
   * The session cannot be recovered without a real login. Stop reconnecting —
   * a silent infinite retry is exactly the invisible-failure mode this fix
   * exists to remove — and tell listeners so the UI can say so.
   */
  private failSession(generation: number): void {
    if (generation !== this.connectGeneration) return;
    this.authExpired = true;
    this.cancelReconnect();
    this._connected = false;
    this.emit("auth_expired", {} as WsEventPayload);
  }

  /**
   * Is `socket` still THE socket? Handlers fire asynchronously and a socket
   * that has been superseded (a reconnect, or a federated server switch) can
   * still deliver events long after; acting on them corrupts the state of the
   * socket that actually is current.
   */
  private owns(socket: WebSocket, generation: number): boolean {
    return this.ws === socket && generation === this.connectGeneration;
  }

  /** Abandon a socket that never finishes its handshake — see HANDSHAKE_TIMEOUT_MS. */
  private startHandshakeTimeout(socket: WebSocket, generation: number): void {
    this.clearHandshakeTimeout();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (!this.owns(socket, generation)) return;
      if (socket.readyState !== WebSocket.CONNECTING) return;
      this.handshakeTimeouts++;
      this.lastFailureCause = "transport";
      // Detach BEFORE closing: a frozen socket may fire onclose much later (or
      // never). Doing the recovery here rather than relying on close() means
      // we are not depending on an event from a socket we know is wedged.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Already torn down by the browser — nothing to do.
      }
      this.ws = null;
      // retryLater (not a bare scheduleReconnect): a socket that never opened
      // never fires onclose, so without the `disconnected` emit this recovery
      // would be completely invisible to the banner.
      this.retryLater(generation);
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private clearHandshakeTimeout(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /** Abandon a socket whose auth frame the server never answered — a legacy
   * backend that expects query-param tokens, or a middlebox that ate the
   * frame. Without this the socket would sit OPEN-but-dead: no `auth_ok`
   * ever emits "connected", yet nothing closes it or schedules a retry. */
  private startAuthAckTimeout(socket: WebSocket, generation: number): void {
    this.clearAuthAckTimeout();
    this.authAckTimer = setTimeout(() => {
      this.authAckTimer = null;
      if (!this.owns(socket, generation)) return;
      if (this._connected) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already torn down */
      }
      this.ws = null;
      this.lastFailureCause = "transport";
      this.retryLater(generation);
    }, AUTH_ACK_TIMEOUT_MS);
  }

  private clearAuthAckTimeout(): void {
    if (this.authAckTimer) {
      clearTimeout(this.authAckTimer);
      this.authAckTimer = null;
    }
  }

  private attach(socket: WebSocket, generation: number, token: string): void {
    this.ws = socket;
    this.clearAuthAckTimeout();
    this.startHandshakeTimeout(socket, generation);

    socket.onopen = () => {
      if (!this.owns(socket, generation)) return;
      this.clearHandshakeTimeout();
      this.handshakeTimeouts = 0;
      // The transport is up but the socket is NOT usable yet: the server has
      // not judged the token. Send the auth frame and wait for `auth_ok` —
      // everything that used to happen here happens there instead.
      try {
        socket.send(JSON.stringify({ type: "auth", token }));
      } catch {
        try {
          socket.close();
        } catch {
          /* already torn down */
        }
        return;
      }
      this.startAuthAckTimeout(socket, generation);
    };

    socket.onmessage = (event: MessageEvent) => {
      // A stale socket must never emit into the shared listener set — on a
      // federated switch that is a cross-instance message bleed.
      if (!this.owns(socket, generation)) return;
      this.resetHeartbeatTimeout();

      let parsed: WsMessage;
      try {
        parsed = JSON.parse(event.data as string) as WsMessage;
      } catch {
        return;
      }

      if (parsed.type === "auth_ok") {
        // NOW the connection is real: token judged, subscriptions armed
        // server-side. This is the block that used to live in onopen.
        // The ack carries our PARTICIPANT id — the id space room events use
        // for sender_id, distinct from the Keycloak sub — so the app can
        // recognise its own messages (self-toast / self-unread suppression).
        const pid = (parsed as unknown as { participant_id?: string })
          .participant_id;
        if (pid) useAppStore.getState().setCurrentParticipantId(pid);
        this.clearAuthAckTimeout();
        this._connected = true;
        this.reconnectAttempts = 0;
        // The outage is over: clear the escalation so a LATER outage gets the
        // full grace period instead of jumping straight to "sign in again".
        this.failedAttempts = 0;
        this.stalled = false;
        this.startHeartbeat(socket, generation);
        this.emit("connected", {} as WsEventPayload);
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
      // recording_state's contract fields live in the payload. If a producer
      // also stamps room_id on the envelope, keep it — the pill is per room.
      if (
        parsed.type === "recording_state" &&
        payload &&
        typeof payload === "object" &&
        typeof raw.room_id === "string" &&
        !("room_id" in payload)
      ) {
        (payload as { room_id?: string }).room_id = raw.room_id;
      }
      this.emit(parsed.type, payload);
    };

    socket.onclose = (event: CloseEvent) => {
      // 4001/4003/4004 are the server's explicit auth/identity rejections
      // (missing token / auth failed / participant not found) — a re-login can
      // fix those. Anything else (1006 handshake refusal, network drop, proxy
      // stall) is transport: "sign in again" would be a lie.
      this.lastFailureCause =
        event.code === 4001 || event.code === 4003 || event.code === 4004
          ? "auth"
          : "transport";
      // Identity + generation guard. Previously onclose mutated SHARED state
      // (_connected, the 'disconnected' emit, scheduleReconnect) with no check
      // at all, so a superseded socket sitting in CLOSING could fire and
      // declare the app disconnected while the CURRENT socket was open, and
      // queue a redundant reconnect that then races the live one. That was
      // always possible; the async token acquisition widens the window it
      // fires in, so guard it here rather than leave a known race in place.
      if (!this.owns(socket, generation)) return;
      this.clearHandshakeTimeout();
      this.clearAuthAckTimeout();
      this._connected = false;
      this.stopHeartbeat();
      // Count a rejected handshake as a failed attempt too.
      //
      // failedAttempts used to increment ONLY in retryLater(), i.e. only when
      // no socket was ever created. But the most likely real-world auth outage
      // takes the other path: when Keycloak answers 5xx (rather than 400) the
      // token is NOT cleared, so we fall back to the cached stale token, a
      // socket IS opened, and the server rejects it here. That loop is honest
      // and self-healing, but it never escalated — a user could sit on amber
      // "reconnecting…" indefinitely with no "sign in again" escape hatch.
      // onopen resets this to 0, so a healthy reconnect still clears it.
      this.failedAttempts++;
      if (this.failedAttempts >= STALL_ESCALATION_ATTEMPTS && !this.stalled) {
        this.stalled = true;
        this.emit("auth_stalled", {
          cause: this.lastFailureCause,
        } as unknown as WsEventPayload);
      }
      this.emit("disconnected", {} as WsEventPayload);

      if (!this.intentionalClose && !this.authExpired) {
        this.scheduleReconnect();
      }
    };

    // Close THIS socket, not `this.ws` — they can differ, and closing the
    // current one on a stale socket's error would kill a healthy connection.
    socket.onerror = () => {
      socket.close();
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    // Invalidate any connect attempt still awaiting its token, and release the
    // guard so an immediately-following connect() (the federated server switch
    // does disconnect()+connect()) is not swallowed by it.
    this.connectGeneration++;
    this.endConnecting();
    // A switch is a fresh start against a different backend; carrying the old
    // server's failure count over would escalate the new one's first blip
    // straight to "sign in again".
    this.failedAttempts = 0;
    this.stalled = false;
    // `authExpired` is a fact about the session at ONE instance, but it lived
    // on this singleton and nothing ever cleared it. The only caller of
    // disconnect() is federationStore.switchInstance(), which does
    // disconnect() then connect() — so once server A's session died, switching
    // to a perfectly HEALTHY server B hit `if (this.authExpired) return` on the
    // first line of connect() and produced zero sockets plus a "session
    // expired" banner for a server whose session is fine, escapable only by a
    // full page reload. That is a REGRESSION against main, where this path
    // connected normally. The switch re-points auth at the new instance
    // (setActiveAuthInstance) before connect(), so the new instance's session
    // gets judged on its own evidence: if IT is dead too, the token acquisition
    // below re-raises the terminal state within one attempt.
    this.authExpired = false;
    this.stopHeartbeat();
    this.clearHandshakeTimeout();
    this.clearAuthAckTimeout();
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

  /**
   * Fire-and-forget send. Returns whether the frame actually left, which
   * matters for state that must be RETRACTED later: the typing indicator only
   * records "I told the room I'm typing" when the frame really went out, so a
   * send that was dropped on a closed socket can't leave the client believing
   * it owes a `typing_stop` it never has to send (or, worse, skipping the stop
   * it does).
   *
   * Existing callers ignoring the return value are unaffected.
   */
  send(type: string, payload: Record<string, unknown>): boolean {
    // OPEN is necessary but no longer sufficient: between onopen and
    // `auth_ok` the server accepts exactly ONE frame — the auth frame. Any
    // other frame in that window (a resume ping, an eager typing event) would
    // be judged as a bad auth frame and close the socket.
    if (!this._connected) return false;
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type, payload }));
    return true;
  }

  private emit(event: string, data: WsEventPayload): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => cb(data));
    }
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.probeLiveness(socket, generation);
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Send a liveness probe and arm its deadline. ANY inbound frame — the pong,
   * or real traffic — clears the deadline (onmessage calls
   * resetHeartbeatTimeout). If NOTHING arrives, the socket is a zombie: a
   * dead upstream behind a TCP session the browser still reports OPEN.
   *
   * The deadline used to just call `this.ws?.close()` and wait for the
   * browser's onclose to do the real recovery — but on a wedged socket the
   * close handshake gets no answer and onclose can take the transport
   * timeout (up to minutes) to fire. All that time `_connected` stayed true:
   * the Realtime segment said connected, no reconnect was armed, and every
   * live event (incl. the echo-ACK path for sends) silently went nowhere.
   * Now the deadline itself detaches + declares, exactly like the handshake
   * and auth-ack watchdogs above: the state flips to reconnecting
   * immediately, and the reconnect's `connected` event drives the resync +
   * overdue-send sweep.
   */
  private probeLiveness(socket: WebSocket, generation: number): void {
    if (!this.owns(socket, generation)) return;
    this.send("ping", {});
    // Never stack deadlines: a resume-probe landing between heartbeat ticks
    // replaces the armed one (the freshest probe's window is the one that
    // matters — and it can only extend, never shorten, the current window).
    this.resetHeartbeatTimeout();
    this.heartbeatTimeout = setTimeout(() => {
      this.heartbeatTimeout = null;
      if (!this.owns(socket, generation)) return;
      // Detach BEFORE closing — recovery must not depend on an event from a
      // socket we know is wedged (same rationale as startHandshakeTimeout).
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already torn down */
      }
      this.ws = null;
      this.stopHeartbeat();
      this.lastFailureCause = "transport";
      this.retryLater(generation);
    }, HEARTBEAT_TIMEOUT_MS - HEARTBEAT_INTERVAL_MS);
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
