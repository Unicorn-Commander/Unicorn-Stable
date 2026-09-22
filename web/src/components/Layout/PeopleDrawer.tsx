import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare,
  MoreVertical,
  Phone,
  Search,
  Star,
  Users,
  Video,
} from "lucide-react";
import clsx from "clsx";
import {
  api,
  type PeopleDirectoryEntry,
  type UserPreferences,
} from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { useModalA11y } from "@/hooks/useModalA11y";
import { useDirectCall } from "@/hooks/useDirectCall";
import type { CallKind } from "@/lib/callEntry";
import { ensureHumanDm } from "@/lib/ensureHumanDm";
import {
  PANEL_RESIZE_HANDLE_CLASS,
  useIsDesktop,
  usePanelResize,
} from "@/hooks/usePanelResize";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import { usePresenceStore } from "@/stores/presenceStore";
import {
  usePanelChromeStore,
  type PanelPresentation,
} from "@/stores/panelChromeStore";
import { FloatingWindow } from "@/components/ui/FloatingWindow";
import { PanelModeToolbar } from "@/components/ui/PanelModeToolbar";
import {
  PanelPopoutPortal,
  usePanelPopout,
} from "@/components/ui/panelPopout";

interface PeopleDrawerProps {
  onClose: () => void;
}

type PersonAction = "message" | "call" | "video" | "favorite";

const RECENTLY_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={clsx(
        "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900",
        online ? "bg-stable-mint animate-live" : "bg-slate-600",
      )}
      aria-label={online ? "Online" : "Offline"}
    />
  );
}

function formatLastSeen(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const delta = Date.now() - t;
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) {
    const m = Math.floor(delta / 60_000);
    return `${m}m ago`;
  }
  if (delta < 86_400_000) {
    const h = Math.floor(delta / 3_600_000);
    return `${h}h ago`;
  }
  if (delta < RECENTLY_ACTIVE_MS) {
    const d = Math.floor(delta / 86_400_000);
    return `${d}d ago`;
  }
  return null;
}

function PersonRow({
  person,
  online,
  favorite,
  busy,
  onOpen,
  onAction,
}: {
  person: PeopleDirectoryEntry;
  online: boolean;
  favorite: boolean;
  busy: boolean;
  onOpen: () => void;
  onAction: (action: PersonAction) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  const lastSeen = !online ? formatLastSeen(person.last_seen_at) : null;

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse") return;
    longPressFired.current = false;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setMenuOpen(true);
    }, 480);
  };

  return (
    <li ref={rowRef} className="relative">
      <div
        className={clsx(
          "group flex min-h-11 items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors",
          busy ? "opacity-60" : "hover:bg-white/[0.04]",
        )}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (longPressFired.current) {
              longPressFired.current = false;
              return;
            }
            onOpen();
          }}
          onPointerDown={onPointerDown}
          onPointerUp={clearLongPress}
          onPointerCancel={clearLongPress}
          onPointerLeave={clearLongPress}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left"
          aria-label={`Message ${person.display_name}`}
        >
          <span className="relative shrink-0">
            <Identity
              {...resolveIdentity({
                ...person,
                participant_type: "human",
              })}
              presence={null}
              size={28}
            />
            <OnlineDot online={online} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-slate-100">
                {person.display_name}
              </span>
              {favorite && (
                <Star
                  className="h-3 w-3 shrink-0 fill-stable-gold text-stable-gold"
                  aria-label="Favorite"
                />
              )}
            </span>
            <span className="block truncate text-[11px] text-slate-500">
              {online
                ? "Online"
                : lastSeen
                  ? `Active ${lastSeen}`
                  : `@${person.username}`}
            </span>
          </span>
        </button>

        <div
          className={clsx(
            "flex shrink-0 items-center gap-0.5",
            "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100",
          )}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("message")}
            className="focus-ring hidden h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 sm:inline-flex"
            aria-label={`Message ${person.display_name}`}
            title="Message"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("call")}
            className="focus-ring hidden h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 sm:inline-flex"
            aria-label={`Voice call ${person.display_name}`}
            title="Voice call"
          >
            <Phone className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("video")}
            className="focus-ring hidden h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 sm:inline-flex"
            aria-label={`Video call ${person.display_name}`}
            title="Video call"
          >
            <Video className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("favorite")}
            className={clsx(
              "focus-ring hidden h-9 w-9 items-center justify-center rounded-lg transition-colors sm:inline-flex",
              favorite
                ? "text-stable-gold hover:bg-stable-gold/10"
                : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-100",
            )}
            aria-label={
              favorite
                ? `Remove ${person.display_name} from favorites`
                : `Add ${person.display_name} to favorites`
            }
            aria-pressed={favorite}
            title={favorite ? "Unfavorite" : "Favorite"}
          >
            <Star className={clsx("h-3.5 w-3.5", favorite && "fill-current")} />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setMenuOpen((v) => !v)}
            className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label={`More actions for ${person.display_name}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div
          role="menu"
          className="absolute right-2 top-full z-20 mt-1 min-w-[10rem] overflow-hidden rounded-xl border border-line bg-surface-1 py-1 shadow-pop"
        >
          {(
            [
              ["message", "Message", MessageSquare],
              ["call", "Voice call", Phone],
              ["video", "Video call", Video],
              ["favorite", favorite ? "Unfavorite" : "Favorite", Star],
            ] as const
          ).map(([action, label, Icon]) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              className="focus-ring flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/[0.06]"
              onClick={() => {
                setMenuOpen(false);
                onAction(action);
              }}
            >
              <Icon
                className={clsx(
                  "h-3.5 w-3.5",
                  action === "favorite" && favorite && "fill-stable-gold text-stable-gold",
                )}
              />
              {label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty?: string;
  children: ReactNode;
}) {
  if (count === 0 && !empty) return null;
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {title}
        {count > 0 && (
          <span className="ml-1.5 tabular-nums text-slate-600">({count})</span>
        )}
      </h3>
      {count === 0 ? (
        <p className="px-2 text-xs italic text-slate-600">{empty}</p>
      ) : (
        <ul role="list" className="flex flex-col gap-0.5">
          {children}
        </ul>
      )}
    </section>
  );
}

/**
 * Global People directory — dockable sidebar, floating window, modal, or
 * browser pop-out. Mobile stays a bottom sheet.
 */
export function PeopleDrawer({ onClose }: PeopleDrawerProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { startCall } = useDirectCall();
  const isDesktop = useIsDesktop();
  const pushToast = useAppStore((s) => s.pushToast);
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);

  const presentation = usePanelChromeStore((s) => s.presentation.people);
  const setPresentation = usePanelChromeStore((s) => s.setPresentation);
  const floatGeom = usePanelChromeStore((s) => s.floatGeom.people);
  const setFloatGeom = usePanelChromeStore((s) => s.setFloatGeom);

  // Mobile always uses overlay sheet; desktop honors stored presentation.
  const mode: PanelPresentation = isDesktop ? presentation : "overlay";

  const dockResize = usePanelResize("people", {
    defaultWidth: 320,
    min: 260,
    max: 520,
    edge: "left",
  });

  const popout = usePanelPopout({
    title: "Stable — People",
    geometryKey: "panel:people",
    width: 400,
    height: 680,
    onBlocked: () =>
      pushToast({
        title: "Pop-out blocked",
        body: "Allow pop-ups for Stable, or use Float / Dock instead.",
      }),
  });

  // Modal a11y only when overlay (traps focus). Dock/float stay multi-tasking.
  const trapFocus = mode === "overlay" && !popout.isOpen;
  const panelRef = useModalA11y(trapFocus, onClose);
  const searchRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setQ("");
    setDebounced("");
  }, [activeInstanceId]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (popout.isOpen) return;
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [popout.isOpen, mode]);

  const { data: directory = [], isLoading } = useQuery({
    queryKey: ["people-directory", activeInstanceId, debounced],
    queryFn: () => api.getPeopleDirectory(debounced),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (directory.length === 0) return;
    usePresenceStore.getState().setFromDirectory(directory);
  }, [directory]);

  const presenceById = usePresenceStore((s) => s.byId);

  const { data: preferences } = useQuery({
    queryKey: ["my-preferences", activeInstanceId],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });

  // Memoized: `?? []` would mint a new array every render and cascade through
  // favoriteSet + the toggle callback below.
  const favoriteIds = useMemo(
    () => preferences?.favorite_people_ids ?? [],
    [preferences],
  );
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  const isOnline = useCallback(
    (person: PeopleDirectoryEntry) => {
      const live = presenceById[person.id];
      if (live) return live.isOnline;
      return person.is_online;
    },
    [presenceById],
  );

  const sections = useMemo(() => {
    const favorites: PeopleDirectoryEntry[] = [];
    const online: PeopleDirectoryEntry[] = [];
    const recent: PeopleDirectoryEntry[] = [];
    const everyone: PeopleDirectoryEntry[] = [];
    const now = Date.now();

    const sorted = [...directory].sort((a, b) =>
      a.display_name.localeCompare(b.display_name),
    );

    for (const person of sorted) {
      if (favoriteSet.has(person.id)) {
        favorites.push(person);
        continue;
      }
      if (isOnline(person)) {
        online.push(person);
        continue;
      }
      const seen = person.last_seen_at
        ? new Date(person.last_seen_at).getTime()
        : NaN;
      if (!Number.isNaN(seen) && now - seen <= RECENTLY_ACTIVE_MS) {
        recent.push(person);
        continue;
      }
      everyone.push(person);
    }

    favorites.sort((a, b) => {
      const onlineDelta = Number(isOnline(b)) - Number(isOnline(a));
      return onlineDelta || a.display_name.localeCompare(b.display_name);
    });
    recent.sort((a, b) => {
      const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
      const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
      return tb - ta;
    });

    return { favorites, online, recent, everyone };
  }, [directory, favoriteSet, isOnline]);

  const toggleFavorite = useCallback(
    async (participantId: string) => {
      const previous = preferences ?? {
        default_agent_id: null,
        favorite_people_ids: [],
      };
      const nextIds = favoriteSet.has(participantId)
        ? favoriteIds.filter((id) => id !== participantId)
        : [...favoriteIds, participantId];
      const optimistic: UserPreferences = {
        ...previous,
        favorite_people_ids: nextIds,
      };
      qc.setQueryData(["my-preferences", activeInstanceId], optimistic);
      qc.setQueryData(["my-preferences"], optimistic);
      try {
        const saved = await api.setFavoritePeople(nextIds);
        qc.setQueryData(["my-preferences", activeInstanceId], saved);
        qc.setQueryData(["my-preferences"], saved);
      } catch (error) {
        qc.setQueryData(["my-preferences", activeInstanceId], previous);
        qc.setQueryData(["my-preferences"], previous);
        pushToast({
          title: "Couldn't update favorites",
          body: error instanceof Error ? error.message : "Request failed",
        });
      }
    },
    [
      preferences,
      favoriteSet,
      favoriteIds,
      qc,
      activeInstanceId,
      pushToast,
    ],
  );

  const openDm = useCallback(
    async (person: PeopleDirectoryEntry, call: CallKind | null = null) => {
      if (busyId) return;
      setBusyId(person.id);
      try {
        const room = await ensureHumanDm(person);
        await qc.invalidateQueries({ queryKey: ["rooms"] });
        const state = useAppStore.getState();
        if (!state.rooms.some((r) => r.id === room.id)) {
          state.setRooms([room, ...state.rooms]);
        }
        setActiveRoomId(room.id);
        // Overlay/mobile: close after open. Dock/float/popout stay open.
        if (!isDesktop || mode === "overlay") {
          onClose();
        }
        navigate(`/c/${room.id}`);
        if (call) {
          await startCall(room.id, { kind: call });
        }
      } catch (error) {
        pushToast({
          title: call ? "Couldn't start call" : "Couldn't open chat",
          body: error instanceof Error ? error.message : "Request failed",
        });
      } finally {
        setBusyId(null);
      }
    },
    [
      busyId,
      qc,
      setActiveRoomId,
      onClose,
      navigate,
      startCall,
      pushToast,
      isDesktop,
      mode,
    ],
  );

  const handleAction = useCallback(
    (person: PeopleDirectoryEntry, action: PersonAction) => {
      if (action === "favorite") {
        void toggleFavorite(person.id);
        return;
      }
      if (action === "call" || action === "video") {
        void openDm(person, action === "call" ? "voice" : "video");
        return;
      }
      void openDm(person, null);
    },
    [toggleFavorite, openDm],
  );

  const renderPerson = (person: PeopleDirectoryEntry) => (
    <PersonRow
      key={person.id}
      person={person}
      online={isOnline(person)}
      favorite={favoriteSet.has(person.id)}
      busy={busyId === person.id}
      onOpen={() => void openDm(person)}
      onAction={(action) => handleAction(person, action)}
    />
  );

  const emptyDirectory =
    !isLoading && directory.length === 0 && !debounced;

  const body = (
    <>
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            ref={searchRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people…"
            autoComplete="off"
            className="focus-ring w-full rounded-xl border border-line bg-slate-950/60 py-2.5 pl-9 pr-3 text-base md:text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            aria-label="Search people"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {isLoading ? (
          <div
            className="flex h-40 items-center justify-center text-sm text-slate-400"
            role="status"
          >
            Loading people…
          </div>
        ) : emptyDirectory ? (
          <div className="flex flex-col items-center px-4 py-14 text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-2">
              <Users className="h-6 w-6 text-stable-cyan" />
            </div>
            <h3 className="font-display text-base font-semibold text-slate-100">
              No one here yet
            </h3>
            <p className="mt-1 max-w-xs text-xs text-slate-500">
              Coworkers appear after they sign into Stable on this server.
            </p>
          </div>
        ) : directory.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-slate-500">
            No matches for “{debounced}”.
          </p>
        ) : (
          <>
            <Section title="Favorites" count={sections.favorites.length}>
              {sections.favorites.map(renderPerson)}
            </Section>
            <Section
              title="Online now"
              count={sections.online.length}
              empty={
                sections.favorites.length === 0 &&
                sections.recent.length === 0 &&
                sections.everyone.length === 0
                  ? undefined
                  : "Nobody else is online right now"
              }
            >
              {sections.online.map(renderPerson)}
            </Section>
            <Section title="Recently active" count={sections.recent.length}>
              {sections.recent.map(renderPerson)}
            </Section>
            <Section title="Everyone" count={sections.everyone.length}>
              {sections.everyone.map(renderPerson)}
            </Section>
          </>
        )}
      </div>
    </>
  );

  const headerBar = (
    <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-stable-cyan/15">
          <Users className="h-4.5 w-4.5 text-stable-cyan" />
        </span>
        <div className="min-w-0">
          <h2
            id="people-drawer-title"
            className="font-display text-base font-semibold text-slate-100"
          >
            People
          </h2>
          <p className="truncate text-xs text-slate-400">
            {mode === "dock"
              ? "Docked sidebar — resize, float, or pop out"
              : mode === "float"
                ? "Floating window — drag header to move"
                : "Message, call, or favorite coworkers"}
          </p>
        </div>
      </div>
      <PanelModeToolbar
        presentation={presentation}
        onPresentation={(m) => {
          if (popout.isOpen) popout.close();
          setPresentation("people", m);
        }}
        onPopout={() => {
          if (popout.isOpen) {
            popout.handle?.focus();
            return;
          }
          popout.open();
        }}
        popoutActive={popout.isOpen}
        onClose={() => {
          if (popout.isOpen) popout.close();
          onClose();
        }}
      />
    </header>
  );

  // True browser pop-out portal (content only; native chrome bar is in child)
  const popoutPortal = (
    <PanelPopoutPortal handle={popout.handle}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <Users className="h-4 w-4 text-stable-cyan" />
          <span className="font-display text-sm font-semibold">People</span>
        </div>
        {body}
      </div>
    </PanelPopoutPortal>
  );

  // When popped out, hide in-app surface but keep store open.
  if (popout.isOpen) {
    return popoutPortal;
  }

  // —— Docked right sidebar (desktop) ——
  if (mode === "dock" && isDesktop) {
    return (
      <>
        {popoutPortal}
        <div
          ref={panelRef}
          className="relative hidden h-full shrink-0 flex-col border-l border-line-strong bg-surface-0/85 backdrop-blur-xl md:flex"
          style={{ width: dockResize.width }}
          role="complementary"
          aria-label="People sidebar"
          data-testid="people-drawer"
        >
          <div
            {...dockResize.dragHandleProps}
            aria-label="Resize People sidebar"
            title="Drag to resize · double-click to reset"
            className={clsx(PANEL_RESIZE_HANDLE_CLASS, "left-0")}
          />
          {headerBar}
          {body}
        </div>
      </>
    );
  }

  // —— Floating window (desktop) ——
  if (mode === "float" && isDesktop) {
    return (
      <>
        {popoutPortal}
        <FloatingWindow
          titleId="people-drawer-title"
          geometry={floatGeom}
          onGeometryChange={(g) => setFloatGeom("people", g)}
          minW={280}
          minH={320}
          header={headerBar}
          data-testid="people-drawer"
        >
          {body}
        </FloatingWindow>
      </>
    );
  }

  // —— Overlay / mobile bottom sheet ——
  return (
    <>
      {popoutPortal}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className={clsx(
          "fixed inset-0 z-50 flex bg-slate-950/70 backdrop-blur-sm",
          "items-end justify-center md:items-stretch md:justify-end",
        )}
        onClick={onClose}
        data-testid="people-drawer"
      >
        <motion.section
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="people-drawer-title"
          initial={isDesktop ? { x: 36, opacity: 0 } : { y: 40, opacity: 0 }}
          animate={isDesktop ? { x: 0, opacity: 1 } : { y: 0, opacity: 1 }}
          exit={isDesktop ? { x: 36, opacity: 0 } : { y: 40, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className={clsx(
            "glass-heavy flex w-full flex-col border-line shadow-pop",
            "max-h-[92dvh] rounded-t-2xl border-t sm:max-h-[88dvh]",
            "md:my-3 md:mr-3 md:h-[calc(100%-1.5rem)] md:max-h-none md:w-full md:max-w-md md:rounded-2xl md:border",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="flex justify-center pt-2 md:hidden"
            aria-hidden="true"
          >
            <span className="h-1 w-10 rounded-full bg-slate-600/80" />
          </div>
          {headerBar}
          {body}
        </motion.section>
      </motion.div>
    </>
  );
}
