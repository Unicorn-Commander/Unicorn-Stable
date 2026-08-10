import { describe, expect, it } from "vitest";
import {
  ACK_TIMEOUT_ERROR,
  MAX_AUTOMATIC_SEND_ATTEMPTS,
  PendingSendTracker,
  SEND_ACK_TIMEOUT_MS,
  SendFlow,
  type SendOutcome,
  ackedSendMetadata,
  autoRetryRemaining,
  clientMsgIdOf,
  failedSendMetadata,
  isRetryableSendError,
  newClientMsgId,
  optimisticIdFor,
  pendingSendMetadata,
  type TrackedSend,
} from "./sendPipeline";

/** Deterministic clock + timer harness — the tracker takes these injected, so
 *  the ACK/timeout race is exercised exactly as it runs, without real time. */
function harness(opts: { timeoutMs?: number } = {}) {
  let nowMs = 1_000_000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextHandle = 1;
  const timedOut: TrackedSend[] = [];

  const tracker = new PendingSendTracker({
    timeoutMs: opts.timeoutMs ?? SEND_ACK_TIMEOUT_MS,
    now: () => nowMs,
    schedule: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { fn, at: nowMs + ms });
      return handle;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
    onTimeout: (send) => {
      timedOut.push(send);
    },
  });

  /** Advance the clock, firing any timers whose deadline passed. */
  function advance(ms: number) {
    nowMs += ms;
    for (const [handle, timer] of [...timers.entries()]) {
      if (timer.at <= nowMs) {
        timers.delete(handle);
        timer.fn();
      }
    }
  }

  /** Advance the clock WITHOUT firing timers — a sleeping phone: wall time
   *  moves, setTimeout does not. */
  function freezeAdvance(ms: number) {
    nowMs += ms;
  }

  return { tracker, advance, freezeAdvance, timedOut, timerCount: () => timers.size };
}

const send = (n: number, roomId = "room-1") => ({
  roomId,
  clientMsgId: `cid-${n}`,
  optimisticId: optimisticIdFor(`cid-${n}`),
  request: { content: `message ${n}` },
});

describe("PendingSendTracker", () => {
  it("ACK before the deadline resolves the send and disarms its timer", () => {
    const h = harness();
    h.tracker.begin(send(1));
    expect(h.tracker.get("cid-1")?.state).toBe("pending");

    const acked = h.tracker.ack("cid-1");
    expect(acked?.clientMsgId).toBe("cid-1");
    expect(h.timerCount()).toBe(0);

    // Way past the deadline: nothing fires, nothing is failed.
    h.advance(SEND_ACK_TIMEOUT_MS * 3);
    expect(h.timedOut).toHaveLength(0);
    expect(h.tracker.get("cid-1")).toBeUndefined();
  });

  it("double-ACK reports only the first as the resolving call", () => {
    // POST 2xx and the WS echo race; whichever lands second must see null so
    // the reconcile is applied exactly once.
    const h = harness();
    h.tracker.begin(send(1));
    expect(h.tracker.ack("cid-1")).not.toBeNull();
    expect(h.tracker.ack("cid-1")).toBeNull();
  });

  it("no ACK inside the window fires onTimeout with the send already failed", () => {
    const h = harness();
    h.tracker.begin(send(1));

    h.advance(SEND_ACK_TIMEOUT_MS - 1);
    expect(h.timedOut).toHaveLength(0);

    h.advance(1);
    expect(h.timedOut).toHaveLength(1);
    expect(h.timedOut[0]!.clientMsgId).toBe("cid-1");
    expect(h.tracker.get("cid-1")?.state).toBe("failed");
  });

  it("POST rejection fails a pending send exactly once", () => {
    const h = harness();
    h.tracker.begin(send(1));

    const failed = h.tracker.fail("cid-1");
    expect(failed?.state).toBe("failed");
    // Timer disarmed: the timeout must not re-fail (and re-toast) later.
    h.advance(SEND_ACK_TIMEOUT_MS * 2);
    expect(h.timedOut).toHaveLength(0);
    // A second rejection (or a timeout racing in) finds nothing pending.
    expect(h.tracker.fail("cid-1")).toBeNull();
  });

  it("a rejection after the echo already ACKed is ignored — the server has it", () => {
    // The POST's TCP connection died after the server persisted; the echo
    // ACKed the send. The late rejection must NOT mark the bubble failed.
    const h = harness();
    h.tracker.begin(send(1));
    expect(h.tracker.ack("cid-1")).not.toBeNull();
    expect(h.tracker.fail("cid-1")).toBeNull();
  });

  it("a late ACK after timeout still resolves — server persistence is ground truth", () => {
    const h = harness();
    h.tracker.begin(send(1));
    h.advance(SEND_ACK_TIMEOUT_MS);
    expect(h.tracker.get("cid-1")?.state).toBe("failed");

    // The original POST finally lands: the bubble upgrades to delivered.
    expect(h.tracker.ack("cid-1")).not.toBeNull();
    expect(h.tracker.get("cid-1")).toBeUndefined();
  });

  it("retry re-begins the SAME clientMsgId: pending again, attempts counted, timer re-armed", () => {
    const h = harness();
    h.tracker.begin(send(1));
    h.advance(SEND_ACK_TIMEOUT_MS); // → failed
    expect(h.timedOut).toHaveLength(1);

    const retried = h.tracker.begin(send(1));
    expect(retried.state).toBe("pending");
    expect(retried.attempts).toBe(2);

    // The retry times out too — a second visible failure, not silence.
    h.advance(SEND_ACK_TIMEOUT_MS);
    expect(h.timedOut).toHaveLength(2);

    // Third attempt ACKs.
    h.tracker.begin(send(1));
    expect(h.tracker.get("cid-1")?.attempts).toBe(3);
    expect(h.tracker.ack("cid-1")).not.toBeNull();
  });

  it("sweepOverdue fails pending sends whose deadline passed while timers were frozen", () => {
    // Phone slept mid-send: wall clock advanced, setTimeout never fired. On
    // WS reconnect the sweep must surface the stranded send as failed —
    // this is the "unACKed sends must not vanish" reconnect guarantee.
    const h = harness();
    h.tracker.begin(send(1));
    h.freezeAdvance(SEND_ACK_TIMEOUT_MS + 5_000);

    expect(h.timedOut).toHaveLength(0); // frozen timer never fired
    const swept = h.tracker.sweepOverdue("room-1");
    expect(swept.map((s) => s.clientMsgId)).toEqual(["cid-1"]);
    expect(h.tracker.get("cid-1")?.state).toBe("failed");
    // The sweep returns the sends for the caller to mark; the timer callback
    // must not ALSO fire for them later.
    h.advance(1);
    expect(h.timedOut).toHaveLength(0);
  });

  it("sweepOverdue leaves fresh pending sends alone and scopes by room", () => {
    const h = harness();
    h.tracker.begin(send(1, "room-1"));
    h.freezeAdvance(SEND_ACK_TIMEOUT_MS + 1);
    h.tracker.begin(send(2, "room-1")); // fresh — inside the window
    h.tracker.begin(send(3, "room-2")); // other room, also overdue later
    h.freezeAdvance(1);

    const swept = h.tracker.sweepOverdue("room-1");
    expect(swept.map((s) => s.clientMsgId)).toEqual(["cid-1"]);
    expect(h.tracker.get("cid-2")?.state).toBe("pending");
    expect(h.tracker.get("cid-3")?.state).toBe("pending");
  });

  it("ack/fail on an unknown clientMsgId are no-ops", () => {
    const h = harness();
    expect(h.tracker.ack("nope")).toBeNull();
    expect(h.tracker.fail("nope")).toBeNull();
  });

  it("pendingFor lists only that room's pending sends", () => {
    const h = harness();
    h.tracker.begin(send(1, "room-1"));
    h.tracker.begin(send(2, "room-2"));
    h.tracker.begin(send(3, "room-1"));
    h.tracker.fail("cid-3");

    expect(h.tracker.pendingFor("room-1").map((s) => s.clientMsgId)).toEqual([
      "cid-1",
    ]);
  });
});

describe("send metadata transitions", () => {
  it("pending → failed → retrying(pending) → acked keeps the bubble truthful at each step", () => {
    const cid = "cid-x";
    const request = { content: "hello", thread_id: undefined };

    const pending = pendingSendMetadata({ attachments: [] }, cid);
    expect(pending.pending).toBe(true);
    expect(pending.failed).toBe(false);
    expect(pending.client_msg_id).toBe(cid);

    const failed = failedSendMetadata(pending, "Not delivered", request);
    expect(failed.pending).toBe(false);
    expect(failed.failed).toBe(true);
    expect(failed.failed_error).toBe("Not delivered");
    expect(failed.failed_request).toEqual(request);
    expect(failed.client_msg_id).toBe(cid); // retry replays the SAME id

    const retrying = pendingSendMetadata(failed, cid);
    expect(retrying.pending).toBe(true);
    expect(retrying.failed).toBe(false);
    expect(retrying.failed_error).toBeNull();

    const acked = ackedSendMetadata(retrying, { client_msg_id: cid, via: null });
    expect(acked.pending).toBe(false);
    expect(acked.failed).toBe(false);
    expect(acked.failed_request).toBeNull();
    expect(acked.client_msg_id).toBe(cid);
  });

  it("ackedSendMetadata lets server metadata win but never resurrects local-only flags", () => {
    const acked = ackedSendMetadata(
      { pending: true, failed: true, failed_error: "x", local_note: 1 },
      { server_field: "y" },
    );
    expect(acked).toMatchObject({
      pending: false,
      failed: false,
      failed_error: null,
      failed_request: null,
      local_note: 1,
      server_field: "y",
    });
  });

  it("clientMsgIdOf reads only real string ids", () => {
    expect(clientMsgIdOf({ metadata: { client_msg_id: "abc" } })).toBe("abc");
    expect(clientMsgIdOf({ metadata: { client_msg_id: "" } })).toBeNull();
    expect(clientMsgIdOf({ metadata: { client_msg_id: 7 } })).toBeNull();
    expect(clientMsgIdOf({ metadata: {} })).toBeNull();
    expect(clientMsgIdOf({ metadata: null })).toBeNull();
  });

  it("newClientMsgId + optimisticIdFor produce unique, prefixed bubble ids", () => {
    const a = newClientMsgId();
    const b = newClientMsgId();
    expect(a).not.toBe(b);
    expect(optimisticIdFor(a)).toBe(`optimistic-${a}`);
    expect(optimisticIdFor(a).startsWith("optimistic-")).toBe(true);
  });
});

describe("automatic-retry policy", () => {
  it("no HTTP response (network drop / abort deadline) and 5xx are retryable", () => {
    expect(isRetryableSendError({ status: 0, message: "Request timed out" })).toBe(true);
    expect(isRetryableSendError({ status: 500 })).toBe(true);
    expect(isRetryableSendError({ status: 503 })).toBe(true);
    // Non-ApiError rejections are the network layer's (fetch's TypeError).
    expect(isRetryableSendError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableSendError(undefined)).toBe(true);
  });

  it("a real HTTP refusal is NOT retryable — replaying it replays the refusal", () => {
    expect(isRetryableSendError({ status: 403, detail: "muted" })).toBe(false);
    expect(isRetryableSendError({ status: 422 })).toBe(false);
    // 429 explicitly asks us to back off; an instant replay is exactly wrong.
    expect(isRetryableSendError({ status: 429 })).toBe(false);
  });

  it("exactly one automatic retry: attempts 1 has it, attempts 2 does not", () => {
    const at = (attempts: number): TrackedSend => ({
      roomId: "r",
      clientMsgId: "c",
      optimisticId: optimisticIdFor("c"),
      request: { content: "x" },
      startedAt: 0,
      attempts,
      state: "pending",
    });
    expect(autoRetryRemaining(at(1))).toBe(true);
    expect(autoRetryRemaining(at(MAX_AUTOMATIC_SEND_ATTEMPTS))).toBe(false);
  });
});

/* ------------------------------------------------------------------------
 * SendFlow — the four scenarios the silent-loss bug demands, exercised
 * against the REAL state machine with an injected POST + clock.
 * ---------------------------------------------------------------------- */

interface FlowPost {
  send: TrackedSend;
  resolve: (serverMessage: unknown) => void;
  reject: (err: unknown) => void;
}

function flowHarness(opts: { timeoutMs?: number } = {}) {
  let nowMs = 5_000_000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextHandle = 1;
  const posts: FlowPost[] = [];
  const acked: Array<{ send: TrackedSend; serverMessage: unknown }> = [];
  const failed: Array<{ send: TrackedSend; error: string }> = [];

  const flow = new SendFlow({
    timeoutMs: opts.timeoutMs ?? SEND_ACK_TIMEOUT_MS,
    now: () => nowMs,
    schedule: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { fn, at: nowMs + ms });
      return handle;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
    post: (send) =>
      new Promise((resolve, reject) => {
        posts.push({ send, resolve, reject });
      }),
    onAcked: (send, serverMessage) => acked.push({ send, serverMessage }),
    onFailed: (send, error) => failed.push({ send, error }),
  });

  /** Let settled post promises run their continuations. */
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  /** Advance the injected clock, firing due timers, then flush. */
  async function advance(ms: number) {
    nowMs += ms;
    for (const [handle, timer] of [...timers.entries()]) {
      if (timer.at <= nowMs) {
        timers.delete(handle);
        timer.fn();
      }
    }
    await flush();
  }

  /** Wall clock moves, timers do NOT fire — a suspended tab. */
  function freezeAdvance(ms: number) {
    nowMs += ms;
  }

  const identity = (n: number, roomId = "room-1") => ({
    roomId,
    clientMsgId: `cid-${n}`,
    optimisticId: optimisticIdFor(`cid-${n}`),
    request: { content: `message ${n}` },
  });

  return { flow, posts, acked, failed, advance, freezeAdvance, flush, identity };
}

/** Outcome promise → resolved value or "pending", without awaiting forever. */
async function outcomeOf(p: Promise<SendOutcome>): Promise<SendOutcome | "pending"> {
  return Promise.race([
    p,
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 0)),
  ]);
}

describe("SendFlow", () => {
  it("confirmed send: POST 2xx ACKs, reconciles once, outcome=acked, no failure ever", async () => {
    const h = flowHarness();
    const outcome = h.flow.dispatch(h.identity(1));

    expect(h.posts).toHaveLength(1);
    h.posts[0]!.resolve({ id: "srv-1" });
    await h.flush();

    expect(await outcomeOf(outcome)).toBe("acked");
    expect(h.acked).toHaveLength(1);
    expect(h.acked[0]!.serverMessage).toEqual({ id: "srv-1" });
    expect(h.failed).toHaveLength(0);
    // Deadline disarmed: nothing fires later.
    await h.advance(SEND_ACK_TIMEOUT_MS * 3);
    expect(h.failed).toHaveLength(0);
    expect(h.posts).toHaveLength(1);
  });

  it("REST-failure send: one automatic replay of the SAME client_msg_id, then a visible failure", async () => {
    const h = flowHarness();
    const outcome = h.flow.dispatch(h.identity(1));

    h.posts[0]!.reject({ status: 0, message: "Request timed out", detail: "The server did not respond in time." });
    await h.flush();

    // The retry is automatic, immediate, and replays the same id.
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]!.send.clientMsgId).toBe("cid-1");
    expect(h.posts[1]!.send.attempts).toBe(2);
    expect(await outcomeOf(outcome)).toBe("pending"); // not declared yet
    expect(h.failed).toHaveLength(0);

    h.posts[1]!.reject({ status: 0, message: "Request timed out", detail: "The server did not respond in time." });
    await h.flush();

    expect(await outcomeOf(outcome)).toBe("failed");
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.error).toBe("The server did not respond in time.");
    expect(h.failed[0]!.send.attempts).toBe(2);
  });

  it("a deterministic HTTP refusal fails visibly at once — no blind replay", async () => {
    const h = flowHarness();
    const outcome = h.flow.dispatch(h.identity(1));

    h.posts[0]!.reject({ status: 403, message: "Forbidden", detail: "You are muted in this room." });
    await h.flush();

    expect(h.posts).toHaveLength(1);
    expect(await outcomeOf(outcome)).toBe("failed");
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.error).toBe("You are muted in this room.");
  });

  it("timeout send: black-holed request → deadline retries once → second deadline declares failed; a late 2xx still upgrades", async () => {
    const h = flowHarness();
    const outcome = h.flow.dispatch(h.identity(1));

    // Nothing settles. The ACK deadline spends the automatic retry.
    await h.advance(SEND_ACK_TIMEOUT_MS);
    expect(h.posts).toHaveLength(2);
    expect(h.failed).toHaveLength(0);

    // The retry black-holes too: the second deadline declares, visibly.
    await h.advance(SEND_ACK_TIMEOUT_MS);
    expect(h.posts).toHaveLength(2);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.error).toBe(ACK_TIMEOUT_ERROR);
    expect(await outcomeOf(outcome)).toBe("failed");

    // The ORIGINAL request finally lands: server persistence is ground truth,
    // the reconcile upgrades the bubble — and no new attempt is spawned.
    h.posts[0]!.resolve({ id: "srv-late" });
    await h.flush();
    expect(h.acked).toHaveLength(1);
    expect(h.posts).toHaveLength(2);
  });

  it("send-while-disconnected: the POST rejects at the network layer and the send fails VISIBLY after its replay", async () => {
    const h = flowHarness();
    const outcome = h.flow.dispatch(h.identity(1));

    h.posts[0]!.reject(new TypeError("Failed to fetch"));
    await h.flush();
    expect(h.posts).toHaveLength(2); // the one automatic replay
    h.posts[1]!.reject(new TypeError("Failed to fetch"));
    await h.flush();

    expect(await outcomeOf(outcome)).toBe("failed");
    expect(h.failed).toHaveLength(1); // failed pill + toast: never a silent drop
    expect(h.failed[0]!.error).toBe("Failed to fetch");
  });

  it("stale rejection of a superseded attempt cannot fail the newer attempt", async () => {
    const h = flowHarness();
    const outcome = h.flow.dispatch(h.identity(1));

    // Deadline fires while POST #1 is still in flight → automatic retry owns
    // the send now.
    await h.advance(SEND_ACK_TIMEOUT_MS);
    expect(h.posts).toHaveLength(2);

    // POST #1 finally rejects — attempt guard must ignore it: no failure
    // declared, no third attempt spawned.
    h.posts[0]!.reject(new TypeError("Failed to fetch"));
    await h.flush();
    expect(h.failed).toHaveLength(0);
    expect(h.posts).toHaveLength(2);

    // The retry succeeds: delivered.
    h.posts[1]!.resolve({ id: "srv-1" });
    await h.flush();
    expect(await outcomeOf(outcome)).toBe("acked");
    expect(h.failed).toHaveLength(0);
  });

  it("an external ACK (WS echo / resync) resolves the send; the in-flight POST's later rejection is ignored", async () => {
    const h = flowHarness();
    const outcome = h.flow.dispatch(h.identity(1));

    // The echo carrying our client_msg_id arrives before the POST settles.
    expect(h.flow.ack("cid-1")).not.toBeNull();
    expect(await outcomeOf(outcome)).toBe("acked");

    // The POST's connection then dies. The server HAS the message — nothing
    // may mark it failed, nothing may replay it.
    h.posts[0]!.reject(new TypeError("Failed to fetch"));
    await h.flush();
    expect(h.failed).toHaveLength(0);
    expect(h.posts).toHaveLength(1);
  });

  it("manual retry (re-dispatch) gets no second automatic replay — one tap, one attempt", async () => {
    const h = flowHarness();
    const first = h.flow.dispatch(h.identity(1));
    h.posts[0]!.reject({ status: 403, detail: "nope" });
    await h.flush();
    expect(await outcomeOf(first)).toBe("failed");

    const second = h.flow.dispatch(h.identity(1));
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]!.send.attempts).toBe(2);
    h.posts[1]!.reject({ status: 0, message: "Request timed out" });
    await h.flush();

    expect(h.posts).toHaveLength(2); // retryable error, but the budget is spent
    expect(await outcomeOf(second)).toBe("failed");
    expect(h.failed).toHaveLength(2); // each declaration was visible
  });

  it("sweepOverdue declares stranded sends failed visibly — and never replays them", async () => {
    // A suspended tab: the deadline timer never fired, wall time moved on.
    const h = flowHarness();
    const outcome = h.flow.dispatch(h.identity(1));
    h.freezeAdvance(SEND_ACK_TIMEOUT_MS + 60_000);

    const swept = h.flow.sweepOverdue();
    expect(swept.map((s) => s.clientMsgId)).toEqual(["cid-1"]);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.error).toBe(ACK_TIMEOUT_ERROR);
    expect(await outcomeOf(outcome)).toBe("failed");
    // No hidden replay from a sweep — the original POST is the only one.
    await h.flush();
    expect(h.posts).toHaveLength(1);
  });
});
