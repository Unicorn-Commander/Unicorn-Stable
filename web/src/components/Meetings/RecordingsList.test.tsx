import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type RecordingListItem } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { RecordingsList } from "./RecordingsList";

const ROW: RecordingListItem = {
  id: "rec-1",
  kind: "audio",
  status: "complete",
  started_by: "p-aaron",
  started_at: "2026-09-21T18:00:00Z",
  duration_seconds: 12,
  storage_url: "https://private-storage.example/rec-1.ogg",
  mo_session_id: "mo-1",
  session_url: "https://meetingops.example/sessions/mo-1",
};

function renderList() {
  return render(
    <RecordingsList
      roomId="room-1"
      rows={[ROW]}
      members={[]}
      myRole="owner"
      myParticipantId="p-aaron"
    />,
  );
}

afterEach(() => {
  cleanup();
  while (restores.length > 0) restores.pop()?.();
  useAppStore.setState({ toasts: [] });
});

const restores: Array<() => void> = [];

describe("RecordingsList downloads", () => {
  it("does not render the raw storage address", () => {
    const view = renderList();

    expect(view.container.querySelector(`a[href="${ROW.storage_url}"]`)).toBeNull();
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it("gets a presigned URL when Download is clicked", async () => {
    const download = vi.spyOn(api, "downloadRecording").mockResolvedValue({
      url: "https://signed.example/rec-1.ogg?sig=test",
      expires_in_seconds: 900,
      kind: "audio",
      content_type: "audio/ogg",
    });
    restores.push(() => download.mockRestore());
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    restores.push(() => click.mockRestore());

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(download).toHaveBeenCalledWith("room-1", "rec-1"));
    expect(click).toHaveBeenCalled();
  });

  it("shows the server detail when the download is forbidden", async () => {
    const download = vi.spyOn(api, "downloadRecording").mockRejectedValue({
      status: 403,
      message: "Forbidden",
      detail: "Only the room owner may download this recording",
    });
    restores.push(() => download.mockRestore());

    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
        title: "Couldn't download recording",
        body: "Only the room owner may download this recording",
        kind: "error",
      }),
    );
  });
});
