/**
 * Tasks and Threads columns. Docked, floated, or popped by PanelHost.
 * Tasks reads GET /rooms/{id}/tasks (L2). Until that route exists the panel
 * says so — it does not invent rows. Threads are child rooms.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Archive, Pin, Plus, Search } from "lucide-react";
import clsx from "clsx";
import { api, type ApiError, type Room, type RoomTask } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { beginThread } from "@/lib/beginThread";
import { roomLabel } from "@/lib/conversation";
import { useAppStore } from "@/stores/appStore";
import { ProjectNumber } from "@/components/Sidebar/NewSheet";

function errorStatus(err: unknown): number | null {
  const status = (err as ApiError | undefined)?.status;
  return typeof status === "number" ? status : null;
}

function taskDue(task: RoomTask): string | null {
  return task.due_date || task.dueDate || null;
}

export function TasksPanel({ roomId }: { roomId: string }) {
  const room = useAppStore((s) => s.rooms.find((r) => r.id === roomId));
  const { data, error, isLoading } = useQuery({
    queryKey: ["room-tasks", roomId],
    queryFn: () => api.getRoomTasks(roomId),
    retry: false,
  });
  const missing = errorStatus(error) === 404 || errorStatus(error) === 405;

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-0" aria-label="Tasks" data-room={roomId}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-sm font-semibold text-slate-100">Tasks</span>
        {room?.project_number && <ProjectNumber number={room.project_number} />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <p className="px-3 py-3 text-xs text-slate-500">Loading tasks…</p>}
        {missing && (
          <p className="px-3 py-3 text-xs leading-5 text-slate-400">
            This server doesn't list project tasks on the room yet.
          </p>
        )}
        {error && !missing && (
          <p className="px-3 py-3 text-xs text-rose-300">Couldn't load tasks.</p>
        )}
        {!isLoading && !error && (data?.length ?? 0) === 0 && (
          <p className="px-3 py-3 text-xs leading-5 text-slate-400">No open tasks on this project.</p>
        )}
        <ul>
          {(data ?? []).map((task) => {
            const due = taskDue(task);
            const assignee = task.assignee;
            return (
              <li key={task.id} className="border-b border-line px-3 py-2.5">
                <p className="text-sm text-slate-100">{task.title}</p>
                <p className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                  {assignee?.display_name && (
                    <span className="inline-flex items-center gap-1">
                      <Identity
                        {...resolveIdentity({
                          display_name: assignee.display_name,
                          avatar_url: assignee.avatar_url,
                          participant_id: assignee.participant_id,
                          participant_type: assignee.kind === "agent" ? "agent" : "human",
                        })}
                        presence={null}
                        size={20}
                      />
                      {assignee.display_name}
                    </span>
                  )}
                  {task.status && <span>{task.status}</span>}
                  {due && <span>due {due.slice(0, 10)}</span>}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

const PIN_KEY = (roomId: string) => `stable.threadPins.${roomId}`;

function readPins(roomId: string): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY(roomId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writePins(roomId: string, ids: string[]) {
  try {
    localStorage.setItem(PIN_KEY(roomId), JSON.stringify(ids));
  } catch {
    /* private mode */
  }
}

/** Child-room threads: list, search, archive, and a per-device pin. */
export function ThreadsPanel({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [pins, setPins] = useState<string[]>(() => readPins(roomId));
  const [starting, setStarting] = useState(false);
  const parent = useAppStore((s) => {
    const room = s.rooms.find((r) => r.id === roomId);
    const parentId = room?.parent_room_id;
    return parentId ? s.rooms.find((r) => r.id === parentId) ?? room : room;
  });
  const parentId = parent?.id ?? roomId;

  const { data = [], isLoading } = useQuery({
    queryKey: ["room-threads", parentId, showArchived],
    queryFn: () => api.listThreads(parentId, showArchived),
  });

  const visible = useMemo(() => {
    const query = q.trim().toLowerCase();
    const rows = data.filter((room) => {
      if (!query) return true;
      return roomLabel(room).toLowerCase().includes(query);
    });
    return [...rows].sort((a, b) => {
      const ap = pins.includes(a.id) ? 0 : 1;
      const bp = pins.includes(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
  }, [data, q, pins]);

  function togglePin(room: Room) {
    const next = pins.includes(room.id) ? pins.filter((id) => id !== room.id) : [room.id, ...pins];
    setPins(next);
    writePins(parentId, next);
  }

  async function toggleArchive(room: Room) {
    if (room.is_archived) await api.unarchiveRoom(room.id);
    else await api.archiveRoom(room.id);
    await qc.invalidateQueries({ queryKey: ["room-threads", parentId] });
    await qc.invalidateQueries({ queryKey: ["rooms"] });
  }

  async function create() {
    if (starting) return;
    setStarting(true);
    try {
      const thread = await beginThread({ roomId: parentId, navigate });
      if (thread) await qc.invalidateQueries({ queryKey: ["room-threads", parentId] });
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-0" aria-label="Threads" data-room={roomId}>
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="text-sm font-semibold text-slate-100">Threads</span>
        <button
          type="button"
          onClick={() => void create()}
          disabled={starting}
          className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-stable-cyan hover:bg-white/[0.05] disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          New thread
        </button>
      </header>
      <div className="border-b border-line px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
            className="w-full rounded-lg border border-line bg-slate-950/50 py-1.5 pl-7 pr-2 text-xs text-slate-100 outline-none focus:border-stable-purple/50"
          />
        </div>
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="focus-ring mt-2 text-[11px] text-slate-500 hover:text-slate-300"
          aria-pressed={showArchived}
        >
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <li className="px-3 py-3 text-xs text-slate-500">Loading threads…</li>}
        {!isLoading && visible.length === 0 && (
          <li className="px-3 py-3 text-xs leading-5 text-slate-400">
            No threads yet. Start one and it keeps this room's agents and their modes.
          </li>
        )}
        {visible.map((room) => (
          <li key={room.id} className="flex items-center gap-1 border-b border-line px-2 py-1">
            <button
              type="button"
              onClick={() => navigate(`/c/${room.id}`)}
              className="focus-ring min-w-0 flex-1 rounded-md px-1 py-1.5 text-left"
            >
              <span className="flex items-center gap-1.5">
                {pins.includes(room.id) && <Pin className="h-3 w-3 shrink-0 text-stable-gold" aria-label="Pinned" />}
                <span className="truncate text-sm text-slate-100">{roomLabel(room)}</span>
              </span>
              {room.is_archived && <span className="text-[10px] text-slate-500">Archived</span>}
            </button>
            <button
              type="button"
              onClick={() => togglePin(room)}
              className={clsx(
                "focus-ring rounded-md p-1.5 text-slate-500 hover:text-slate-200",
                pins.includes(room.id) && "text-stable-gold",
              )}
              aria-label={pins.includes(room.id) ? "Unpin thread" : "Pin thread"}
            >
              <Pin className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void toggleArchive(room)}
              className="focus-ring rounded-md p-1.5 text-slate-500 hover:text-slate-200"
              aria-label={room.is_archived ? "Unarchive thread" : "Archive thread"}
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
