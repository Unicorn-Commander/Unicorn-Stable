import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GuestMessage, GuestRoomMember } from "@/services/guestApi";
import { GuestParticipantRow } from "./GuestChrome";
import { GuestMessageRow } from "./GuestRoom";

afterEach(cleanup);

/**
 * The rows as the server sends them to a GUEST caller: availability and its
 * reason are null on every row, an agent's metadata is `{kind}` alone, and a
 * message's metadata has no `gateway`, `on_behalf_of` or `agent_id`.
 */
const HOST: GuestRoomMember = {
  participant_id: "p-aaron",
  username: "aaron",
  display_name: "Aaron Stransky",
  participant_type: "human",
  is_online: true,
  availability: null,
  availability_reason: null,
  metadata: null,
};
const SEAT: GuestRoomMember = {
  participant_id: "p-persephone",
  username: "agent-persephone",
  display_name: "Persephone",
  participant_type: "agent",
  is_online: false,
  availability: null,
  availability_reason: null,
  metadata: { kind: null },
};
const GUEST_AGENT: GuestRoomMember = {
  participant_id: "p-flow",
  username: "flow",
  display_name: "Flow",
  participant_type: "agent",
  is_online: false,
  availability: null,
  availability_reason: null,
  metadata: { kind: "guest_agent" },
};
const ME: GuestRoomMember = {
  participant_id: "p-guest",
  username: "guest-1",
  display_name: "Morgan",
  participant_type: "guest",
  is_online: true,
  is_self: true,
  availability: null,
  availability_reason: null,
  metadata: null,
};
const ROSTER = [HOST, SEAT, GUEST_AGENT, ME];

function message(over: Partial<GuestMessage>): GuestMessage {
  return {
    id: "m-1",
    room_id: "room-1",
    sender_id: "p-persephone",
    sender_type: "agent",
    sender_name: "Persephone",
    sender_avatar: null,
    content: "The portal is up.",
    content_type: "text",
    created_at: "2026-09-29T01:00:00Z",
    ...over,
  };
}

describe("the guest roster with a guest's rows", () => {
  it("draws every row with null availability and {kind}-only metadata", () => {
    render(
      <ul>
        {ROSTER.map((member) => (
          <GuestParticipantRow key={member.participant_id} member={member} />
        ))}
      </ul>,
    );
    expect(screen.getByText("Aaron Stransky")).toBeTruthy();
    expect(screen.getByText("Persephone")).toBeTruthy();
    expect(screen.getByText("Flow")).toBeTruthy();
    expect(screen.getByText("Morgan")).toBeTruthy();
    // Agents are marked from participant_type, which a guest does get.
    expect(screen.getAllByText("AI")).toHaveLength(2);
    expect(screen.getByText("(you)")).toBeTruthy();
  });
});

describe("the guest transcript with a guest's messages", () => {
  it("draws an agent's line whose metadata has no gateway, on_behalf_of or agent_id", () => {
    render(
      <ul>
        <GuestMessageRow message={message({ metadata: { attachments: [] } })} members={ROSTER} />
        <GuestMessageRow message={message({ id: "m-2", content: "No metadata at all." })} members={ROSTER} />
        <GuestMessageRow message={message({ id: "m-3", content: "Null metadata.", metadata: null })} members={ROSTER} />
        <GuestMessageRow
          message={message({ id: "m-4", sender_id: "p-gone", sender_name: "", content: "From nobody the roster knows." })}
          members={[]}
        />
      </ul>,
    );
    expect(screen.getByText("The portal is up.")).toBeTruthy();
    expect(screen.getByText("No metadata at all.")).toBeTruthy();
    expect(screen.getByText("Null metadata.")).toBeTruthy();
    expect(screen.getByText("From nobody the roster knows.")).toBeTruthy();
    expect(screen.getByText("Someone")).toBeTruthy();
  });

  it("names a recording's starter through the guest's own roster, or says less", () => {
    const started = message({
      id: "m-rec",
      // A notice is a NULL-sender line: the server sends null, not "".
      sender_id: null as unknown as string,
      sender_type: "system",
      sender_name: "",
      content: "Audio recording started",
      content_type: "system",
      metadata: { kind: "recording", event: "started", recording_kind: "audio", started_by: "p-aaron", reason: "policy always" },
    });
    const { unmount } = render(
      <ul>
        <GuestMessageRow message={started} members={ROSTER} />
      </ul>,
    );
    expect(screen.getByTestId("guest-system-line").textContent).toBe(
      "Audio recording started · by Aaron Stransky · this room always records",
    );
    unmount();
    render(
      <ul>
        <GuestMessageRow message={started} members={[]} />
      </ul>,
    );
    expect(screen.getByTestId("guest-system-line").textContent).toBe(
      "Audio recording started · this room always records",
    );
  });

  it("draws the parent's thread line as a system line, not as its creator's message", () => {
    render(
      <ul>
        <GuestMessageRow
          message={message({
            id: "m-thread",
            sender_id: "p-aaron",
            sender_type: "human",
            sender_name: "Aaron Stransky",
            content: "Channel thread started",
            content_type: "system",
            metadata: { kind: "thread_started", thread_room_id: "t-1", thread_title: "Launch checklist", created_by: "p-aaron" },
          })}
          members={ROSTER}
        />
      </ul>,
    );
    expect(screen.getByTestId("guest-system-line").textContent).toBe(
      "Aaron Stransky started a thread: Launch checklist",
    );
    expect(screen.queryByText("Channel thread started")).toBeNull();
  });
});
