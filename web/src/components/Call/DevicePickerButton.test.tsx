import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevicePickerButton } from "./DevicePickerButton";

function dev(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

const AMS_MIC = dev("audioinput", "ams", "ZOOM AMS-44 Driver");
const MICS = [
  dev("audioinput", "default", "Default - ZOOM AMS-44 Driver"),
  AMS_MIC,
  dev("audioinput", "pods", "Aaron's AirPods Pro (Bluetooth)"),
];
const DESK_SPEAKER = dev("audiooutput", "default", "Default - Studio Desk");
const SPEAKERS = [
  DESK_SPEAKER,
  dev("audiooutput", "pods-out", "Aaron's AirPods Pro (Bluetooth)"),
];

function renderMicChevron(opts: {
  mics?: MediaDeviceInfo[];
  speakers?: MediaDeviceInfo[];
  selectedMic?: string;
  selectedSpeaker?: string;
  onSelect?: (kind: string, id: string) => Promise<void>;
}) {
  const onSelect = opts.onSelect ?? vi.fn(async () => {});
  render(
    <DevicePickerButton
      kind="audioinput"
      devices={opts.mics ?? MICS}
      selected={opts.selectedMic ?? "ams"}
      also={[
        {
          kind: "audiooutput",
          devices: opts.speakers ?? SPEAKERS,
          selected: opts.selectedSpeaker ?? "default",
        },
      ]}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

afterEach(() => cleanup());

describe("DevicePickerButton: one audio menu for mic and speaker", () => {
  it("lists the microphones and the speakers under their own headings", () => {
    renderMicChevron({});
    const trigger = screen.getByRole("button", { name: "Choose microphone and speaker" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "microphone and speaker devices" });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Microphone" })).toBeInTheDocument();
    const speakers = screen.getByRole("group", { name: "Speaker" });
    expect(speakers).toBeInTheDocument();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(MICS.length + SPEAKERS.length);
    // Each section marks its own current device.
    const checked = screen
      .getAllByRole("menuitemradio", { checked: true })
      .map((el) => el.textContent);
    expect(checked).toEqual(["ZOOM AMS-44 Driver", "Default - Studio Desk"]);
  });

  it("switches the speaker without touching the microphone", async () => {
    const onSelect = renderMicChevron({});
    fireEvent.click(screen.getByRole("button", { name: /Choose microphone/ }));
    // The AirPods appear in both sections (a mic and a speaker); pick the speaker row.
    const speakers = within(screen.getByRole("group", { name: "Speaker" }));
    fireEvent.click(
      speakers.getByRole("menuitemradio", { name: "Aaron's AirPods Pro (Bluetooth)" }),
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledWith("audiooutput", "pods-out");
    // The menu closes after a successful switch.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("tells the speaker 'default' apart from the microphone 'default' (Chrome gives both the same id)", async () => {
    const onSelect = renderMicChevron({ selectedMic: "default", selectedSpeaker: "pods-out" });
    fireEvent.click(screen.getByRole("button", { name: /Choose microphone/ }));
    // The speaker row named "Default - Studio Desk" is NOT the selected speaker,
    // so clicking it must switch the speaker even though the selected mic has id "default".
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Default - Studio Desk" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("audiooutput", "default"));
    expect(onSelect).not.toHaveBeenCalledWith("audioinput", expect.anything());
  });

  it("leaves the speaker section out when the browser exposes no output devices", () => {
    renderMicChevron({ speakers: [] });
    const trigger = screen.getByRole("button", { name: "Choose microphone" });
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "Microphone" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Speaker" })).not.toBeInTheDocument();
  });

  it("still offers the menu when only the speakers have a choice, and shows the lone mic", () => {
    renderMicChevron({ mics: [AMS_MIC], selectedMic: "ams" });
    fireEvent.click(screen.getByRole("button", { name: "Choose microphone and speaker" }));
    expect(screen.getByRole("group", { name: "Microphone" })).toHaveTextContent("ZOOM AMS-44 Driver");
    expect(screen.getByRole("group", { name: "Speaker" })).toBeInTheDocument();
  });

  it("renders nothing when no section has two devices to choose from", () => {
    renderMicChevron({ mics: [AMS_MIC], speakers: [DESK_SPEAKER] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the single-kind behaviour for the camera chevron", () => {
    const onSelect = vi.fn(async () => {});
    render(
      <DevicePickerButton
        kind="videoinput"
        devices={[dev("videoinput", "kiyo", "Razer Kiyo Pro Ultra"), dev("videoinput", "cont", "iPhone Camera")]}
        selected="kiyo"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose camera" }));
    expect(screen.getByRole("menu", { name: "camera devices" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Speaker" })).not.toBeInTheDocument();
  });
});
