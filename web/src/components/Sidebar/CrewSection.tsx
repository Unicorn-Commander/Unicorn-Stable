import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  MessageSquarePlus,
  MoreVertical,
  Phone,
  Settings2,
} from "lucide-react";
import clsx from "clsx";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { beginThread, openAgentHub } from "@/lib/beginThread";
import { crewPresence, ownerSeatLabel, sharedRoomFor } from "@/lib/crew";
import { useCrew } from "@/hooks/useCrew";
import { useAppStore } from "@/stores/appStore";
import { useChannelCategories } from "@/stores/categoryStore";
import { useNavStore } from "@/stores/navStore";
import { useSidebarUi } from "@/stores/sidebarUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { buildCrewSection, type CrewRow, type CrewSectionModel } from "./sidebarModel";

/**
 * Crew — the agents you can talk to, pinned like contacts (Nav v3 §2.1).
 *
 * `section` is the desktop block above Conversations: header, three groups
 * (Your seats · House · Partners), eight rows then "More", and "All agents".
 * `page` is the phone's Crew tab: the same rows, no cap, larger targets.
 * Both draw `buildCrewSection`, which AppShell also flattens for Alt+↑/↓.
 *
 * A row's tap opens the hub. The ⋮ menu starts a new conversation (a thread
 * under the hub), calls the agent, or opens the seat's settings. A partner's
 * seat shows its brain read-only; the popover in the room decides what can
 * change (only your own seat).
 */
export function CrewSection({
  variant,
  onOpenRoom,
}: {
  variant: "section" | "page";
  onOpenRoom: (roomId: string) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { crew, loaded, fromRoster } = useCrew();
  const rooms = useAppStore((s) => s.rooms);
  const agents = useAppStore((s) => s.agents);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const scope = useFederationStore((s) => s.activeInstanceId);
  const searchQuery = useSidebarUi((s) => s.searchQuery);
  const showAll = useSidebarUi((s) => s.crewShowAll);
  const setShowAll = useSidebarUi((s) => s.setCrewShowAll);
  const collapsed = useChannelCategories((s) => s.collapsed);
  const toggleCollapsed = useChannelCategories((s) => s.toggleCollapsed);
  const setV2Destination = useNavStore((s) => s.setV2Destination);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const model: CrewSectionModel = useMemo(
    () =>
      buildCrewSection({
        crew,
        rooms,
        agents,
        searchQuery,
        // The phone tab lists everyone; "More" is a rail affordance.
        showAll: variant === "page" ? true : showAll,
        collapsed: variant === "page" ? {} : collapsed,
      }),
    [crew, rooms, agents, searchQuery, showAll, collapsed, variant],
  );

  function closePhoneDrawer() {
    if (
      window.matchMedia("(max-width: 767px)").matches &&
      useAppStore.getState().ui.sidebarOpen
    ) {
      useAppStore.getState().toggleSidebar();
    }
  }

  /**
   * The room a row opens: its hub, ensured on the server when the list has
   * none. A partner's seat has no hub of yours — the server refuses one
   * ("ask the seat's owner") — so its row opens the newest room you share.
   */
  async function hubIdFor(row: CrewRow): Promise<string | null> {
    if (row.roomId) return row.roomId;
    if (row.member.group === "partner") {
      const shared = sharedRoomFor(row.member, useAppStore.getState().rooms);
      if (shared) return shared.id;
      const owner = row.member.owner ? ownerSeatLabel(row.member.owner).replace(/ seat$/, "") : "its owner";
      useAppStore.getState().pushToast({
        title: `No room with ${row.member.display_name} yet`,
        body: `${owner.replace(/’s?$/, "")} has to add their seat to a room you share.`,
      });
      return null;
    }
    const hub = await openAgentHub(row.member.agent_id);
    if (hub) void qc.invalidateQueries({ queryKey: ["rooms", scope] });
    return hub?.id ?? null;
  }

  async function withBusy(row: CrewRow, job: () => Promise<void>) {
    if (busy) return;
    setBusy(row.id);
    setMenuKey(null);
    try {
      await job();
    } finally {
      setBusy(null);
    }
  }

  function openHub(row: CrewRow) {
    void withBusy(row, async () => {
      const id = await hubIdFor(row);
      if (id) onOpenRoom(id);
    });
  }

  function newConversation(row: CrewRow) {
    void withBusy(row, async () => {
      const id = await hubIdFor(row);
      if (!id) return;
      const thread = await beginThread({ roomId: id, navigate });
      if (thread) closePhoneDrawer();
    });
  }

  function call(row: CrewRow) {
    void withBusy(row, async () => {
      const id = await hubIdFor(row);
      if (!id) return;
      navigate(`/c/${id}?join=1&kind=voice`);
      closePhoneDrawer();
    });
  }

  function openSettings(row: CrewRow) {
    void withBusy(row, async () => {
      const id = await hubIdFor(row);
      if (!id) return;
      navigate(`/c/${id}?seat=1`);
      closePhoneDrawer();
    });
  }

  function openDirectory() {
    setV2Destination("directory");
    navigate("/agents");
    closePhoneDrawer();
  }

  const page = variant === "page";
  const isDesktop =
    typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;

  function renderRow(row: CrewRow): ReactNode {
    const { member } = row;
    // A seat's dot means "the runner polled the gateway in the last three
    // minutes"; the tooltip says so. House agents keep Brigade's wording.
    const badge = crewPresence(member);
    const active = !!row.roomId && row.roomId === activeRoomId;
    const menuOpen = menuKey === row.id;
    const subtitle =
      member.role_line ||
      (member.group === "partner" && member.owner ? ownerSeatLabel(member.owner) : null);
    return (
      <li
        key={row.id}
        className="relative"
        data-testid="crew-row"
        data-group={member.group}
        data-agent-id={member.agent_id}
      >
        <div
          className={clsx(
            "group relative flex w-full items-center rounded-lg pr-1 transition-colors",
            active ? "bg-white/[0.06]" : "hover:bg-white/[0.04]",
          )}
        >
          {active && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-stable-purple"
            />
          )}
          <button
            type="button"
            onClick={() => openHub(row)}
            disabled={busy === row.id}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-slate-300 transition-colors hover:text-slate-100 disabled:opacity-60",
              page ? "min-h-12 py-2" : "py-2.5 md:py-1.5",
            )}
            title={`Open your conversation with ${member.display_name}`}
            data-testid={`crew-open-${member.agent_id}`}
          >
            <span className="relative flex h-7 w-7 shrink-0 items-center justify-center">
              <Identity
                {...resolveIdentity({
                  id: member.agent_id,
                  participant_id: member.participant_id || undefined,
                  participant_type: "agent",
                  display_name: member.display_name,
                  avatar_url: member.avatar_url,
                  username: member.agent_id,
                })}
                presence={null}
                size={28}
                alt=""
              />
              <span
                className={clsx(
                  "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border",
                  badge.dotClass,
                )}
                aria-label={badge.label}
                title={badge.label}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-[3.5rem] truncate text-sm font-medium">
                  {member.display_name}
                </span>
                {/* Gives way before the name does (shrink 3 : 1) and ellipsises;
                    the title carries the full label. */}
                {row.brain && (
                  <span
                    className="min-w-0 shrink-[3] truncate rounded-full border border-line bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-slate-400"
                    title={
                      member.group === "partner"
                        ? `${row.brain} — ${member.owner ? ownerSeatLabel(member.owner) : "a partner's seat"}; only its owner can change it`
                        : `This conversation's brain: ${row.brain}`
                    }
                    data-testid="crew-brain-chip"
                  >
                    {row.brain}
                  </span>
                )}
                {member.unread > 0 && (
                  <span className="gradient-bg ml-auto grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                    {member.unread > 99 ? "99+" : member.unread}
                  </span>
                )}
              </span>
              {(page ? member.last_line || subtitle : subtitle) && (
                <span className="block truncate text-[11px] text-slate-500">
                  {page ? member.last_line || subtitle : subtitle}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuKey(menuOpen ? null : row.id);
            }}
            className={clsx(
              "focus-ring mr-1 shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-1",
              menuOpen || page
                ? "opacity-100"
                : "opacity-70 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
            )}
            aria-label={`Options for ${member.display_name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid={`crew-menu-${member.agent_id}`}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </div>
        {menuOpen && (
          <>
            <button
              className="fixed inset-0 z-20 cursor-default"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => setMenuKey(null)}
            />
            <div
              role="menu"
              aria-label={`Options for ${member.display_name}`}
              className="glass-heavy animate-fade-in absolute right-2 top-9 z-30 w-52 overflow-hidden rounded-xl py-1 shadow-pop"
            >
              <MenuItem onClick={() => newConversation(row)}>
                <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                New conversation
              </MenuItem>
              <MenuItem onClick={() => call(row)}>
                <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                Call
              </MenuItem>
              <MenuItem onClick={() => openSettings(row)}>
                <Settings2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                Settings
              </MenuItem>
            </div>
          </>
        )}
      </li>
    );
  }

  function renderGroups() {
    return model.groups.map((group) => (
      <div key={group.group} data-testid={`crew-group-${group.group}`}>
        <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
          {group.label}
        </p>
        <ul role="list">{group.rows.map(renderRow)}</ul>
      </div>
    ));
  }

  const allAgents = (
    <button
      type="button"
      onClick={openDirectory}
      className={clsx(
        "focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-xs font-medium text-stable-cyan transition-colors hover:bg-stable-cyan/10",
        page ? "min-h-11 py-2.5" : "py-2 md:py-1.5",
      )}
      data-testid="crew-all-agents"
    >
      <span className="flex-1">All agents</span>
      <ChevronRight className="h-3.5 w-3.5" />
    </button>
  );

  if (page) {
    return (
      <section aria-label="Crew" data-testid="crew-page" className="pb-2">
        {!loaded ? (
          <p className="px-2.5 py-2 text-xs text-slate-500">Loading crew…</p>
        ) : model.total === 0 ? (
          <p className="mx-2 rounded-lg border border-dashed border-line-strong px-3 py-3 text-xs text-slate-500">
            {searchQuery.trim() ? `No one in the crew matches “${searchQuery.trim()}”.` : "No agents yet."}
          </p>
        ) : (
          renderGroups()
        )}
        {fromRoster && loaded && (
          <p className="px-2.5 pt-1 text-[10px] text-slate-600">
            Roster only — this server has no crew list yet.
          </p>
        )}
        {allAgents}
      </section>
    );
  }

  // Desktop section: the phone gets a tab instead (§2.6).
  if (!isDesktop) return null;
  if (loaded && model.total === 0 && !searchQuery.trim()) return null;

  return (
    <section aria-label="Crew" data-testid="crew-section" className="mb-1">
      <div className="flex items-center justify-between px-2.5 pb-0.5">
        <button
          type="button"
          onClick={() => toggleCollapsed(model.collapseKey)}
          className="focus-ring group flex min-w-0 items-center gap-1 rounded-md py-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 transition-colors hover:text-slate-300"
          aria-expanded={!model.collapsed}
          title="Agents you can talk to"
        >
          <ChevronDown
            className={clsx(
              "h-3 w-3 shrink-0 transition-transform duration-150",
              model.collapsed && "-rotate-90",
            )}
          />
          <span className="truncate">Crew</span>
          {model.total > 0 && (
            <span className="ml-1 tabular-nums text-slate-600">{model.total}</span>
          )}
        </button>
      </div>
      {!model.collapsed && (
        <>
          {!loaded ? (
            <p className="px-2.5 py-1 text-[11px] text-slate-500">Loading crew…</p>
          ) : model.total === 0 ? (
            <p className="px-2.5 py-1 text-[11px] text-slate-500">No one in the crew matches.</p>
          ) : (
            renderGroups()
          )}
          {model.hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200"
              data-testid="crew-more"
            >
              <ChevronDown className="h-3 w-3" />
              More ({model.hiddenCount})
            </button>
          )}
          {showAll && !model.searching && model.total > 8 && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200"
              data-testid="crew-fewer"
            >
              <ChevronDown className="h-3 w-3 rotate-180" />
              Show fewer
            </button>
          )}
          {allAgents}
        </>
      )}
    </section>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06] max-md:min-h-11"
    >
      {children}
    </button>
  );
}
