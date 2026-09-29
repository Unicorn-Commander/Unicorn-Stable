import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { crewPresence, opensHub, ownerSeatLabel, SEAT_IN_ITS_ROOMS } from "@/lib/crew";
import { useCrew } from "@/hooks/useCrew";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";
import { useAppStore } from "@/stores/appStore";
import { useChannelCategories } from "@/stores/categoryStore";
import { useNavStore } from "@/stores/navStore";
import { useSidebarUi } from "@/stores/sidebarUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { badgeCount } from "@/utils/unreadModel";
import { onMutedChange } from "@/utils/mute";
import { buildCrewSection, type CrewRow, type CrewSectionModel } from "./sidebarModel";

/** Voice to a runner seat waits on C5 (the house-voice key). Said on the item, not hidden. */
export const SEAT_CALL_UNAVAILABLE = "Voice for seats comes with the house-voice key";

/**
 * Crew — the agents you can talk to, pinned like contacts (Nav v3 §2.1).
 *
 * `section` is the desktop block above Conversations: 32px single-line rows
 * (face, name, unread), the brain chip and ⋮ as a hover overlay so the name
 * never gives way to them, three groups (Your seats · House · Partners)
 * capped per group with "More", and "All agents". `page` is the phone's
 * Crew tab: the same rows at touch height with the chip in line. Both draw
 * `buildCrewSection`, which AppShell also flattens for Alt+↑/↓.
 *
 * A row's tap opens its target: your hub (ensured on the server when it does
 * not exist yet) for your seats and house agents; for a partner's seat the
 * newest room you share, named on the row — and nothing acts in that room
 * from here (no New conversation, no Call). Settings is yours-only; Call on
 * a seat waits for C5 and says so.
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
  const { crew, loaded, fromRoster, crewAnswered } = useCrew();
  const rooms = useAppStore((s) => s.rooms);
  const agents = useAppStore((s) => s.agents);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const currentParticipantId = useAppStore((s) => s.currentParticipantId);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  const scope = useFederationStore((s) => s.activeInstanceId);
  const searchQuery = useSidebarUi((s) => s.searchQuery);
  const showAll = useSidebarUi((s) => s.crewShowAll);
  const setShowAll = useSidebarUi((s) => s.setCrewShowAll);
  const collapsed = useChannelCategories((s) => s.collapsed);
  const toggleCollapsed = useChannelCategories((s) => s.toggleCollapsed);
  const setV2Destination = useNavStore((s) => s.setV2Destination);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // mute.ts persists outside React; recompute badges when a level changes.
  const [mutedVersion, setMutedVersion] = useState(0);
  useEffect(() => onMutedChange(() => setMutedVersion((v) => v + 1)), []);

  const model: CrewSectionModel = useMemo(
    () =>
      buildCrewSection({
        crew,
        crewAnswered,
        selfIds: [currentParticipantId, currentUserId],
        rooms,
        agents,
        searchQuery,
        // The phone tab lists everyone; "More" is a rail affordance.
        showAll: variant === "page" ? true : showAll,
        collapsed: variant === "page" ? {} : collapsed,
        roomUnread: (room) =>
          badgeCount(room.id, unreadCounts[room.id] ?? room.unread_count ?? 0),
      }),
    // mutedVersion recomputes badges when a mute lands outside React.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
    [
      crew,
      crewAnswered,
      currentParticipantId,
      currentUserId,
      rooms,
      agents,
      searchQuery,
      showAll,
      collapsed,
      variant,
      unreadCounts,
      mutedVersion,
    ],
  );

  function closePhoneDrawer() {
    if (
      window.matchMedia?.("(max-width: 767px)")?.matches &&
      useAppStore.getState().ui.sidebarOpen
    ) {
      useAppStore.getState().toggleSidebar();
    }
  }

  /**
   * The room a row opens. A partner's seat only ever opens the shared room
   * the model resolved (or nothing, with a word); your seats and house
   * agents get their hub ensured on the server when the list has none.
   */
  async function targetIdFor(row: CrewRow): Promise<string | null> {
    if (row.roomId) return row.roomId;
    if (row.member.group === "partner") {
      const owner = row.member.owner
        ? ownerSeatLabel(row.member.owner).replace(/’s? seat$/, "")
        : "Its owner";
      useAppStore.getState().pushToast({
        title: `No room with ${row.member.display_name} yet`,
        body: `${owner} has to add their seat to a room you share.`,
      });
      return null;
    }
    if (!opensHub(row.member)) {
      // One of your seats whose runner does not follow you into new rooms:
      // a hub made for it would stay silent, so none is made.
      useAppStore.getState().pushToast({
        title: `No room with ${row.member.display_name} yet`,
        body: SEAT_IN_ITS_ROOMS(row.member.display_name),
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

  function openTarget(row: CrewRow) {
    void withBusy(row, async () => {
      const id = await targetIdFor(row);
      if (id) onOpenRoom(id);
    });
  }

  function newConversation(row: CrewRow) {
    void withBusy(row, async () => {
      const id = await targetIdFor(row);
      if (!id) return;
      const thread = await beginThread({ roomId: id, navigate });
      if (thread) closePhoneDrawer();
    });
  }

  function call(row: CrewRow) {
    void withBusy(row, async () => {
      const id = await targetIdFor(row);
      if (!id) return;
      navigate(`/c/${id}?join=1&kind=voice`);
      closePhoneDrawer();
    });
  }

  function openSettings(row: CrewRow) {
    void withBusy(row, async () => {
      const id = await targetIdFor(row);
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
  const isDesktop = typeof window === "undefined" || (window.matchMedia?.("(min-width: 768px)")?.matches ?? true);

  function rowTitle(row: CrewRow): string {
    const name = row.member.display_name;
    if (row.member.group === "partner" || !opensHub(row.member)) {
      return row.targetLabel ? `Open ${row.targetLabel} with ${name}` : `No room shared with ${name} yet`;
    }
    return row.brain ? `Open your conversation with ${name} — ${row.brain}` : `Open your conversation with ${name}`;
  }

  function menuFor(row: CrewRow): ReactNode | null {
    const { member } = row;
    if (member.group === "partner" || !opensHub(member)) return null;
    const seat = member.kind === "seat";
    return (
      <>
        <CrewMenuItem onClick={() => newConversation(row)} testId="crew-menu-new">
          <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          New conversation
        </CrewMenuItem>
        <CrewMenuItem
          onClick={() => call(row)}
          disabled={seat}
          title={seat ? SEAT_CALL_UNAVAILABLE : undefined}
          testId="crew-menu-call"
        >
          <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          Call
        </CrewMenuItem>
        {member.group === "own_seat" && (
          <CrewMenuItem onClick={() => openSettings(row)} testId="crew-menu-settings">
            <Settings2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            Settings
          </CrewMenuItem>
        )}
      </>
    );
  }

  function renderRow(row: CrewRow): ReactNode {
    const { member } = row;
    const badge = crewPresence(member);
    const active = !!row.roomId && row.roomId === activeRoomId;
    const menuOpen = menuKey === row.id;
    const items = menuFor(row);
    const face = (
      <span className={clsx("relative shrink-0", page ? "h-6 w-6" : "h-5 w-5")}>
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
          size={page ? 24 : 20}
          alt=""
        />
        {badge.dotClass && (
          <span
            role="img"
            aria-label={badge.label}
            title={badge.label}
            className={clsx(
              "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border",
              badge.dotClass,
            )}
            data-testid="crew-presence"
          />
        )}
      </span>
    );
    const chipTitle =
      member.group === "partner"
        ? `${row.brain} — ${member.owner ? ownerSeatLabel(member.owner) : "a partner's seat"}; only its owner can change it`
        : `This conversation's brain: ${row.brain}`;
    // Desktop: a pill in the hover overlay. Phone: plain text on a second
    // line — a pill squeezed beside the name collapsed to "F…".
    const chip = row.brain && (
      <span
        className={
          page
            ? "block truncate text-[11px] text-slate-500"
            : "glass-heavy min-w-0 max-w-[10rem] truncate rounded-full border border-line px-1.5 py-0.5 text-[10px] font-medium text-slate-300"
        }
        title={chipTitle}
        data-testid="crew-brain-chip"
      >
        {row.brain}
      </span>
    );
    const unread = row.unread > 0 && (
      <span
        className="gradient-bg grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white"
        aria-label={`${row.unread} unread`}
        data-testid="crew-unread"
      >
        {row.unread > 99 ? "99+" : row.unread}
      </span>
    );
    const menuButton = items && (
      <CrewRowMenu
        name={member.display_name}
        agentId={member.agent_id}
        open={menuOpen}
        alwaysVisible={page}
        onOpenChange={(next) => setMenuKey(next ? row.id : null)}
      >
        {items}
      </CrewRowMenu>
    );
    return (
      <li
        key={row.id}
        // Raised while its menu is open: the rows after it are positioned
        // too, and painted over the menu.
        className={clsx("relative", menuOpen && "z-30")}
        data-testid="crew-row"
        data-group={member.group}
        data-agent-id={member.agent_id}
      >
        <div
          className={clsx(
            "group relative flex items-center rounded-lg transition-colors",
            page ? "min-h-11 pr-1" : "h-8",
            active ? "bg-white/[0.06]" : "hover:bg-white/[0.04] focus-within:bg-white/[0.04]",
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
            onClick={() => openTarget(row)}
            disabled={busy === row.id}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-slate-300 transition-colors hover:text-slate-100 disabled:opacity-60",
              page ? "min-h-11 py-1.5" : "h-8",
            )}
            title={rowTitle(row)}
            data-testid={`crew-open-${member.agent_id}`}
          >
            {face}
            {/* The name keeps at least 14 characters; nothing else on the row
                may push it below that. */}
            <span className="min-w-[14ch] flex-1">
              <span className={clsx("block truncate font-medium", page ? "text-sm" : "text-[13px]")}>
                {member.display_name}
                {row.targetLabel && (
                  <span className="font-normal text-slate-500"> · {row.targetLabel}</span>
                )}
              </span>
              {page && chip}
            </span>
            {unread}
          </button>
          {page ? (
            menuButton
          ) : (
            (chip || items) && (
              <span
                className={clsx(
                  // Centred by the box, not a transform: a transform would
                  // pen the menu's layer and its click-away inside this span.
                  "pointer-events-none absolute inset-y-0 items-center gap-1",
                  // Clear of the unread badge, which keeps the row's far end.
                  row.unread > 0 ? "right-9" : "right-1",
                  // display, not opacity: an invisible overlay would still
                  // cover the unread badge (and read as visible to a11y tools).
                  // A touch device has no hover, so there it is always shown:
                  // an affordance that only exists on :hover does not exist.
                  active || menuOpen
                    ? "flex"
                    : "hidden group-hover:flex group-focus-within:flex [@media(hover:none)]:flex",
                )}
                data-testid="crew-row-overlay"
              >
                {chip}
                <span className="pointer-events-auto">{menuButton}</span>
              </span>
            )
          )}
        </div>
      </li>
    );
  }

  function renderGroups() {
    return model.groups.map((group) => (
      <div key={group.group} data-testid={`crew-group-${group.group}`}>
        <p
          className={clsx(
            "px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600",
            page ? "pb-0.5 pt-1.5" : "h-5 leading-5",
          )}
        >
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
        "focus-ring flex w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-stable-cyan transition-colors hover:bg-stable-cyan/10",
        page ? "min-h-11 py-2.5" : "h-7",
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
      <div className="flex h-6 items-center justify-between px-2">
        <button
          type="button"
          onClick={() => toggleCollapsed(model.collapseKey)}
          className="focus-ring group flex min-w-0 items-center gap-1 rounded-md text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 transition-colors hover:text-slate-300"
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
        {/* The directory's door lives on the header: one row fewer above the list. */}
        <button
          type="button"
          onClick={openDirectory}
          className="focus-ring flex shrink-0 items-center gap-0.5 rounded-md px-1 text-[10px] font-semibold text-stable-cyan transition-colors hover:bg-stable-cyan/10"
          data-testid="crew-all-agents"
        >
          All agents
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
      {!model.collapsed && (
        <>
          {!loaded ? (
            <p className="px-2 py-1 text-[11px] text-slate-500">Loading crew…</p>
          ) : model.total === 0 ? (
            <p className="px-2 py-1 text-[11px] text-slate-500">No one in the crew matches.</p>
          ) : (
            renderGroups()
          )}
          {model.hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="focus-ring flex h-6 w-full items-center gap-2 rounded-lg px-2 text-left text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200"
              data-testid="crew-more"
            >
              <ChevronDown className="h-3 w-3" />
              More ({model.hiddenCount})
            </button>
          )}
          {model.expanded && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="focus-ring flex h-6 w-full items-center gap-2 rounded-lg px-2 text-left text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200"
              data-testid="crew-fewer"
            >
              <ChevronDown className="h-3 w-3 rotate-180" />
              Show fewer
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The row's ⋮ menu with the keyboard model every other menu here has:
 * focus moves in on open, arrows cycle, Escape closes and returns focus.
 */
/** The ⋮ of a crew row, and of a seat's card on Home. */
export function CrewRowMenu({
  name,
  agentId,
  open,
  alwaysVisible,
  onOpenChange,
  children,
  testId,
}: {
  name: string;
  agentId: string;
  open: boolean;
  alwaysVisible: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** The trigger's test id; the rail's own by default. */
  testId?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  useMenuKeyboard(open, menuRef, btnRef, () => onOpenChange(false));
  // Heard on the document while open. The menu's own keys are heard only
  // once focus has moved into it, a frame after it opens — Escape pressed
  // from the trigger went nowhere; and the click-away below is a fixed box,
  // which an ancestor with a backdrop filter pens inside the sidebar.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeRef.current(false);
      btnRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      closeRef.current(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);
  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(!open);
        }}
        className={clsx(
          "focus-ring shrink-0 rounded-md text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100",
          // Always there means a finger may be what presses it.
          alwaysVisible ? "p-2 max-md:p-3" : "p-1",
        )}
        aria-label={`Options for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId ?? `crew-menu-${agentId}`}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <button
            className="fixed inset-0 z-20 cursor-default"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => onOpenChange(false)}
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Options for ${name}`}
            className="glass-heavy animate-fade-in absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-xl py-1 shadow-pop"
          >
            {children}
          </div>
        </>
      )}
    </span>
  );
}

export function CrewMenuItem({
  onClick,
  children,
  disabled = false,
  title,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      data-testid={testId}
      className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11"
    >
      {children}
    </button>
  );
}
