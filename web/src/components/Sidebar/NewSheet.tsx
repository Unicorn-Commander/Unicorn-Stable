import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Hash,
  Lock,
  MessageSquare,
  Phone,
  Plus,
  Search,
  X,
} from "lucide-react";
import clsx from "clsx";
import { api, type Agent, type PeopleDirectoryEntry, type Room } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import {
  NEW_SHEET_ITEMS,
  channelConsequence,
  projectChannelConsequence,
  roomLabel,
  type NewSheetItemId,
} from "@/lib/conversation";
import { beginThread, openAgentHub } from "@/lib/beginThread";
import { ensureHumanDm } from "@/lib/ensureHumanDm";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { isNavV2Enabled } from "@/stores/navStore";
import { useModalA11y } from "@/hooks/useModalA11y";
import { ChannelBrowser } from "./ChannelBrowser";

/**
 * ⌘N / + New / the phone FAB outside a room.
 * Message a person, talk to an agent (hub), thread, channel, project channel, call.
 */
export function NewSheet() {
  const open = useConversationUi((s) => s.newSheetOpen);
  const initial = useConversationUi((s) => s.newSheetStep);
  const close = useConversationUi((s) => s.closeNewSheet);
  const panelRef = useModalA11y(open, close);
  const [step, setStep] = useState<NewSheetItemId | "menu">("menu");
  const [browse, setBrowse] = useState(false);

  useEffect(() => {
    if (open) setStep(initial ?? "menu");
  }, [open, initial]);

  return (
    <>
      {browse && <ChannelBrowser onClose={() => setBrowse(false)} />}
      {open && (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-0 backdrop-blur-sm sm:items-start sm:p-4 sm:pt-[10dvh]"
      onClick={close}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-sheet-title"
        data-testid="create-room-modal"
        className="glass-heavy flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl shadow-pop sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id="new-sheet-title" className="font-display text-base font-semibold text-slate-100">
            {step === "menu" ? "New" : NEW_SHEET_ITEMS.find((item) => item.id === step)?.label}
          </h2>
          <button
            type="button"
            onClick={close}
            className="focus-ring rounded-md p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {step === "menu" && (
            <Menu
              onPick={setStep}
              onBrowse={
                isNavV2Enabled()
                  ? () => {
                      close();
                      setBrowse(true);
                    }
                  : undefined
              }
            />
          )}
          {step === "person" && <PersonStep onDone={close} />}
          {step === "agent" && <AgentStep onDone={close} />}
          {step === "thread" && <ThreadStep onDone={close} />}
          {step === "channel" && <ChannelStep onDone={close} />}
          {step === "project" && <ProjectStep onDone={close} />}
          {step === "call" && <CallStep onDone={close} />}
        </div>
        {step !== "menu" && (
          <footer className="border-t border-line px-3 py-2">
            <button
              type="button"
              onClick={() => setStep("menu")}
              className="focus-ring text-xs font-medium text-slate-400 hover:text-slate-200"
            >
              Back
            </button>
          </footer>
        )}
      </div>
    </div>
      )}
    </>
  );
}

function Menu({
  onPick,
  onBrowse,
}: {
  onPick: (id: NewSheetItemId) => void;
  onBrowse?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {NEW_SHEET_ITEMS.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onPick(item.id)}
            className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-white/[0.05]"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-slate-300">
              {item.id === "person" && <MessageSquare className="h-4 w-4" />}
              {item.id === "agent" && <Bot className="h-4 w-4" />}
              {item.id === "thread" && <Plus className="h-4 w-4" />}
              {item.id === "channel" && <Hash className="h-4 w-4" />}
              {item.id === "project" && <Lock className="h-4 w-4" />}
              {item.id === "call" && <Phone className="h-4 w-4" />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-100">{item.label}</span>
              <span className="block truncate text-xs text-slate-500">{item.detail}</span>
            </span>
          </button>
        </li>
      ))}
      {onBrowse && (
        <li>
          <button
            type="button"
            onClick={onBrowse}
            data-testid="new-sheet-browse-channels"
            className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-white/[0.05]"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-slate-300">
              <Search className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-100">Browse channels</span>
              <span className="block truncate text-xs text-slate-500">
                Join a channel that already exists
              </span>
            </span>
          </button>
        </li>
      )}
    </ul>
  );
}

function PersonStep({ onDone }: { onDone: () => void }) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data = [], isFetching } = useQuery({
    queryKey: ["people-directory", "new-sheet", q],
    queryFn: () => api.getPeopleDirectory(q),
  });
  async function pick(person: PeopleDirectoryEntry) {
    try {
      const room = await ensureHumanDm(person);
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      const state = useAppStore.getState();
      if (!state.rooms.some((r) => r.id === room.id)) state.upsertRoom(room);
      navigate(`/c/${room.id}`);
      onDone();
    } catch (err) {
      useAppStore.getState().pushToast({
        title: "Couldn't open that conversation",
        body: (err as Error).message,
        kind: "error",
      });
    }
  }
  return (
    <Picker
      label="Search people"
      query={q}
      onQuery={setQ}
      loading={isFetching}
      empty="No one matches."
    >
      {data.map((person) => (
        <PickRow
          key={person.id}
          title={person.display_name}
          face={resolveIdentity(person)}
          onClick={() => void pick(person)}
        />
      ))}
    </Picker>
  );
}

function AgentStep({ onDone }: { onDone: () => void }) {
  const agents = useAppStore((s) => s.agents);
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const rows = agents.filter((agent) => {
    const hay = `${agent.display_name} ${agent.name} ${agent.id}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  return (
    <Picker label="Search agents" query={q} onQuery={setQ} empty="No agents match.">
      {rows.map((agent) => (
        <AgentPick key={agent.id} agent={agent} onPick={() => void openAgentHub(agent.id, navigate).then((hub) => hub && onDone())} />
      ))}
    </Picker>
  );
}

function AgentPick({ agent, onPick }: { agent: Agent; onPick: () => void }) {
  return (
    <PickRow
      title={agent.display_name || agent.name}
      subtitle={agent.title || agent.id}
      face={resolveIdentity(agent)}
      onClick={onPick}
    />
  );
}

function ThreadStep({ onDone }: { onDone: () => void }) {
  const rooms = useAppStore((s) => s.rooms);
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const parents = useMemo(
    () =>
      rooms.filter((room) => {
        if (room.parent_room_id || room.is_archived) return false;
        const label = roomLabel(room).toLowerCase();
        return label.includes(q.trim().toLowerCase());
      }),
    [rooms, q],
  );
  return (
    <Picker label="Search rooms" query={q} onQuery={setQ} empty="No rooms match.">
      {parents.map((room) => (
        <PickRow
          key={room.id}
          title={roomLabel(room)}
          subtitle={room.type === "channel" ? "Channel" : room.type === "agent_hub" ? "Agent hub" : "Direct"}
          onClick={() => void beginThread({ roomId: room.id, navigate }).then((t) => t && onDone())}
        />
      ))}
    </Picker>
  );
}

function ChannelStep({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function create() {
    const display = name.trim();
    if (!display || busy) return;
    setBusy(true);
    try {
      const room = await api.createRoom({
        name: display,
        description: "",
        type: "channel",
        member_ids: [],
        agent_ids: [],
      });
      if (visibility === "private") {
        await api.updateRoom(room.id, { visibility: "private" });
      }
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      useAppStore.getState().upsertRoom({
        ...room,
        visibility,
      });
      navigate(`/c/${room.id}`);
      onDone();
    } catch (err) {
      useAppStore.getState().pushToast({
        title: "Couldn't create the channel",
        body: (err as Error).message,
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label className="text-xs font-medium text-slate-400" htmlFor="new-channel-name">
        Channel name
      </label>
      <input
        id="new-channel-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-xl border border-line bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-stable-purple/60"
        placeholder="shipping"
        autoFocus
      />
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Who can see this channel">
        {(["public", "private"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={visibility === value}
            onClick={() => setVisibility(value)}
            className={clsx(
              "focus-ring rounded-xl border px-3 py-2 text-left text-sm",
              visibility === value
                ? "border-stable-purple/50 bg-stable-purple/15 text-slate-100"
                : "border-line text-slate-400",
            )}
          >
            {value === "public" ? "Public" : "Private"}
          </button>
        ))}
      </div>
      <p className="text-xs leading-5 text-slate-400">{channelConsequence(visibility)}</p>
      <button
        type="submit"
        disabled={!name.trim() || busy}
        className="focus-ring rounded-xl bg-stable-purple px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create channel"}
      </button>
    </form>
  );
}

function ProjectStep({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { data = [], isFetching, error } = useQuery({
    queryKey: ["project-ops-projects"],
    queryFn: () => api.getProjectOpsProjects(),
  });
  const [busy, setBusy] = useState<string | null>(null);

  async function pick(projectNumber: string) {
    setBusy(projectNumber);
    try {
      const room = await api.ensureProjectChannel(projectNumber);
      useAppStore.getState().upsertRoom(room);
      navigate(`/c/${room.id}`);
      onDone();
    } catch (err) {
      const status = (err as { status?: number }).status;
      useAppStore.getState().pushToast({
        title: "Couldn't open that project channel",
        body:
          status === 404 || status === 405
            ? "This server does not have project channels yet."
            : (err as Error).message || "Request failed",
        kind: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-xs leading-5 text-slate-400">{projectChannelConsequence()}</p>
      {isFetching && <p className="px-1 text-xs text-slate-500">Loading projects…</p>}
      {error && (
        <p className="px-1 text-xs text-rose-300">Project-Ops didn't answer. Nothing was created.</p>
      )}
      <ul className="flex flex-col gap-1">
        {data.map((project) => (
          <li key={project.projectNumber}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void pick(project.projectNumber)}
              className="focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/[0.05] disabled:opacity-50"
            >
              <ProjectNumber number={project.projectNumber} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-100">{project.title}</span>
                <span className="block text-[11px] text-slate-500">
                  {[project.status, project.dueDate].filter(Boolean).join(" · ") || "No status"}
                </span>
              </span>
              {busy === project.projectNumber && (
                <span className="text-[11px] text-slate-500">Opening…</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CallStep({ onDone }: { onDone: () => void }) {
  const rooms = useAppStore((s) => s.rooms);
  const navigate = useNavigate();
  const parents = rooms.filter((room) => !room.parent_room_id && !room.is_archived).slice(0, 20);
  function go(room: Room, kind: "voice" | "video") {
    navigate(`/c/${room.id}?join=1&kind=${kind}`);
    onDone();
  }
  return (
    <ul className="flex flex-col gap-1">
      {parents.map((room) => (
        <li key={room.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-white/[0.04]">
          <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{roomLabel(room)}</span>
          <button
            type="button"
            onClick={() => go(room, "voice")}
            className="focus-ring rounded-lg border border-line px-2 py-1 text-xs text-slate-300"
          >
            Voice
          </button>
          <button
            type="button"
            onClick={() => go(room, "video")}
            className="focus-ring rounded-lg border border-line px-2 py-1 text-xs text-slate-300"
          >
            Video
          </button>
        </li>
      ))}
    </ul>
  );
}

function Picker({
  label,
  query,
  onQuery,
  loading,
  empty,
  children,
}: {
  label: string;
  query: string;
  onQuery: (value: string) => void;
  loading?: boolean;
  empty: string;
  children: ReactNode;
}) {
  const list = Array.isArray(children) ? children : [children];
  const count = list.filter(Boolean).length;
  return (
    <div className="flex flex-col gap-2">
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        aria-label={label}
        placeholder={label}
        autoFocus
        className="rounded-xl border border-line bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-stable-purple/60"
      />
      {loading && <p className="px-1 text-xs text-slate-500">Searching…</p>}
      {!loading && count === 0 && <p className="px-1 text-xs text-slate-500">{empty}</p>}
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function PickRow({
  title,
  subtitle,
  face,
  onClick,
}: {
  title: string;
  subtitle?: string;
  face?: ReturnType<typeof resolveIdentity>;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="focus-ring flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-white/[0.05]"
      >
        {face && <Identity {...face} presence={null} size={28} />}
        <span className="min-w-0">
          <span className="block truncate text-sm text-slate-100">{title}</span>
          {subtitle && <span className="block truncate text-[11px] text-slate-500">{subtitle}</span>}
        </span>
      </button>
    </li>
  );
}

export function ProjectNumber({ number }: { number: string }) {
  return (
    <span className="shrink-0 rounded-md border border-stable-cyan/30 bg-stable-cyan/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-stable-cyan">
      {number}
    </span>
  );
}
