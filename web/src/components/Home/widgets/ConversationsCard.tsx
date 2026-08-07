import { useState } from "react";
import clsx from "clsx";
import { Hash, MessageSquare, MessagesSquare, UserRound, Users } from "lucide-react";
import type { Room } from "@/services/api";
import { Avatar } from "@/components/Avatar";
import { ChannelBrowser } from "@/components/Sidebar/ChannelBrowser";
import {
  channelsByActivity,
  defaultConversationsTab,
  humanChatsByActivity,
  unreadCountFor,
  type ConversationsTab,
  type UnreadMap,
} from "@/components/Home/homeModel";
import { HomeRow, SenderLine } from "./HomeRow";

/**
 * W3 — one Conversations card, two tabs.
 *
 * Chats is the old "Recent conversations" (human DMs + private groups).
 * Channels is the list that used to be invisible on home: a busy channel was
 * only reachable through the sidebar, so home answered "who messaged me?" but
 * not "what is the team talking about?".
 */

const TABS: { id: ConversationsTab; label: string }[] = [
  { id: "chats", label: "Chats" },
  { id: "channels", label: "Channels" },
];

export function ConversationsCard({
  rooms,
  unreadCounts,
  onOpenRoom,
  onFindPeople,
  excludeRoomIds,
  chosenTab,
  onChooseTab,
}: {
  rooms: Room[];
  unreadCounts: UnreadMap;
  onOpenRoom: (roomId: string) => void;
  onFindPeople: () => void;
  /** Rooms the priority inbox already renders above this card. */
  excludeRoomIds?: ReadonlySet<string>;
  /** Tab state is LIFTED so the priority card's "+N more channels" tail can
   * switch this card to Channels — a count you cannot act on is a dead end. */
  chosenTab: ConversationsTab | null;
  onChooseTab: (tab: ConversationsTab) => void;
}) {
  const chats = humanChatsByActivity(rooms, 12, excludeRoomIds);
  const channels = channelsByActivity(rooms, 12, excludeRoomIds);

  // Null until the user picks, so the DEFAULT stays live (whichever side has
  // newer top activity — it may flip once as rooms stream in) but an explicit
  // choice is never overridden.
  const tab = chosenTab ?? defaultConversationsTab(chats, channels);

  const [browseOpen, setBrowseOpen] = useState(false);

  return (
    <section aria-labelledby="home-conversations-heading">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-stable-cyan" />
          <h2
            id="home-conversations-heading"
            className="font-display text-sm font-semibold text-slate-200"
          >
            Conversations
          </h2>
        </div>
        <div
          role="tablist"
          aria-label="Conversation type"
          className="flex items-center gap-0.5 rounded-lg border border-line bg-white/[0.03] p-0.5"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => onChooseTab(t.id)}
              className={clsx(
                "focus-ring rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors",
                tab === t.id
                  ? "bg-white/[0.08] text-slate-100"
                  : "text-slate-400 hover:text-slate-200",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "chats" ? (
        chats.length === 0 ? (
          <div className="card relative flex flex-col items-center gap-3 overflow-hidden px-6 py-10 text-center">
            <span
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,rgba(34,211,238,0.08),transparent_70%)]"
              aria-hidden="true"
            />
            <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-stable-cyan/15 text-stable-cyan">
              <MessageSquare className="h-5 w-5" />
            </span>
            <div className="relative">
              <p className="text-sm font-medium text-slate-200">
                No human chats yet
              </p>
              <p className="mt-1 max-w-sm text-xs text-slate-500">
                Message a teammate from People, or start a group DM.
              </p>
            </div>
            <button
              type="button"
              onClick={onFindPeople}
              className="gradient-bg glow-iris focus-ring relative flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition hover:opacity-95 active:scale-[0.98]"
            >
              <UserRound className="h-3.5 w-3.5" />
              Find people
            </button>
          </div>
        ) : (
          <ul className="card overflow-hidden">
            {chats.map((room, i) => {
              const unread = unreadCountFor(room, unreadCounts);
              const m = room.last_message;
              return (
                <li key={room.id}>
                  <HomeRow
                    leading={
                      room.type === "group_dm" ? (
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-item-group">
                          <Users className="h-4 w-4" />
                        </span>
                      ) : (
                        <Avatar
                          name={room.display_name || room.name}
                          size="md"
                          className="mt-0.5"
                        />
                      )
                    }
                    title={room.display_name || room.name}
                    emphasis={unread > 0}
                    at={m?.created_at ?? null}
                    unread={unread}
                    tint={unread > 0 ? "bg-stable-purple/[0.06]" : undefined}
                    divider={i > 0}
                    onClick={() => onOpenRoom(room.id)}
                    line={
                      m ? (
                        <SenderLine message={m} read={unread === 0} />
                      ) : (
                        <p className="mt-0.5 truncate text-xs italic text-slate-600">
                          No messages yet
                        </p>
                      )
                    }
                  />
                </li>
              );
            })}
          </ul>
        )
      ) : channels.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
          No channel activity yet —{" "}
          <button
            type="button"
            onClick={() => setBrowseOpen(true)}
            className="focus-ring rounded font-medium text-stable-cyan hover:underline"
          >
            Browse channels
          </button>
        </p>
      ) : (
        <ul className="card overflow-hidden">
          {channels.map((room, i) => {
            const unread = unreadCountFor(room, unreadCounts);
            const m = room.last_message;
            const online = room.online_count ?? 0;
            return (
              <li key={room.id}>
                <HomeRow
                  leading={
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-item-channel/15 text-item-channel">
                      <Hash className="h-4 w-4" />
                    </span>
                  }
                  title={room.display_name || room.name}
                  emphasis={unread > 0}
                  at={m?.created_at ?? null}
                  unread={unread}
                  // Occupancy is the payoff of the online_count mapper fix:
                  // "who's active where" without opening the room. Zero is
                  // hidden — an empty room is the default state of most
                  // channels, and twelve "0/9 here" rows would bury the one
                  // that matters. Absence of the chip = nobody there, not
                  // missing data.
                  aside={
                    online > 0 ? (
                      <span className="text-[10px] font-medium tabular-nums text-stable-mint">
                        {online}/{room.member_count} here
                      </span>
                    ) : undefined
                  }
                  tint={unread > 0 ? "bg-stable-purple/[0.06]" : undefined}
                  divider={i > 0}
                  onClick={() => onOpenRoom(room.id)}
                  line={
                    m ? (
                      <SenderLine message={m} read={unread === 0} />
                    ) : (
                      <p className="mt-0.5 truncate text-xs italic text-slate-600">
                        No messages yet
                      </p>
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      )}

      {/* Same conditional-mount pattern as RoomList's browse entry point. */}
      {browseOpen && <ChannelBrowser onClose={() => setBrowseOpen(false)} />}
    </section>
  );
}
