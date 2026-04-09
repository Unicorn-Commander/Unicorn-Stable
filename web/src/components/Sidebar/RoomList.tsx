import { useState, useMemo } from "react";
import { Hash, MessageSquare, Plus, Search } from "lucide-react";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useAppStore } from "@/stores/appStore";

export function RoomList() {
  const rooms = useAppStore((s) => s.rooms);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredRooms = useMemo(() => {
    if (!searchQuery.trim()) return rooms;
    const q = searchQuery.toLowerCase();
    return rooms.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [rooms, searchQuery]);

  const channels = useMemo(
    () => filteredRooms.filter((r) => r.type === "channel"),
    [filteredRooms],
  );

  const directMessages = useMemo(
    () => filteredRooms.filter((r) => r.type === "dm" || r.type === "group_dm"),
    [filteredRooms],
  );

  function formatLastMessage(content: string): string {
    if (content.length <= 40) return content;
    return content.slice(0, 40) + "...";
  }

  function formatTimestamp(dateStr: string): string {
    try {
      return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: false });
    } catch {
      return "";
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-3 py-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search rooms..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg bg-slate-800/80 py-1.5 pl-8 pr-3 text-xs text-slate-200 placeholder-slate-500 outline-none ring-1 ring-slate-700/50 transition-colors focus:ring-stable-purple/50"
            aria-label="Search rooms"
          />
        </div>
      </div>

      <nav
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-4"
        aria-label="Room navigation"
      >
        <section>
          <div className="flex items-center justify-between px-2 pb-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Channels
            </h3>
            <button
              onClick={() => setCreateRoomModalOpen(true)}
              className="rounded p-0.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
              aria-label="Create channel"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {channels.length === 0 && (
            <p className="px-2 py-2 text-xs text-slate-600">No channels yet</p>
          )}

          <ul role="list">
            {channels.map((room) => (
              <li key={room.id}>
                <button
                  onClick={() => setActiveRoomId(room.id)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                    activeRoomId === room.id
                      ? "bg-stable-purple/15 text-slate-100"
                      : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                  )}
                  aria-current={activeRoomId === room.id ? "page" : undefined}
                >
                  <Hash className="h-4 w-4 shrink-0 opacity-60" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-medium">
                        {room.name}
                      </span>
                      {room.unread_count > 0 && (
                        <span className="ml-1 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-stable-purple px-1 text-[10px] font-bold text-white">
                          {room.unread_count > 99 ? "99+" : room.unread_count}
                        </span>
                      )}
                    </div>
                    {room.last_message && (
                      <p className="truncate text-[11px] text-slate-500">
                        {formatLastMessage(room.last_message.content)}
                      </p>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <div className="flex items-center justify-between px-2 pb-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Direct Messages
            </h3>
            <button
              onClick={() => setCreateRoomModalOpen(true)}
              className="rounded p-0.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
              aria-label="Create direct message"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {directMessages.length === 0 && (
            <p className="px-2 py-2 text-xs text-slate-600">
              No conversations yet
            </p>
          )}

          <ul role="list">
            {directMessages.map((room) => (
              <li key={room.id}>
                <button
                  onClick={() => setActiveRoomId(room.id)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                    activeRoomId === room.id
                      ? "bg-stable-purple/15 text-slate-100"
                      : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                  )}
                  aria-current={activeRoomId === room.id ? "page" : undefined}
                >
                  <MessageSquare className="h-4 w-4 shrink-0 opacity-60" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {room.name}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {room.last_message && (
                          <span className="text-[10px] text-slate-600">
                            {formatTimestamp(room.last_message.created_at)}
                          </span>
                        )}
                        {room.unread_count > 0 && (
                          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-stable-purple px-1 text-[10px] font-bold text-white">
                            {room.unread_count > 99
                              ? "99+"
                              : room.unread_count}
                          </span>
                        )}
                      </div>
                    </div>
                    {room.last_message && (
                      <p className="truncate text-[11px] text-slate-500">
                        <span className="font-medium text-slate-500">
                          {room.last_message.sender_name}:
                        </span>{" "}
                        {formatLastMessage(room.last_message.content)}
                      </p>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </nav>
    </div>
  );
}
