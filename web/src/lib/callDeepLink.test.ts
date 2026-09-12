import { describe, expect, it } from "vitest";
import {
  matchDevice,
  parseCallDeepLink,
  stripCallDeepLinkParams,
} from "./callDeepLink";

describe("parseCallDeepLink", () => {
  it("is null without join=1 — stray params never join a call", () => {
    expect(parseCallDeepLink("")).toBeNull();
    expect(parseCallDeepLink("?mic=AMS%20Microphone")).toBeNull();
    expect(parseCallDeepLink("?join=0&mic=x")).toBeNull();
    expect(parseCallDeepLink("?join=maybe")).toBeNull();
  });

  it("defaults: audio-only, ring on, no device overrides", () => {
    expect(parseCallDeepLink("?join=1")).toEqual({
      kind: "voice",
      mic: null,
      cam: null,
      video: false,
      ring: true,
    });
  });

  it("reads devices (url-decoded), video and ring flags", () => {
    expect(
      parseCallDeepLink(
        "join=1&mic=AMS%20Microphone&cam=Razer%20Kiyo%20Pro&video=1&ring=0",
      ),
    ).toEqual({
      kind: "video",
      mic: "AMS Microphone",
      cam: "Razer Kiyo Pro",
      video: true,
      ring: false,
    });
  });

  it("kind=voice|video picks the call kind; video=1 alone is a video call; kind=video implies the camera", () => {
    expect(parseCallDeepLink("?join=1&kind=video")).toMatchObject({
      kind: "video",
      video: true,
    });
    expect(parseCallDeepLink("?join=1&kind=voice")).toMatchObject({
      kind: "voice",
      video: false,
    });
    expect(parseCallDeepLink("?join=1&video=1")).toMatchObject({ kind: "video" });
    // An explicit camera flag still wins over the kind's default.
    expect(parseCallDeepLink("?join=1&kind=video&video=0")).toMatchObject({
      kind: "video",
      video: false,
    });
    expect(parseCallDeepLink("?join=1&kind=nonsense")).toMatchObject({ kind: "voice" });
    expect(parseCallDeepLink("?join=1&kind=voice&video=1")).toMatchObject({
      kind: "voice",
      video: false,
    });
  });

  it("accepts true/false spellings and ignores garbage flags", () => {
    expect(parseCallDeepLink("?join=true&video=yes&ring=off")).toMatchObject({
      video: true,
      ring: false,
    });
    expect(parseCallDeepLink("?join=1&video=banana&ring=")).toMatchObject({
      video: false,
      ring: true,
    });
  });

  it("treats blank device values as absent", () => {
    expect(parseCallDeepLink("?join=1&mic=%20&cam=")).toMatchObject({
      mic: null,
      cam: null,
    });
  });
});

describe("stripCallDeepLinkParams", () => {
  it("removes every call param and keeps the rest", () => {
    expect(
      stripCallDeepLinkParams("?join=1&mic=a&cam=b&video=1&ring=0&tab=chat"),
    ).toBe("?tab=chat");
    expect(stripCallDeepLinkParams("?join=1")).toBe("");
    expect(stripCallDeepLinkParams("")).toBe("");
  });
});

describe("matchDevice", () => {
  const devices = [
    { deviceId: "default", label: "Default - AMS Microphone (0d8c:0014)" },
    { deviceId: "id-zoom", label: "ZOOM AMS-44 Driver" },
    { deviceId: "id-ams", label: "AMS Microphone (0d8c:0014)" },
    { deviceId: "id-mac", label: "MacBook Pro Microphone (Built-in)" },
  ];

  it("matches by deviceId first", () => {
    expect(matchDevice(devices, "id-mac")?.deviceId).toBe("id-mac");
    expect(matchDevice(devices, "default")?.deviceId).toBe("default");
  });

  it("exact label beats prefix — the AMS mic, not Chrome's Default alias", () => {
    expect(matchDevice(devices, "AMS Microphone (0d8c:0014)")?.deviceId).toBe(
      "id-ams",
    );
  });

  it("starts-with beats contains: 'AMS Microphone' → the AMS device, not Default", () => {
    expect(matchDevice(devices, "AMS Microphone")?.deviceId).toBe("id-ams");
  });

  it("is case-insensitive and falls through to contains", () => {
    expect(matchDevice(devices, "zoom ams-44")?.deviceId).toBe("id-zoom");
    expect(matchDevice(devices, "built-in")?.deviceId).toBe("id-mac");
  });

  it("returns null for nothing / no match", () => {
    expect(matchDevice(devices, null)).toBeNull();
    expect(matchDevice(devices, "  ")).toBeNull();
    expect(matchDevice(devices, "Blue Yeti")).toBeNull();
    expect(matchDevice([], "AMS Microphone")).toBeNull();
  });
});
