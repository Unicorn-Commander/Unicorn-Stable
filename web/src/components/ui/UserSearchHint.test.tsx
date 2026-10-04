import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InviteMembersModal } from "@/components/Room/InviteMembersModal";
import { USER_SEARCH_HINT } from "./UserSearchHint";

vi.mock("@/services/api", () => ({
  api: {
    searchUsers: vi.fn().mockResolvedValue([]),
    getRoomMembers: vi.fn().mockResolvedValue([]),
  },
}));

describe("UserSearchHint", () => {
  it("renders under the search box in the invite modal", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <InviteMembersModal
          roomId="room-1"
          roomName="Ops"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(USER_SEARCH_HINT)).toBeInTheDocument();
  });
});
