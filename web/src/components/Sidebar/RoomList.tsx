import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Hash, MessageSquare, Plus, Search, Sparkles } from "lucide-react";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { CreateDmModal } from "./CreateDmModal";
import { ChannelBrowser } from "./ChannelBrowser";

export function RoomList() {
  const navigate = useNavigate();
  const rooms = useAppStore((s) => s.rooms);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const clearUnread = useAppStore((s) => s.clearUnread);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const onlineUsers = useAppStore((s) => s.onlineUsers);
  const participantsByRoom = useAppStore((s) => s.participants);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  // Open a room by navigating; the route param drives activeRoomId (see
  // AppShell). We still clear unread locally for snappy badge feedback.
  const openRoom = (id: string) => {
    clearUnread(id);
    navigate(`/c/${id}`);
  };
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const [createDmOpen, setCreateDmOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [seeding, setSeeding] = useState(false);
  const queryClient = useQueryClient();

  async function handleSeedDefaults() {
    if (seeding) return;
    setSeeding(true);
    try {
      await api.bootstrapDefaultRooms();
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
    } catch (e) {
      console.error("bootstrap defaults failed", e);
    } finally {
      setSeeding(false);
    }
  }

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
            <div className="flex items-center gap-1">
              <button
                onClick={() => setBrowseOpen(true)}
                className="rounded px-1 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
                aria-label="Browse channels"
                title="Browse channels you can join"
              >
                Browse
              </button>
              <button
                onClick={() => setCreateRoomModalOpen(true)}
                className="rounded p-0.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
                aria-label="Create channel"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {channels.length === 0 && (
            <div className="px-2 py-2">
              <p className="mb-2 text-xs text-slate-600">No channels yet</p>
              <button
                onClick={handleSeedDefaults}
                disabled={seeding}
                className="flex w-full items-center gap-1.5 rounded-md border border-stable-purple/30 bg-stable-purple/10 px-2 py-1.5 text-xs text-stable-purple hover:bg-stable-purple/20 disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3" />
                {seeding ? "Creating…" : "Seed business channels"}
              </button>
            </div>
          )}

          <ul role="list">
            {channels.map((room) => (
              <li key={room.id}>
                <button
                  onClick={() => openRoom(room.id)}
                  className={clsx(
                    "relative flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                    activeRoomId === room.id
                      ? "bg-stable-purple/20 text-slate-50 font-semibold shadow-[inset_3px_0_0_0] shadow-stable-purple"
                      : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                  )}
                  aria-current={activeRoomId === room.id ? "page" : undefined}
                >
                  <Hash
                    className={clsx(
                      "h-4 w-4 shrink-0",
                      activeRoomId === room.id ? "text-stable-purple-light" : "opacity-60",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-medium">
                        {room.name}
                      </span>
                      {(unreadCounts[room.id] ?? 0) > 0 && (
                        <span className="ml-1 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-stable-purple px-1 text-[10px] font-bold text-white">
                          {(unreadCounts[room.id] ?? 0) > 99
                            ? "99+"
                            : unreadCounts[room.id]}
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
              onClick={() => setCreateDmOpen(true)}
              className="rounded p-0.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
              aria-label="Create direct message"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {directMessages.length === 0 && (
            <button
              onClick={() => setCreateDmOpen(true)}
              className="mx-2 mb-1 flex w-[calc(100%-1rem)] flex-col items-start rounded-md border border-dashed border-slate-700/50 px-2.5 py-2 text-left text-xs text-slate-500 transition-colors hover:border-stable-purple/50 hover:bg-slate-800/40 hover:text-slate-300"
            >
              <span className="font-medium">No DMs yet</span>
              <span>Click here to start one — pick one person or several for a group.</span>
            </button>
          )}

          <ul role="list">
            {directMessages.map((room) => {
              const others = (participantsByRoom[room.id] ?? []).filter(
                (p) => (p.participant_id || p.user_id) !== currentUserId,
              );
              const otherOnline = others.some((p) => {
                const id = p.participant_id || p.user_id || "";
                return p.is_online || onlineUsers.includes(id);
              });
              return (
              <li key={room.id}>
                <button
                  onClick={() => openRoom(room.id)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                    activeRoomId === room.id
                      ? "bg-stable-purple/15 text-slate-100"
                      : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                  )}
                  aria-current={activeRoomId === room.id ? "page" : undefined}
                >
                  <span className="relative shrink-0">
                    <MessageSquare className="h-4 w-4 opacity-60" />
                    {otherOnline && (
                      <span
                        className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-slate-900 bg-green-500"
                        aria-label="Online"
                      />
                    )}
                  </span>
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
              );
            })}
          </ul>
        </section>
      </nav>

      {createDmOpen && (
        <CreateDmModal onClose={() => setCreateDmOpen(false)} />
      )}
      {browseOpen && (
        <ChannelBrowser onClose={() => setBrowseOpen(false)} />
      )}
    </div>
  );
}
