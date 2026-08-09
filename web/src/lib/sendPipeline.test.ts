import { describe, expect, it } from "vitest";
import {
  PendingSendTracker,
  SEND_ACK_TIMEOUT_MS,
  ackedSendMetadata,
  clientMsgIdOf,
  failedSendMetadata,
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
