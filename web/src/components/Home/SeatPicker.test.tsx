import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { CrewMember } from "@/services/api";
import { CREW_FIXTURE } from "@/mocks/crewFixture";
import { composerSeats } from "@/lib/homeComposer";
import { SeatPicker, seatPickerLine } from "./SeatPicker";

afterEach(cleanup);

const SEATS = composerSeats(CREW_FIXTURE, []);
const by = (id: string) => SEATS.find((seat) => seat.agent_id === id)!;

function Harness({ onPick, start = "persephone" }: { onPick?: (seat: CrewMember) => void; start?: string }) {
  const [selected, setSelected] = useState<CrewMember | null>(by(start));
  return (
    <SeatPicker
      seats={SEATS}
      selected={selected}
      onSelect={(seat) => {
        setSelected(seat);
        onPick?.(seat);
      }}
    />
  );
}

describe("SeatPicker", () => {
  it("shows who the message is for and lists your seats, then the house (never a partner's seat)", () => {
    render(<Harness />);
    const button = screen.getByTestId("seat-picker");
    expect(button).toHaveTextContent("Persephone");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    const list = screen.getByRole("listbox", { name: "Who the message is for" });
    const groups = within(list).getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Your seats", "House"]);
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(SEATS.length);
    expect(options.map((option) => option.getAttribute("data-testid"))).toEqual(
      SEATS.map((seat) => `seat-option-${seat.agent_id}`),
    );
    expect(screen.getByTestId("seat-option-persephone").getAttribute("aria-selected")).toBe("true");
  });

  it("says what a seat runs, whose a partner's seat is, and what a house agent is for", () => {
    expect(seatPickerLine(by("persephone"))).toBe("Fable 5.1 · high");
    // A partner's row still has a line (the picker no longer lists it; review 2, P1-1).
    expect(seatPickerLine(CREW_FIXTURE.find((row) => row.agent_id === "shafen-claude-code")!)).toBe("Shafen’s seat");
    expect(seatPickerLine({ ...by("majik"), role_line: " House DJ " })).toBe("House DJ");
    expect(seatPickerLine({ ...by("majik"), role_line: null })).toBeNull();
    // A seat that has not announced what it runs says nothing, not a guess.
    expect(seatPickerLine({ ...by("persephone"), seat_capabilities: null })).toBeNull();
  });

  it("walks with the arrows from the chosen seat, picks with Enter, closes with Escape", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByTestId("seat-picker"));
    const list = screen.getByRole("listbox");
    const active = () => list.querySelector("[data-active]")?.getAttribute("data-testid");
    expect(active()).toBe("seat-option-persephone");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe(`seat-option-${SEATS[1]!.agent_id}`);
    fireEvent.keyDown(list, { key: "End" });
    expect(active()).toBe(`seat-option-${SEATS[SEATS.length - 1]!.agent_id}`);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe("seat-option-persephone");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0].agent_id).toBe(SEATS[1]!.agent_id);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("seat-picker")).toHaveTextContent(SEATS[1]!.display_name);

    fireEvent.click(screen.getByTestId("seat-picker"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("picks with a click and closes on a press outside", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByTestId("seat-picker"));
    fireEvent.click(screen.getByTestId("seat-option-majik"));
    expect(onPick.mock.calls[0]![0].agent_id).toBe("majik");
    expect(screen.getByTestId("seat-picker")).toHaveTextContent("Majik Mane");
    fireEvent.click(screen.getByTestId("seat-picker"));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens nothing while the crew is loading or empty", () => {
    const { rerender } = render(<SeatPicker seats={[]} selected={null} onSelect={() => {}} loading />);
    const button = screen.getByTestId("seat-picker") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button).toHaveTextContent("Loading");
    rerender(<SeatPicker seats={[]} selected={null} onSelect={() => {}} />);
    expect((screen.getByTestId("seat-picker") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("seat-picker")).toHaveTextContent("Nobody");
  });
});
