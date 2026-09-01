/**
 * Talk-gate signal — the "<agent> can hear you" chip's state machine.
 *
 * The gate is broadcast-only (the server stores nothing — gateway.py
 * /talk-gate), so the store owns every way the chip can end: the close
 * frame, hang-up / call-switch, and the safety timeout for a LOST close
 * frame — the failure mode that would otherwise pin "the agent can hear
 * you" on screen forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchTalkGate,
  setActiveCallRoom,
  TALK_GATE_SAFETY_TIMEOUT_MS,
  useCallUiStore,
} from "./callUiStore";

const ROOM = "room-1";

beforeEach(() => {
  vi.useFakeTimers();
  setActiveCallRoom(null);
  useCallUiStore.setState({ talkGate: { open: false, by: null } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("talk_gate frames", () => {
  it("an open frame shows the gate with its holder", () => {
    setActiveCallRoom(ROOM);
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    expect(useCallUiStore.getState().talkGate).toEqual({
      open: true,
      by: "rook",
    });
  });

  it("a close frame clears it and cancels the safety timer", () => {
    setActiveCallRoom(ROOM);
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    dispatchTalkGate({ type: "talk_gate", open: false, by: "rook" });
    expect(useCallUiStore.getState().talkGate).toEqual({
      open: false,
      by: null,
    });
    // The dead timer must not fire into a LATER open (no ghost close).
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    vi.advanceTimersByTime(TALK_GATE_SAFETY_TIMEOUT_MS - 1);
    expect(useCallUiStore.getState().talkGate.open).toBe(true);
  });

  it("an open frame's target rides along and dies with the close", () => {
    setActiveCallRoom(ROOM);
    dispatchTalkGate({
      type: "talk_gate",
      open: true,
      by: "pedal",
      target: "agent-grok",
    });
    expect(useCallUiStore.getState().talkGate).toEqual({
      open: true,
      by: "pedal",
      target: "agent-grok",
    });
    dispatchTalkGate({ type: "talk_gate", open: false, by: "pedal" });
    expect(useCallUiStore.getState().talkGate.target).toBeUndefined();
    // The next un-targeted press must not inherit the old target.
    dispatchTalkGate({ type: "talk_gate", open: true, by: "pedal" });
    expect(useCallUiStore.getState().talkGate).toEqual({
      open: true,
      by: "pedal",
    });
  });

  it("a close while already closed is a state no-op", () => {
    const before = useCallUiStore.getState().talkGate;
    dispatchTalkGate({ type: "talk_gate", open: false, by: "rook" });
    expect(useCallUiStore.getState().talkGate).toBe(before);
  });
});

describe("safety timeout (lost close frame)", () => {
  it("clears the gate after the timeout with no close frame", () => {
    setActiveCallRoom(ROOM);
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    vi.advanceTimersByTime(TALK_GATE_SAFETY_TIMEOUT_MS - 1);
    expect(useCallUiStore.getState().talkGate.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useCallUiStore.getState().talkGate).toEqual({
      open: false,
      by: null,
    });
  });

  it("a re-asserted open extends the deadline instead of stacking timers", () => {
    setActiveCallRoom(ROOM);
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    vi.advanceTimersByTime(TALK_GATE_SAFETY_TIMEOUT_MS - 5_000);
    // Pedal still held — the gateway re-sends open.
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    // Past the ORIGINAL deadline: the fresh timer must own the gate.
    vi.advanceTimersByTime(10_000);
    expect(useCallUiStore.getState().talkGate.open).toBe(true);
    vi.advanceTimersByTime(TALK_GATE_SAFETY_TIMEOUT_MS);
    expect(useCallUiStore.getState().talkGate.open).toBe(false);
  });
});

describe("call lifecycle", () => {
  it("hang-up clears the gate", () => {
    setActiveCallRoom(ROOM);
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    setActiveCallRoom(null);
    expect(useCallUiStore.getState().talkGate).toEqual({
      open: false,
      by: null,
    });
  });

  it("a call-switch clears it, and the OLD call's timer can't close the new gate", () => {
    setActiveCallRoom(ROOM);
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    vi.advanceTimersByTime(TALK_GATE_SAFETY_TIMEOUT_MS - 10_000);

    setActiveCallRoom("room-2"); // switch tears down the old call's signal
    expect(useCallUiStore.getState().talkGate.open).toBe(false);

    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    // Cross the old call's would-be deadline: only the fresh timer counts.
    vi.advanceTimersByTime(20_000);
    expect(useCallUiStore.getState().talkGate.open).toBe(true);
    vi.advanceTimersByTime(TALK_GATE_SAFETY_TIMEOUT_MS);
    expect(useCallUiStore.getState().talkGate.open).toBe(false);
  });

  it("resetForServer clears the gate", () => {
    setActiveCallRoom(ROOM);
    dispatchTalkGate({ type: "talk_gate", open: true, by: "rook" });
    useCallUiStore.getState().resetForServer();
    expect(useCallUiStore.getState().talkGate).toEqual({
      open: false,
      by: null,
    });
    // Its timer went with it — nothing left to fire.
    expect(vi.getTimerCount()).toBe(0);
  });
});
