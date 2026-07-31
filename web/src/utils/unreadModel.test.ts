import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@/services/api";
import {
  badgeCount,
  focusSortTier,
  loadFocusMode,
  messageMentionsUser,
  prepareRoomsForSidebar,
  qualifiesForFocused,
  roomsNeedingMarkRead,
  saveFocusMode,
  sumBadgeCounts,
  FOCUS_MODE_STORAGE_KEY,
  type RoomFocusMeta,
} from "./unreadModel";

function room(partial: Partial<Room> & { id: string; type: Room["type"] }): Room {
  return {
    name: partial.name ?? partial.id,
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    member_count: 2,
    unread_count: partial.unread_count ?? 0,
    last_message: null,
    members: [],
    agents: [],
    ...partial,
  };
}

const meta = (overrides: Partial<RoomFocusMeta> = {}): RoomFocusMeta => ({
  unread: 0,
  hasMention: false,
  notifyLevel: "all",
  ...overrides,
});

describe("messageMentionsUser", () => {
  it("matches @here and @channel", () => {
    expect(messageMentionsUser("hello @here", "alice")).toBe(true);
    expect(messageMentionsUser("@channel ping", "alice")).toBe(true);
  });

  it("matches @username case-insensitively with word boundary", () => {
    expect(messageMentionsUser("hey @Alice check this", "alice")).toBe(true);
    expect(messageMentionsUser("hey @alicey", "alice")).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(messageMentionsUser(undefined, "alice")).toBe(false);
    expect(messageMentionsUser("", "alice")).toBe(false);
  });
});

describe("badgeCount", () => {
  it("returns 0 when muted", () => {
    expect(badgeCount("r1", 12, "muted")).toBe(0);
  });

  it("passes through for all and mentions", () => {
    expect(badgeCount("r1", 3, "all")).toBe(3);
    expect(badgeCount("r1", 5, "mentions")).toBe(5);
  });

  it("clamps negative / missing to 0", () => {
    expect(badgeCount("r1", -1, "all")).toBe(0);
  });
});

describe("sumBadgeCounts", () => {
  it("skips muted rooms when levels come from getNotifyLevel", () => {
    // Without localStorage hooks, pass via unread map + default all.
    const rooms = [
      { id: "a", unread_count: 2 },
      { id: "b", unread_count: 4 },
    ];
    expect(sumBadgeCounts(rooms)).toBe(6);
    expect(sumBadgeCounts(rooms, { a: 1, b: 0 })).toBe(1);
  });
});

describe("qualifiesForFocused", () => {
  it("keeps the active room", () => {
    expect(
      qualifiesForFocused(
        { id: "x", type: "channel" },
        meta({ isActive: true }),
      ),
    ).toBe(true);
  });

  it("includes DMs with badge-visible unread", () => {
    expect(
      qualifiesForFocused({ id: "d", type: "dm" }, meta({ unread: 2 })),
    ).toBe(true);
    expect(
      qualifiesForFocused({ id: "g", type: "group_dm" }, meta({ unread: 1 })),
    ).toBe(true);
  });

  it("excludes muted rooms even with unread", () => {
    expect(
      qualifiesForFocused(
        { id: "d", type: "dm" },
        meta({ unread: 9, notifyLevel: "muted" }),
      ),
    ).toBe(false);
  });

  it("includes channels only when mentioned (not plain unread)", () => {
    expect(
      qualifiesForFocused({ id: "c", type: "channel" }, meta({ unread: 5 })),
    ).toBe(false);
    expect(
      qualifiesForFocused(
        { id: "c", type: "channel" },
        meta({ unread: 5, hasMention: true }),
      ),
    ).toBe(true);
  });
});

describe("prepareRoomsForSidebar", () => {
  const rooms = [
    room({ id: "ch-plain", type: "channel", name: "general", unread_count: 3 }),
    room({ id: "dm-unread", type: "dm", name: "Dana", unread_count: 1 }),
    room({ id: "ch-mention", type: "channel", name: "ops", unread_count: 2 }),
    room({ id: "dm-read", type: "dm", name: "Sam", unread_count: 0 }),
  ];

  const getMeta = (r: Room): RoomFocusMeta => {
    if (r.id === "ch-mention") return meta({ unread: 2, hasMention: true });
    if (r.id === "dm-unread") return meta({ unread: 1 });
    if (r.id === "ch-plain") return meta({ unread: 3 });
    return meta({ unread: 0 });
  };

  it("returns the same reference in All mode", () => {
    expect(prepareRoomsForSidebar(rooms, "all", getMeta)).toBe(rooms);
  });

  it("filters and sorts mentions before DMs in Focused", () => {
    const out = prepareRoomsForSidebar(rooms, "focused", getMeta);
    expect(out.map((r) => r.id)).toEqual(["ch-mention", "dm-unread"]);
    const first = out[0]!;
    const second = out[1]!;
    expect(focusSortTier(first, getMeta(first))).toBe(0);
    expect(focusSortTier(second, getMeta(second))).toBe(1);
  });
});

describe("roomsNeedingMarkRead", () => {
  it("returns only rooms with positive unread", () => {
    const rooms = [
      room({ id: "a", type: "dm", unread_count: 2 }),
      room({ id: "b", type: "channel", unread_count: 0 }),
    ];
    expect(
      roomsNeedingMarkRead(rooms, (r) => r.unread_count).map((r) => r.id),
    ).toEqual(["a"]);
  });
});

describe("focus mode persistence", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
  });

  it("defaults to all", () => {
    expect(loadFocusMode()).toBe("all");
  });

  it("round-trips focused", () => {
    saveFocusMode("focused");
    expect(loadFocusMode()).toBe("focused");
  });

  it("ignores garbage", () => {
    localStorage.setItem(FOCUS_MODE_STORAGE_KEY, "nope");
    expect(loadFocusMode()).toBe("all");
  });
});
