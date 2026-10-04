import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
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
import { api, type CrewMember, type PeopleDirectoryEntry, type Room } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { CREW_GROUP_LABEL, brainLabel, crewTargetRoom, opensHub, ownerSeatLabel, readRoomSeat, SEAT_IN_ITS_ROOMS } from "@/lib/crew";
import { buildToPicks, crewWithRoster, stepPick, type ToPickRef } from "@/lib/newSheetPicker";
import { useCrew } from "@/hooks/useCrew";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
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
import { usePresentedRooms } from "@/hooks/usePresentedRooms";
import { PresenterHiddenLine } from "@/components/Layout/PresenterHiddenLine";

/**
 * ⌘N / + New / the phone FAB outside a room.
 *
 * The first step is one "To:" box (Nav v3 §2.1): Crew → People → Channels.
 * A crew member opens their hub, a person their one DM, a channel joins or
 * opens. The six older starts stay under the box as secondary actions.
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
            <ToStep
              onDone={close}
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

function selfIds(): (string | null | undefined)[] {
  const state = useAppStore.getState();
  return [state.currentParticipantId, state.currentUser?.id];
}

/**
 * Open a crew member — the one path the crew rail also takes: your hub for
 * your seats and house agents (ensured on the server when the list has
 * none), the newest shared room for a partner's seat, which is never asked
 * for a hub (the server refuses: "ask the seat's owner").
 */
async function openCrewMember(
  member: CrewMember,
  navigate: (to: string) => void,
  crewAnswered: boolean,
): Promise<boolean> {
  const target = crewTargetRoom(member, useAppStore.getState().rooms, selfIds(), crewAnswered);
  if (target) {
    navigate(`/c/${target.room.id}`);
    return true;
  }
  if (member.group === "partner") {
    useAppStore.getState().pushToast({
      title: `No room with ${member.display_name} yet`,
      body: `${member.owner ? ownerSeatLabel(member.owner).replace(/’s? seat$/, "") : "Its owner"} has to add their seat to a room you share.`,
    });
    return false;
  }
  if (!opensHub(member)) {
    // Its runner does not follow you into new rooms: a hub would be silent.
    useAppStore.getState().pushToast({
      title: `No room with ${member.display_name} yet`,
      body: SEAT_IN_ITS_ROOMS(member.display_name),
    });
    return false;
  }
  const hub = await openAgentHub(member.agent_id, navigate);
  return !!hub;
}

function crewSubtitle(
  member: CrewMember,
  rooms: readonly Room[],
  crewAnswered: boolean,
  presenterEnabled = false,
): string {
  if (presenterEnabled) return member.group === "own_seat" ? "Your seat" : "Agent";
  const parts: string[] = [];
  if (member.group === "partner" && member.owner) parts.push(ownerSeatLabel(member.owner));
  else if (member.role_line) parts.push(member.role_line);
  else parts.push(CREW_GROUP_LABEL[member.group]);
  if (member.seat_capabilities) {
    const target = crewTargetRoom(member, rooms, selfIds(), crewAnswered);
    const brain = brainLabel(
      readRoomSeat(target?.kind === "hub" ? target.room : null, member.agent_id),
      member.seat_capabilities,
    );
    if (brain) parts.push(brain);
  }
  return parts.join(" · ");
}

function ToStep({
  onDone,
  onPick,
  onBrowse,
}: {
  onDone: () => void;
  onPick: (id: NewSheetItemId) => void;
  onBrowse?: () => void;
}) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { crew, crewAnswered } = useCrew();
  const roster = useAppStore((s) => s.agents);
  const rooms = useAppStore((s) => s.rooms);
  const { enabled: presenterEnabled, rule } = usePresentedRooms();
  const visibleCrew = presenterEnabled
    ? crew.filter((member) => rule.isIdentityAllowed(member.agent_id, member.display_name))
    : crew;
  const visibleRoster = presenterEnabled
    ? roster.filter((agent) => rule.isIdentityAllowed(agent.id, agent.display_name || agent.name))
    : roster;
  const visibleRooms = presenterEnabled ? rooms.filter((room) => rule.isRoomAllowed(room.id)) : rooms;
  const active = q.trim().length > 0;
  // The crew filters on every keystroke (local); the directory and the
  // channel browse wait for the query to hold still.
  const debounced = useDebouncedValue(q.trim(), 150);
  const { data: people = [], isFetching: peopleFetching } = useQuery({
    queryKey: ["people-directory", "new-sheet-to", debounced],
    queryFn: () => api.getPeopleDirectory(debounced),
    enabled: debounced.length > 0,
  });
  const { data: browsable = [] } = useQuery({
    queryKey: ["rooms-browse", "new-sheet-to", debounced],
    queryFn: () => api.browseChannels(debounced),
    enabled: debounced.length > 0,
    retry: false,
  });
  const visiblePeople = presenterEnabled
    ? people.filter((person) => rule.isIdentityAllowed(person.id, person.display_name))
    : people;
  const visibleBrowsable = presenterEnabled
    ? browsable.filter((room) => rule.isRoomAllowed(room.id))
    : browsable;
  const picks = useMemo(
    () => buildToPicks({ crew: visibleCrew, roster: visibleRoster, people: visiblePeople, rooms: visibleRooms, browsable: visibleBrowsable, query: q }),
    [visibleCrew, visibleRoster, visiblePeople, visibleRooms, visibleBrowsable, q],
  );
  // Arrow keys walk the flat list; Enter opens the active row (the first
  // when none is active). The index resets when the list changes.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const flatKey = picks.flat.map((ref) => `${ref.kind}:${ref.key}`).join("|");
  useEffect(() => {
    setActiveIndex(null);
  }, [flatKey]);
  const optionId = (ref: ToPickRef) => `new-sheet-pick-${ref.kind}-${ref.key}`;

  function fail(title: string, err: unknown) {
    useAppStore.getState().pushToast({
      title,
      body:
        (err as { detail?: string; message?: string }).detail ||
        (err as Error).message ||
        "Request failed",
      kind: "error",
    });
  }

  async function pickPerson(person: PeopleDirectoryEntry) {
    try {
      const room = await ensureHumanDm(person);
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      const state = useAppStore.getState();
      if (!state.rooms.some((r) => r.id === room.id)) state.upsertRoom(room);
      navigate(`/c/${room.id}`);
      onDone();
    } catch (err) {
      fail("Couldn't open that conversation", err);
    }
  }

  async function pickChannel(room: Room, joined: boolean) {
    try {
      if (!joined) {
        await api.joinRoom(room.id);
        useAppStore.getState().upsertRoom(room);
        await qc.invalidateQueries({ queryKey: ["rooms"] });
      }
      navigate(`/c/${room.id}`);
      onDone();
    } catch (err) {
      fail("Couldn't open that channel", err);
    }
  }

  function openRef(ref: ToPickRef) {
    if (ref.kind === "crew") {
      const member = picks.crew.find((m) => m.agent_id === ref.key);
      if (member) void openCrewMember(member, navigate, crewAnswered).then((ok) => ok && onDone());
    } else if (ref.kind === "person") {
      const person = picks.people.find((p) => p.id === ref.key);
      if (person) void pickPerson(person);
    } else {
      const pick = picks.channels.find((c) => c.room.id === ref.key);
      if (pick) void pickChannel(pick.room, pick.joined);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // An IME's Enter confirms its candidate, not a pick (review 2, P2-4).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(stepPick(picks.flat.length, activeIndex, e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter") {
      const ref = picks.flat[activeIndex ?? 0];
      if (!ref) return;
      e.preventDefault();
      openRef(ref);
    }
  }

  const activeRef = activeIndex === null ? null : (picks.flat[activeIndex] ?? null);
  const rowProps = (ref: ToPickRef) => ({
    id: optionId(ref),
    active: activeRef?.kind === ref.kind && activeRef.key === ref.key,
    onHover: () => setActiveIndex(ref.index),
  });
  const refFor = (kind: ToPickRef["kind"], key: string) =>
    picks.flat.find((ref) => ref.kind === kind && ref.key === key) ?? { kind, key, index: -1 };

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 rounded-xl border border-line bg-slate-950/60 px-3 py-2 focus-within:border-stable-purple/60">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">To:</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="To"
          placeholder="An agent, a person, or a channel"
          autoFocus
          role="combobox"
          aria-expanded={picks.flat.length > 0}
          aria-controls="new-sheet-picks"
          aria-activedescendant={activeRef ? optionId(activeRef) : undefined}
          aria-autocomplete="list"
          data-testid="new-sheet-to"
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
        />
      </label>
      <div id="new-sheet-picks" role="listbox" aria-label="Matches" className="flex flex-col gap-3">
      {picks.crew.length > 0 && (
        <PickGroup label="Crew" testId="new-sheet-picks-crew">
          {picks.crew.map((member) => (
            <PickRow
              key={member.agent_id}
              title={member.display_name}
              subtitle={crewSubtitle(member, visibleRooms, crewAnswered, presenterEnabled)}
              face={resolveIdentity({
                id: member.agent_id,
                participant_id: member.participant_id || undefined,
                participant_type: "agent",
                display_name: member.display_name,
                avatar_url: member.avatar_url,
                username: member.agent_id,
              })}
              onClick={() =>
                void openCrewMember(member, navigate, crewAnswered).then((ok) => ok && onDone())
              }
              {...rowProps(refFor("crew", member.agent_id))}
            />
          ))}
        </PickGroup>
      )}
      {picks.people.length > 0 && (
        <PickGroup label="People" testId="new-sheet-picks-people">
          {picks.people.map((person) => (
            <PickRow
              key={person.id}
              title={person.display_name}
              subtitle={person.username}
              face={resolveIdentity(person)}
              onClick={() => void pickPerson(person)}
              {...rowProps(refFor("person", person.id))}
            />
          ))}
        </PickGroup>
      )}
      {picks.channels.length > 0 && (
        <PickGroup label="Channels" testId="new-sheet-picks-channels">
          {picks.channels.map(({ room, joined }) => (
            <PickRow
              key={room.id}
              title={roomLabel(room)}
              subtitle={joined ? (room.visibility === "private" ? "Private channel" : "Channel") : "Join channel"}
              onClick={() => void pickChannel(room, joined)}
              {...rowProps(refFor("channel", room.id))}
            />
          ))}
        </PickGroup>
      )}
      </div>
      {active && peopleFetching && picks.empty && (
        <p className="px-1 text-xs text-slate-500">Searching…</p>
      )}
      {active && !peopleFetching && picks.empty && (
        <p className="px-1 text-xs text-slate-500" data-testid="new-sheet-no-match">
          No agent, person, or channel matches “{q.trim()}”.
        </p>
      )}
      <PresenterHiddenLine
        count={
          presenterEnabled
            ? crew.length - visibleCrew.length + people.length - visiblePeople.length + browsable.length - visibleBrowsable.length
            : 0
        }
        className="px-1"
      />
      <p className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Or start
      </p>
      <Menu onPick={onPick} onBrowse={onBrowse} compact />
    </div>
  );
}

function PickGroup({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <p className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function Menu({
  onPick,
  onBrowse,
  compact = false,
}: {
  onPick: (id: NewSheetItemId) => void;
  onBrowse?: () => void;
  /** Under the To box: tighter rows, the detail line stays. */
  compact?: boolean;
}) {
  return (
    <ul className={clsx("flex flex-col", compact ? "gap-0" : "gap-1")}>
      {NEW_SHEET_ITEMS.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onPick(item.id)}
            data-testid={`new-sheet-action-${item.id}`}
            className={clsx(
              "focus-ring flex w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-white/[0.05]",
              compact ? "py-2" : "py-3",
            )}
          >
            <span
              className={clsx(
                "grid shrink-0 place-items-center rounded-lg bg-white/[0.04] text-slate-300",
                compact ? "h-8 w-8" : "h-9 w-9",
              )}
            >
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
            className={clsx(
              "focus-ring flex w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-white/[0.05]",
              compact ? "py-2" : "py-3",
            )}
          >
            <span
              className={clsx(
                "grid shrink-0 place-items-center rounded-lg bg-white/[0.04] text-slate-300",
                compact ? "h-8 w-8" : "h-9 w-9",
              )}
            >
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
  const { enabled: presenterEnabled, rule } = usePresentedRooms();
  const { data = [], isFetching } = useQuery({
    queryKey: ["people-directory", "new-sheet", q],
    queryFn: () => api.getPeopleDirectory(q),
  });
  const visiblePeople = presenterEnabled
    ? data.filter((person) => rule.isIdentityAllowed(person.id, person.display_name))
    : data;
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
      {visiblePeople.map((person) => (
        <PickRow
          key={person.id}
          title={person.display_name}
          face={resolveIdentity(person)}
          onClick={() => void pick(person)}
        />
      ))}
      <PresenterHiddenLine count={presenterEnabled ? data.length - visiblePeople.length : 0} className="px-1" />
    </Picker>
  );
}

/**
 * Talk to an agent: the crew list (own seats, house, partners), not the old
 * two-entry allowlist. A stale server without /crew shows the roster.
 */
function AgentStep({ onDone }: { onDone: () => void }) {
  const { crew, loaded, fromRoster, crewAnswered } = useCrew();
  const roster = useAppStore((s) => s.agents);
  const rooms = useAppStore((s) => s.rooms);
  const { enabled: presenterEnabled, rule } = usePresentedRooms();
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  // The crew first, then every entitled roster agent not already in it.
  const pool = useMemo(() => {
    const all = crewWithRoster(crew, roster);
    return presenterEnabled
      ? all.filter((member) => rule.isIdentityAllowed(member.agent_id, member.display_name))
      : all;
  }, [crew, roster, presenterEnabled, rule]);
  const rows = pool.filter((member) => {
    const hay = `${member.display_name} ${member.agent_id} ${member.role_line ?? ""} ${member.owner ?? ""}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  return (
    <Picker
      label="Search agents"
      query={q}
      onQuery={setQ}
      loading={!loaded}
      empty={fromRoster ? "No agents in the roster match." : "No one in the crew matches."}
    >
      {rows.map((member) => (
        <PickRow
          key={member.agent_id}
          title={member.display_name}
          subtitle={crewSubtitle(member, rooms, crewAnswered, presenterEnabled)}
          face={resolveIdentity({
            id: member.agent_id,
            participant_id: member.participant_id || undefined,
            participant_type: "agent",
            display_name: member.display_name,
            avatar_url: member.avatar_url,
            username: member.agent_id,
          })}
          onClick={() =>
            void openCrewMember(member, navigate, crewAnswered).then((ok) => ok && onDone())
          }
        />
      ))}
      <PresenterHiddenLine
        count={presenterEnabled ? crewWithRoster(crew, roster).length - pool.length : 0}
        className="px-1"
      />
    </Picker>
  );
}

function ThreadStep({ onDone }: { onDone: () => void }) {
  const rooms = useAppStore((s) => s.rooms);
  const { enabled: presenterEnabled, rule } = usePresentedRooms();
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const parents = useMemo(
    () =>
      rooms.filter((room) => {
        if (presenterEnabled && !rule.isRoomAllowed(room.id)) return false;
        if (room.parent_room_id || room.is_archived) return false;
        const label = roomLabel(room).toLowerCase();
        return label.includes(q.trim().toLowerCase());
      }),
    [rooms, q, presenterEnabled, rule],
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
      <PresenterHiddenLine
        count={presenterEnabled ? rooms.filter((room) => !rule.isRoomAllowed(room.id)).length : 0}
        className="px-1"
      />
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
  const presenterEnabled = usePresentedRooms().enabled;
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
      <PresenterHiddenLine count={presenterEnabled ? data.length : 0} className="px-1" />
      <ul className="flex flex-col gap-1">
        {!presenterEnabled && data.map((project) => (
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
  const { enabled: presenterEnabled, rule } = usePresentedRooms();
  const navigate = useNavigate();
  const parents = rooms
    .filter((room) => !room.parent_room_id && !room.is_archived)
    .filter((room) => !presenterEnabled || rule.isRoomAllowed(room.id))
    .slice(0, 20);
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
      <PresenterHiddenLine
        count={presenterEnabled ? rooms.filter((room) => !rule.isRoomAllowed(room.id)).length : 0}
        className="px-1"
      />
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
  id,
  active = false,
  onHover,
}: {
  title: string;
  subtitle?: string;
  face?: ReturnType<typeof resolveIdentity>;
  onClick: () => void;
  /** Keyboard-walkable rows (the To box): the option id and its active state. */
  id?: string;
  active?: boolean;
  onHover?: () => void;
}) {
  return (
    <li id={id} role={id ? "option" : undefined} aria-selected={id ? active : undefined} data-active={active || undefined}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onHover}
        tabIndex={id ? -1 : undefined}
        className={clsx(
          "focus-ring flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-white/[0.05]",
          active && "bg-white/[0.08]",
        )}
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
