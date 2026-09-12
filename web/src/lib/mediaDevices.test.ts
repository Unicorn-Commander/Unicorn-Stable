import { describe, expect, it } from "vitest";
import {
  pickAudioInputDevice,
  PREFERRED_AUDIO_INPUT_LABEL,
  QUIET_AUDIO_INPUT_LABEL,
  quietMicWarning,
} from "./mediaDevices";

function device(id: string, label: string) {
  return { deviceId: id, label };
}

describe("pickAudioInputDevice", () => {
  const ams = device("ams", PREFERRED_AUDIO_INPUT_LABEL);
  const driver = device("driver", QUIET_AUDIO_INPUT_LABEL);
  const headset = device("headset", "USB Headset");

  it("pins AMS Microphone over the quiet Driver, even if Driver was saved", () => {
    expect(pickAudioInputDevice([driver, ams], "driver")).toBe("ams");
  });

  it("keeps a non-quiet saved pick", () => {
    expect(pickAudioInputDevice([ams, headset], "headset")).toBe("headset");
  });

  it("falls back to the first device when nothing matches", () => {
    expect(pickAudioInputDevice([driver], undefined)).toBe("driver");
  });

  // 2026-09-12: Aaron's call captured deviceId "default" = macOS default =
  // the Driver; the relay heard digital silence. Chrome lists that alias as
  // "Default - ZOOM AMS-44 Driver", which slipped past the label check.
  const defaultAlias = device("default", `Default - ${QUIET_AUDIO_INPUT_LABEL}`);

  it("sees through the 'Default - …' alias to the quiet Driver", () => {
    expect(pickAudioInputDevice([defaultAlias, driver, ams], "default")).toBe("ams");
    expect(pickAudioInputDevice([defaultAlias, driver, ams], undefined)).toBe("ams");
  });

  it("never keeps a saved OS-default alias when the preferred mic is present", () => {
    const defaultIsAms = device("default", `Default - ${PREFERRED_AUDIO_INPUT_LABEL}`);
    expect(pickAudioInputDevice([defaultIsAms, ams, driver], "default")).toBe("ams");
  });

  it("still honours a saved alias when there is no preferred mic", () => {
    const defaultHeadset = device("default", "Default - USB Headset");
    expect(pickAudioInputDevice([defaultHeadset, headset], "default")).toBe("default");
  });
});

describe("quietMicWarning", () => {
  it("warns when the Driver is selected and AMS Microphone is available", () => {
    const warning = quietMicWarning({
      selectedLabel: QUIET_AUDIO_INPUT_LABEL,
      hasPreferredAlternative: true,
      level: 0.4,
      sampledMs: 100,
    });
    expect(warning).toContain(PREFERRED_AUDIO_INPUT_LABEL);
    expect(warning).toContain("14 dB");
  });

  it("warns when the meter stays near-silent", () => {
    const warning = quietMicWarning({
      selectedLabel: "USB Headset",
      hasPreferredAlternative: false,
      level: 0.01,
      sampledMs: 3000,
    });
    expect(warning).toMatch(/very quiet/i);
  });

  it("is silent when the preferred mic is selected and the meter is moving", () => {
    expect(
      quietMicWarning({
        selectedLabel: PREFERRED_AUDIO_INPUT_LABEL,
        hasPreferredAlternative: true,
        level: 0.2,
        sampledMs: 3000,
      }),
    ).toBeNull();
  });
});
