import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InviteMembersModal } from "./InviteMembersModal";

const apiMock = vi.hoisted(() => ({
  searchUsers: vi.fn().mockResolvedValue([]),
  getBrigadeAgents: vi.fn().mockResolvedValue([
    { id: "sidekick", name: "Sidekick", description: "House helper", entitled: true },
    { id: "private-seat", name: "Private Seat", description: "Not available", entitled: false },
  ]),
  getRoomMembers: vi.fn().mockResolvedValue([]),
  inviteBrigadeAgent: vi.fn().mockResolvedValue({ dispatched: false }),
  inviteUserToRoom: vi.fn(),
}));

vi.mock("@/services/api", () => ({ api: apiMock }));

describe("InviteMembersModal agent mode", () => {
  it("lists addable agents without querying or rendering people", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <InviteMembersModal
          roomId="room-1"
          roomName="Ops"
          mode="agents"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Sidekick")).toBeInTheDocument();
    expect(screen.queryByText("Private Seat")).not.toBeInTheDocument();
    expect(screen.queryByText("Start typing to search.")).not.toBeInTheDocument();
    expect(apiMock.searchUsers).not.toHaveBeenCalled();
  });
});
