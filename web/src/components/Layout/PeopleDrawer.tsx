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
  X,
} from "lucide-react";
import clsx from "clsx";
import {
  api,
  type PeopleDirectoryEntry,
  type UserPreferences,
} from "@/services/api";
import { Avatar } from "@/components/Avatar";
import { useModalA11y } from "@/hooks/useModalA11y";
import { useDirectCall } from "@/hooks/useDirectCall";
import { ensureHumanDm } from "@/lib/ensureHumanDm";
import { useIsDesktop } from "@/hooks/usePanelResize";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import { usePresenceStore } from "@/stores/presenceStore";

interface PeopleDrawerProps {
  onClose: () => void;
}

type PersonAction = "message" | "call" | "favorite";

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

  const subtitle = online
    ? "Available now"
    : formatLastSeen(person.last_seen_at) ?? `@${person.username}`;

  function clearLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function onPointerDown(e: ReactPointerEvent) {
    if (e.pointerType !== "touch") return;
    longPressFired.current = false;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setMenuOpen(true);
    }, 450);
  }

  function clearLongPressOnly() {
    clearLongPress();
  }

  function onPointerCancel() {
    clearLongPress();
    longPressFired.current = false;
  }

  const actionMenu = menuOpen ? (
    <div
      role="menu"
      className="glass-heavy absolute right-2 top-full z-20 mt-1 w-44 rounded-xl p-1 shadow-pop animate-fade-in"
    >
      <button
        role="menuitem"
        type="button"
        onClick={() => {
          setMenuOpen(false);
          onAction("message");
        }}
        className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-white/[0.06] md:min-h-0"
      >
        <MessageSquare className="h-4 w-4 text-slate-400" />
        Message
      </button>
      <button
        role="menuitem"
        type="button"
        onClick={() => {
          setMenuOpen(false);
          onAction("call");
        }}
        className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-white/[0.06] md:min-h-0"
      >
        <Phone className="h-4 w-4 text-emerald-400" />
        Call
      </button>
      <button
        role="menuitem"
        type="button"
        onClick={() => {
          setMenuOpen(false);
          onAction("favorite");
        }}
        className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-white/[0.06] md:min-h-0"
      >
        <Star
          className={clsx(
            "h-4 w-4",
            favorite ? "fill-current text-stable-gold" : "text-slate-400",
          )}
        />
        {favorite ? "Unfavorite" : "Favorite"}
      </button>
    </div>
  ) : null;

  return (
    <li ref={rowRef} className="group relative">
      <div
        className={clsx(
          "flex min-h-11 items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors",
          "hover:bg-white/[0.04]",
          menuOpen && "bg-white/[0.04]",
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
          onPointerUp={clearLongPressOnly}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpen(true);
          }}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left disabled:opacity-60"
          aria-label={`Message ${person.display_name}`}
        >
          <div className={clsx("relative shrink-0", !online && "opacity-60")}>
            <Avatar
              name={person.display_name}
              src={person.avatar_url}
              size="sm"
            />
            <OnlineDot online={online} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-100">
              {person.display_name}
            </p>
            <p className="truncate text-xs text-slate-500">{subtitle}</p>
          </div>
        </button>

        {/* Desktop hover actions */}
        <div className="hidden shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 md:flex">
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("message")}
            className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-50"
            aria-label={`Message ${person.display_name}`}
            title="Message"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("call")}
            className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg text-emerald-400/90 transition-colors hover:bg-emerald-500/15 hover:text-emerald-300 disabled:opacity-50"
            aria-label={`Call ${person.display_name}`}
            title="Call"
          >
            <Phone className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("favorite")}
            className={clsx(
              "focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors disabled:opacity-50",
              favorite
                ? "text-stable-gold hover:bg-stable-gold/10"
                : "text-slate-500 hover:bg-white/[0.06] hover:text-slate-200",
            )}
            aria-label={
              favorite
                ? `Remove ${person.display_name} from favorites`
                : `Add ${person.display_name} to favorites`
            }
            aria-pressed={favorite}
            title={favorite ? "Unfavorite" : "Favorite"}
          >
            <Star className={clsx("h-4 w-4", favorite && "fill-current")} />
          </button>
        </div>

        {/* Overflow: primary on mobile; secondary on desktop (right-click / long-press). */}
        <button
          type="button"
          disabled={busy}
          onClick={() => setMenuOpen((v) => !v)}
          className="focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-50 md:hidden"
          aria-label={`Actions for ${person.display_name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </div>
      {actionMenu}
    </li>
  );
}

function Section({
  title,
  count,
  children,
  empty,
}: {
  title: string;
  count: number;
  children: ReactNode;
  empty?: string;
}) {
  if (count === 0 && !empty) return null;
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {title}
        {count > 0 ? ` (${count})` : ""}
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
 * Global People directory — available without opening a room.
 * Desktop: right drawer. Mobile: bottom sheet / full-screen glass panel.
 */
export function PeopleDrawer({ onClose }: PeopleDrawerProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { startCall } = useDirectCall();
  const isDesktop = useIsDesktop();
  const pushToast = useAppStore((s) => s.pushToast);
  const setActiveRoomId = useAppStore((s) => s.setActiveRoomId);
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);
  const panelRef = useModalA11y(true, onClose);
  const searchRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Reset search when the active federated instance changes.
  useEffect(() => {
    setQ("");
    setDebounced("");
  }, [activeInstanceId]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  // Focus search after open (useModalA11y respects focus already inside panel).
  useEffect(() => {
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  const { data: directory = [], isLoading } = useQuery({
    queryKey: ["people-directory", activeInstanceId, debounced],
    queryFn: () => api.getPeopleDirectory(debounced),
    // Live WS patches presenceStore; poll is the cold-start / reconciling fallback.
    refetchInterval: 30_000,
  });

  // Seed instance presence store whenever the directory snapshot refreshes.
  useEffect(() => {
    if (directory.length === 0) return;
    usePresenceStore.getState().setFromDirectory(directory);
  }, [directory]);

  // Subscribe so Online/Favorite sorts re-render on live presence deltas.
  const presenceById = usePresenceStore((s) => s.byId);

  const { data: preferences } = useQuery({
    queryKey: ["my-preferences", activeInstanceId],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });

  const favoriteIds = preferences?.favorite_people_ids ?? [];
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
    async (person: PeopleDirectoryEntry, andCall = false) => {
      if (busyId) return;
      setBusyId(person.id);
      try {
        const room = await ensureHumanDm(person);
        await qc.invalidateQueries({ queryKey: ["rooms"] });
        // Seed store so call policy sees a dm room even before rooms refetch.
        const state = useAppStore.getState();
        if (!state.rooms.some((r) => r.id === room.id)) {
          state.setRooms([room, ...state.rooms]);
        }
        setActiveRoomId(room.id);
        onClose();
        navigate(`/c/${room.id}`);
        if (andCall) {
          // connect() reads activeRoomId; we set it above before navigating.
          await startCall(room.id);
        }
      } catch (error) {
        pushToast({
          title: andCall ? "Couldn't start call" : "Couldn't open chat",
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
    ],
  );

  const handleAction = useCallback(
    (person: PeopleDirectoryEntry, action: PersonAction) => {
      if (action === "favorite") {
        void toggleFavorite(person.id);
        return;
      }
      if (action === "call") {
        void openDm(person, true);
        return;
      }
      void openDm(person, false);
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

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={clsx(
        "fixed inset-0 z-50 flex bg-slate-950/70 backdrop-blur-sm",
        // Desktop: dock right. Mobile: bottom sheet.
        "items-end justify-center md:items-stretch md:justify-end",
      )}
      onClick={onClose}
    >
      <motion.section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="people-drawer-title"
        initial={
          isDesktop ? { x: 36, opacity: 0 } : { y: 40, opacity: 0 }
        }
        animate={isDesktop ? { x: 0, opacity: 1 } : { y: 0, opacity: 1 }}
        exit={isDesktop ? { x: 36, opacity: 0 } : { y: 40, opacity: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={clsx(
          "glass-heavy flex w-full flex-col border-line shadow-pop",
          // Mobile bottom sheet (tall but not always full-screen)
          "max-h-[92dvh] rounded-t-2xl border-t sm:max-h-[88dvh]",
          // Desktop right drawer
          "md:my-3 md:mr-3 md:h-[calc(100%-1.5rem)] md:max-h-none md:w-full md:max-w-md md:rounded-2xl md:border",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle affordance (mobile) */}
        <div
          className="flex justify-center pt-2 md:hidden"
          aria-hidden="true"
        >
          <span className="h-1 w-10 rounded-full bg-slate-600/80" />
        </div>

        <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2">
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
                Message, call, or favorite coworkers
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close People"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

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
              className="focus-ring w-full rounded-xl border border-line bg-slate-950/60 py-2.5 pl-9 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
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
              <Section
                title="Recently active"
                count={sections.recent.length}
              >
                {sections.recent.map(renderPerson)}
              </Section>
              <Section title="Everyone" count={sections.everyone.length}>
                {sections.everyone.map(renderPerson)}
              </Section>
            </>
          )}
        </div>
      </motion.section>
    </motion.div>
  );
}
