/**
 * Voice-relay frames on the room data channel — `talk_gate` (the external
 * pedal held/released) and `relay_config` (the activation mode changed).
 * Both are server-broadcast; the decoder must accept the well-formed shapes
 * and return null (never throw) for malformed or unknown traffic, because
 * the DataReceived handler treats null as "not ours, ignore silently".
 */
import { describe, expect, it } from "vitest";
import {
  coerceVoiceActivationMode,
  decodeRoomData,
  encodeRoomData,
  isRelayConfigMessage,
  isTalkGateMessage,
  isVoiceActivationMode,
  VOICE_ACTIVATION_MODES,
} from "./roomDataProtocol";

const encode = (v: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(v));

describe("talk_gate decoding", () => {
  it("decodes a well-formed open frame", () => {
    const msg = decodeRoomData(
      encode({ type: "talk_gate", open: true, by: "rook" }),
    );
    expect(msg).toEqual({ type: "talk_gate", open: true, by: "rook" });
  });

  it("decodes a close frame", () => {
    const msg = decodeRoomData(
      encode({ type: "talk_gate", open: false, by: "rook" }),
    );
    expect(msg).toEqual({ type: "talk_gate", open: false, by: "rook" });
  });

  it("rejects a frame with a non-boolean open or missing by", () => {
    expect(
      decodeRoomData(encode({ type: "talk_gate", open: "yes", by: "rook" })),
    ).toBeNull();
    expect(decodeRoomData(encode({ type: "talk_gate", open: true }))).toBeNull();
    expect(isTalkGateMessage({ type: "talk_gate", open: 1, by: "x" })).toBe(
      false,
    );
    expect(isTalkGateMessage(null)).toBe(false);
  });

  it("round-trips through encodeRoomData", () => {
    const frame = { type: "talk_gate", open: true, by: "pedal-1" } as const;
    expect(decodeRoomData(encodeRoomData(frame))).toEqual(frame);
  });

  it("carries an optional target (E04 pedal-to-agent) and rejects a non-string one", () => {
    const frame = {
      type: "talk_gate",
      open: true,
      by: "pedal-1",
      target: "agent-grok",
    } as const;
    expect(decodeRoomData(encodeRoomData(frame))).toEqual(frame);
    expect(
      isTalkGateMessage({ type: "talk_gate", open: true, by: "x", target: 7 }),
    ).toBe(false);
  });
});

describe("relay_config decoding", () => {
  it("decodes every known activation mode", () => {
    for (const mode of VOICE_ACTIVATION_MODES) {
      const msg = decodeRoomData(
        encode({ type: "relay_config", activation: mode, by: "uuid-1" }),
      );
      expect(msg).toEqual({
        type: "relay_config",
        activation: mode,
        by: "uuid-1",
      });
    }
  });

  it("rejects an unknown mode — the room refetch reconciles instead", () => {
    expect(
      decodeRoomData(
        encode({ type: "relay_config", activation: "psychic", by: "u" }),
      ),
    ).toBeNull();
    expect(
      isRelayConfigMessage({ type: "relay_config", activation: 3, by: "u" }),
    ).toBe(false);
    expect(
      isRelayConfigMessage({ type: "relay_config", activation: "name" }),
    ).toBe(false);
  });
});

describe("channel hygiene for the new types", () => {
  it("still returns null (no throw) for unknown types and malformed bytes", () => {
    expect(decodeRoomData(encode({ type: "future_thing" }))).toBeNull();
    expect(decodeRoomData(new TextEncoder().encode("not json"))).toBeNull();
    expect(decodeRoomData(encode(null))).toBeNull();
  });

  it("does not shadow the existing families", () => {
    const transcript = {
      type: "transcript",
      participantId: "p",
      name: "N",
      text: "hi",
      isFinal: true,
      ts: 1,
    };
    expect(decodeRoomData(encode(transcript))).toEqual(transcript);
  });
});

describe("activation-mode coercion", () => {
  it("accepts the closed union and nothing else", () => {
    for (const mode of VOICE_ACTIVATION_MODES) {
      expect(isVoiceActivationMode(mode)).toBe(true);
    }
    expect(isVoiceActivationMode("NAME")).toBe(false);
    expect(isVoiceActivationMode(undefined)).toBe(false);
  });

  it("degrades absent/unknown to the server default 'name'", () => {
    expect(coerceVoiceActivationMode(undefined)).toBe("name");
    expect(coerceVoiceActivationMode("drifted-mode")).toBe("name");
    expect(coerceVoiceActivationMode("ptt")).toBe("ptt");
  });
});
