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
  // Names are historical: "ams" is now the ZOOM AMS-44 interface (preferred)
  // and "driver" the transient phone mic ("AMS Microphone").
  const ams = device("ams", PREFERRED_AUDIO_INPUT_LABEL);
  const driver = device("driver", QUIET_AUDIO_INPUT_LABEL);
  const headset = device("headset", "USB Headset");

  it("pins the ZOOM AMS-44 over the phone's Continuity mic, even if the phone was saved", () => {
    expect(pickAudioInputDevice([driver, ams], "driver")).toBe("ams");
  });

  it("2026-09-12: the interface is the studio mic, the iPhone is not", () => {
    expect(PREFERRED_AUDIO_INPUT_LABEL).toBe("ZOOM AMS-44 Driver");
    expect(QUIET_AUDIO_INPUT_LABEL).toBe("AMS Microphone");
  });

  it("keeps a non-quiet saved pick", () => {
    expect(pickAudioInputDevice([ams, headset], "headset")).toBe("headset");
  });

  it("falls back to the first device when nothing matches", () => {
    expect(pickAudioInputDevice([driver], undefined)).toBe("driver");
  });

  // 2026-09-12: Aaron's call captured deviceId "default" (an OS-default
  // alias, label "Default - <name>"), which slipped past the label check.
  const defaultAlias = device("default", `Default - ${QUIET_AUDIO_INPUT_LABEL}`);

  it("sees through the 'Default - …' alias to the transient phone mic", () => {
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
  it("warns when the phone mic is selected and the ZOOM AMS-44 is available", () => {
    const warning = quietMicWarning({
      selectedLabel: QUIET_AUDIO_INPUT_LABEL,
      hasPreferredAlternative: true,
      level: 0.4,
      sampledMs: 100,
    });
    expect(warning).toContain(PREFERRED_AUDIO_INPUT_LABEL);
    expect(warning).toContain("phone");
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
