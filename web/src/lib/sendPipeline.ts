/**
 * The send-ACK pipeline: state + timers for optimistic message sends.
 *
 * Why this exists: a send used to be "POST and hope". The optimistic bubble
 * rendered identically to a delivered message from the moment it was created,
 * and the ONLY thing that could flip it to `failed` was the POST promise
 * rejecting. A request that never settles — proxy black hole, uvicorn's
 * silent >8KiB-header hang, a token refresh that never returns, a laptop lid
 * closing mid-flight — rejected nothing, so the bubble sat there looking
 * delivered forever while the server had persisted nothing. Two DB-verified
 * message losses shipped exactly that way.
 *
 * The contract now:
 *  - every send carries a client-generated `client_msg_id` (the optimistic
 *    bubble's id is derived from it, `optimistic-<client_msg_id>`);
 *  - a send is DELIVERED only when the server acknowledges that id — via the
 *    POST 2xx body or via the WS echo carrying `metadata.client_msg_id`;
 *  - until then the bubble is `pending`; if no ACK lands inside
 *    SEND_ACK_TIMEOUT_MS (or the WS reconnects and the send is overdue) the
 *    bubble becomes `failed` with a Retry that replays the SAME
 *    client_msg_id, which the server dedupes — so a retry after a lost
 *    response can never double-post.
 *
 * Everything here is deliberately framework-free (no React, no store): the
 * tracker takes injectable clock/timer hooks so the state machine is unit
 * tested exactly as it runs.
 */

/** How long a send may sit unacknowledged before it is FAILED visibly.
 *  Long enough for a slow mobile round-trip + one token refresh; short
 *  enough that a black-holed request becomes a Retry affordance while the
 *  user is still looking at the message they just sent. */
export const SEND_ACK_TIMEOUT_MS = 12_000;

/** POST attempts a send may consume before failure is DECLARED: the original
 *  request plus ONE automatic retry. A manual Retry tap re-begins the entry
 *  (attempts keeps counting up), so it deliberately gets no further automatic
 *  retry of its own — one tap, one attempt, a predictable outcome. */
export const MAX_AUTOMATIC_SEND_ATTEMPTS = 2;

/** What the failed pill/toast say when nothing NACKed but nothing ACKed
 *  either — the ACK deadline (or the reconnect sweep) is the failing party. */
export const ACK_TIMEOUT_ERROR =
  "Not delivered — the server never confirmed this message.";

/** The optimistic-id namespace. Every pre-ACK bubble id starts with this —
 *  several call sites (unread divider, new-message counter, mark_read gate)
 *  key off the prefix, so it must stay stable. */
export const OPTIMISTIC_ID_PREFIX = "optimistic-";

/** The request snapshot a retry replays — mirrors the `failed_request`
 *  metadata shape retryMessage has always consumed. */
export interface OutgoingSendRequest {
  content: string;
  thread_id?: string;
  attachments?: {
    url: string;
    filename: string;
    content_type: string;
    size: number;
  }[];
  extraMetadata?: Record<string, unknown>;
  /** Wire content_type of the send. Optional because `failed_request`
   *  snapshots persisted before this field existed lack it — consumers
   *  re-derive it from `attachments` when absent. */
  content_type?: "text" | "action" | "image" | "file";
}

export type PendingSendState = "pending" | "failed";

export interface TrackedSend {
  roomId: string;
  clientMsgId: string;
  optimisticId: string;
  request: OutgoingSendRequest;
  /** ms timestamp of the LATEST attempt (a retry re-stamps it). */
  startedAt: number;
  attempts: number;
  state: PendingSendState;
}

export function newClientMsgId(): string {
  // crypto.randomUUID is universal in the browsers we ship to; the fallback
  // only exists for non-secure LAN contexts (the self-host insecure-context
  // installs) where `crypto.randomUUID` is absent.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

export function optimisticIdFor(clientMsgId: string): string {
  return `${OPTIMISTIC_ID_PREFIX}${clientMsgId}`;
}

/** Read a message's client_msg_id out of its metadata, if it has one. */
export function clientMsgIdOf(message: {
  metadata?: Record<string, unknown> | null;
}): string | null {
  const cid = message.metadata?.client_msg_id;
  return typeof cid === "string" && cid.length > 0 ? cid : null;
}

/* ------------------------------------------------------------------------
 * Metadata transitions. The bubble's visual state lives in message.metadata
 * (that is what MessageBubble reads), so each transition is a pure function
 * from the previous metadata to the next — testable without a store.
 * ---------------------------------------------------------------------- */

/** A fresh (or retrying) send: pending, not failed, carries its ACK id. */
export function pendingSendMetadata(
  base: Record<string, unknown> | null | undefined,
  clientMsgId: string,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    client_msg_id: clientMsgId,
    pending: true,
    failed: false,
    failed_error: null,
  };
}

/** ACKed: the server persisted it. Server metadata wins (it carries the
 *  stamped client_msg_id and anything the server added). */
export function ackedSendMetadata(
  base: Record<string, unknown> | null | undefined,
  serverMetadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(serverMetadata ?? {}),
    pending: false,
    failed: false,
    failed_error: null,
    failed_request: null,
  };
}

/** NACK/timeout: visibly failed, retryable. `failed_request` is the exact
 *  snapshot retryMessage replays (same client_msg_id → server dedupes). */
export function failedSendMetadata(
  base: Record<string, unknown> | null | undefined,
  error: string,
  request: OutgoingSendRequest,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    pending: false,
    failed: true,
    failed_error: error,
    failed_request: request,
  };
}

/* ------------------------------------------------------------------------
 * The tracker: one entry per unresolved send, owning the ACK timeout.
 * ---------------------------------------------------------------------- */

interface TrackerOptions {
  timeoutMs?: number;
  /** Fired when a send crosses the ACK deadline via the armed timer. The
   *  entry has already been transitioned to `failed` when this runs. */
  onTimeout?: (send: TrackedSend) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class PendingSendTracker {
  private readonly sends = new Map<string, TrackedSend>();
  private readonly timers = new Map<string, unknown>();
  private readonly timeoutMs: number;
  private readonly onTimeout?: (send: TrackedSend) => void;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(options: TrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? SEND_ACK_TIMEOUT_MS;
    this.onTimeout = options.onTimeout;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel =
      options.cancel ?? ((handle) => clearTimeout(handle as number));
  }

  /** Start (or restart, on retry) tracking a send and arm its ACK timer. */
  begin(send: {
    roomId: string;
    clientMsgId: string;
    optimisticId: string;
    request: OutgoingSendRequest;
  }): TrackedSend {
    const existing = this.sends.get(send.clientMsgId);
    const entry: TrackedSend = {
      roomId: send.roomId,
      clientMsgId: send.clientMsgId,
      optimisticId: send.optimisticId,
      request: send.request,
      startedAt: this.now(),
      attempts: (existing?.attempts ?? 0) + 1,
      state: "pending",
    };
    this.sends.set(send.clientMsgId, entry);
    this.clearTimer(send.clientMsgId);
    this.timers.set(
      send.clientMsgId,
      this.schedule(() => {
        this.timers.delete(send.clientMsgId);
        // Only a still-pending send can time out; ack/fail already cleared
        // the timer, so reaching here with another state means a stale timer
        // (never with injected timers, but cheap to guard).
        const current = this.sends.get(send.clientMsgId);
        if (!current || current.state !== "pending") return;
        current.state = "failed";
        this.onTimeout?.(current);
      }, this.timeoutMs),
    );
    return entry;
  }

  /**
   * The server confirmed this send (POST 2xx, WS echo, or resync found it).
   * Returns the entry when this call resolved it, null when the send was
   * unknown or already ACKed — callers use that to keep the reconcile
   * idempotent across the three ACK paths racing each other.
   * An ACK always wins, even over `failed`: the server persisting the
   * message is ground truth, a late ACK just upgrades the bubble.
   */
  ack(clientMsgId: string): TrackedSend | null {
    const entry = this.sends.get(clientMsgId);
    if (!entry) return null;
    this.clearTimer(clientMsgId);
    this.sends.delete(clientMsgId);
    return entry;
  }

  /**
   * The POST rejected. Transitions pending → failed and returns the entry;
   * returns null when there was nothing pending — either the timeout beat
   * the rejection (bubble is already failed; don't clobber its copy) or an
   * echo ACKed it first (server persisted despite the failed POST; the
   * bubble must NOT be marked failed).
   */
  fail(clientMsgId: string): TrackedSend | null {
    const entry = this.sends.get(clientMsgId);
    if (!entry || entry.state !== "pending") return null;
    this.clearTimer(clientMsgId);
    entry.state = "failed";
    return entry;
  }

  /**
   * Deadline sweep for the reconnect path. setTimeout freezes while a phone
   * sleeps or a tab is suspended — exactly when sends get stranded — so on
   * WS connected/resumed the caller sweeps: every pending send past the ACK
   * deadline is transitioned to failed and returned for the UI to mark.
   * (Sends inside the window keep their armed timer and stay pending.)
   */
  sweepOverdue(roomId?: string): TrackedSend[] {
    const overdue: TrackedSend[] = [];
    const cutoff = this.now() - this.timeoutMs;
    for (const entry of this.sends.values()) {
      if (roomId !== undefined && entry.roomId !== roomId) continue;
      if (entry.state !== "pending") continue;
      if (entry.startedAt > cutoff) continue;
      this.clearTimer(entry.clientMsgId);
      entry.state = "failed";
      overdue.push(entry);
    }
    return overdue;
  }

  get(clientMsgId: string): TrackedSend | undefined {
    return this.sends.get(clientMsgId);
  }

  pendingFor(roomId: string): TrackedSend[] {
    return [...this.sends.values()].filter(
      (s) => s.roomId === roomId && s.state === "pending",
    );
  }

  forget(clientMsgId: string): void {
    this.clearTimer(clientMsgId);
    this.sends.delete(clientMsgId);
  }

  private clearTimer(clientMsgId: string): void {
    const handle = this.timers.get(clientMsgId);
    if (handle !== undefined) {
      this.cancel(handle);
      this.timers.delete(clientMsgId);
    }
  }
}

/* ------------------------------------------------------------------------
 * Automatic-retry policy.
 * ---------------------------------------------------------------------- */

/** Whether a rejected POST is worth the ONE automatic replay.
 *
 *  Retryable: no HTTP response at all — network drop, our own abort deadline
 *  (`status: 0`), or a non-HTTP rejection (fetch's TypeError) — and server
 *  5xx, where the server may not have processed the send (the client_msg_id
 *  dedupe makes replaying safe either way). NOT retryable: any other real
 *  HTTP answer. A 4xx is the server understanding the request and refusing it
 *  — replaying the identical bytes replays the refusal — and 429 explicitly
 *  asks us to back off, so an instant replay would be exactly wrong. Those
 *  fail visibly at once instead of burning a second ACK window first.
 */
export function isRetryableSendError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return status === 0 || status >= 500;
  }
  return true;
}

/** Does this send still have its automatic retry to spend? */
export function autoRetryRemaining(send: TrackedSend): boolean {
  return send.attempts < MAX_AUTOMATIC_SEND_ATTEMPTS;
}

/* ------------------------------------------------------------------------
 * The send flow: tracker + POST + automatic retry, behind injected effects.
 *
 * useChat used to inline this state machine across sendMessage / retryMessage
 * / the tracker's onTimeout, which meant the ACK/timeout/retry races could
 * only be exercised through the hook. Pulling it here (framework-free,
 * injectable clock/timers/POST) makes the four scenarios that matter —
 * confirmed, REST-failure, timeout, send-while-disconnected — unit-testable
 * exactly as they run in production.
 * ---------------------------------------------------------------------- */

/** How a send ended. `acked` = the server confirmed persisting it (POST 2xx,
 *  WS echo, or resync found it); `failed` = declared visibly failed. A late
 *  ACK can still upgrade a `failed` bubble afterwards — server persistence is
 *  ground truth. */
export type SendOutcome = "acked" | "failed";

/** The identity a dispatch registers — same shape `PendingSendTracker.begin`
 *  takes. */
export interface SendIdentity {
  roomId: string;
  clientMsgId: string;
  optimisticId: string;
  request: OutgoingSendRequest;
}

export interface SendFlowOptions {
  /** Perform the REST POST for this attempt. Resolves with the server's
   *  message on 2xx; rejects on failure. Injected so tests never touch the
   *  network and the hook wires the real api client + store reads. */
  post: (send: TrackedSend) => Promise<unknown>;
  /** The server confirmed this send via OUR POST resolving — reconcile the
   *  optimistic bubble. Runs even when another ACK path (echo/resync) beat
   *  this one, so it MUST be idempotent (the bubble lookup makes it so). */
  onAcked: (send: TrackedSend, serverMessage: unknown) => void;
  /** The send is now DECLARED failed — make it visible (failed pill + toast).
   *  Called exactly once per declaration; a manual retry that fails again is
   *  a new declaration. */
  onFailed: (send: TrackedSend, error: string) => void;
  /** Human-readable message for a rejected POST. */
  describeError?: (err: unknown) => string;
  timeoutMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

function defaultDescribeError(err: unknown): string {
  const apiErr = err as { detail?: string; message?: string } | null;
  return apiErr?.detail || apiErr?.message || "Send failed";
}

export class SendFlow {
  private readonly tracker: PendingSendTracker;
  private readonly opts: SendFlowOptions;
  /** Resolves a dispatch's terminal outcome (see `SendOutcome`). */
  private readonly outcomes = new Map<string, (outcome: SendOutcome) => void>();

  constructor(opts: SendFlowOptions) {
    this.opts = opts;
    this.tracker = new PendingSendTracker({
      timeoutMs: opts.timeoutMs,
      now: opts.now,
      schedule: opts.schedule,
      cancel: opts.cancel,
      // The ACK deadline fired with nothing confirming this send — the exact
      // silent-loss shape (request black-holed, response lost, refresh hung).
      // The entry is already `failed` when this runs; spend the automatic
      // retry if it remains, else declare.
      onTimeout: (send) => {
        if (autoRetryRemaining(send)) {
          this.retry(send);
          return;
        }
        this.declareFailed(send, ACK_TIMEOUT_ERROR);
      },
    });
  }

  /**
   * Register a send (or a manual retry of one) and fire its POST.
   *
   * The returned promise resolves at the send's TERMINAL state — server-
   * confirmed or visibly failed — never rejects, and spans the automatic
   * retry, so callers sequencing "after the send" work (auto-title) can gate
   * it on the outcome instead of firing on attempts that went nowhere.
   */
  dispatch(send: SendIdentity): Promise<SendOutcome> {
    const entry = this.tracker.begin(send);
    const promise = new Promise<SendOutcome>((resolve) => {
      // A re-dispatch of the same clientMsgId (manual retry) replaces the
      // resolver; the superseded promise resolved at ITS terminal state
      // already (failed) — that is what made the retry reachable.
      this.outcomes.set(send.clientMsgId, resolve);
    });
    void this.post(entry);
    return promise;
  }

  /** An ACK from any path (POST 2xx via `post`, WS echo, resync). Resolves
   *  the entry exactly once; later calls return null (idempotent). */
  ack(clientMsgId: string): TrackedSend | null {
    const entry = this.tracker.ack(clientMsgId);
    if (entry) this.settleOutcome(clientMsgId, "acked");
    return entry;
  }

  /**
   * Reconnect-time deadline sweep (see PendingSendTracker.sweepOverdue): every
   * pending send past the ACK window is declared failed HERE — with the same
   * visible effects as a live timeout. No automatic retry from a sweep, on
   * purpose: the sweep runs after an arbitrary suspension (a phone asleep for
   * hours), where a silent replay could land long after the user stopped
   * watching — and past the server's dedupe window, where a replay whose
   * original DID land double-posts. Stranded sends surface as Retry instead.
   */
  sweepOverdue(roomId?: string): TrackedSend[] {
    const swept = this.tracker.sweepOverdue(roomId);
    for (const send of swept) {
      this.declareFailed(send, ACK_TIMEOUT_ERROR);
    }
    return swept;
  }

  get(clientMsgId: string): TrackedSend | undefined {
    return this.tracker.get(clientMsgId);
  }

  pendingFor(roomId: string): TrackedSend[] {
    return this.tracker.pendingFor(roomId);
  }

  private retry(send: TrackedSend): void {
    const retried = this.tracker.begin({
      roomId: send.roomId,
      clientMsgId: send.clientMsgId,
      optimisticId: send.optimisticId,
      request: send.request,
    });
    void this.post(retried);
  }

  private async post(entry: TrackedSend): Promise<void> {
    // The attempt this POST belongs to. A rejection landing after a NEWER
    // attempt took over (the deadline fired mid-flight and auto-retried, or
    // the user tapped Retry) must not touch the newer attempt's state.
    const attemptAtStart = entry.attempts;
    try {
      const serverMessage = await this.opts.post(entry);
      // An ACK always resolves, even over `failed` — the server persisting
      // the message is ground truth and a late 2xx upgrades the bubble.
      this.ack(entry.clientMsgId);
      this.opts.onAcked(entry, serverMessage);
    } catch (err) {
      const current = this.tracker.get(entry.clientMsgId);
      // Already resolved: another path ACKed it (server has it) — a stale
      // rejection must never mark a delivered message failed.
      if (!current) return;
      if (current.attempts !== attemptAtStart) return;
      if (
        current.state === "pending" &&
        autoRetryRemaining(current) &&
        isRetryableSendError(err)
      ) {
        this.retry(current);
        return;
      }
      // Transition pending → failed; null means the deadline beat this
      // rejection and already declared (don't declare twice).
      const settled = this.tracker.fail(entry.clientMsgId);
      if (settled) {
        this.declareFailed(
          settled,
          (this.opts.describeError ?? defaultDescribeError)(err),
        );
      }
    }
  }

  private declareFailed(send: TrackedSend, error: string): void {
    this.opts.onFailed(send, error);
    this.settleOutcome(send.clientMsgId, "failed");
  }

  private settleOutcome(clientMsgId: string, outcome: SendOutcome): void {
    const resolve = this.outcomes.get(clientMsgId);
    if (resolve) {
      this.outcomes.delete(clientMsgId);
      resolve(outcome);
    }
  }
}
