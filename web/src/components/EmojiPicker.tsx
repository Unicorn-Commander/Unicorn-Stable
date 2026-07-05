import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Clock, Search } from "lucide-react";
import clsx from "clsx";
import {
  EMOJI,
  EMOJI_GROUPS,
  type EmojiEntry,
  type EmojiGroup,
} from "@/utils/emojiData";

const RECENT_KEY = "stable.emoji.recent.v1";
const RECENT_MAX = 24;
/** Search view renders a flat capped grid; browse view renders everything. */
const SEARCH_MAX = 200;
const COLS = 8;

type SectionId = EmojiGroup | "recent";

/** char → entry, for resolving stored recents back to names. */
const BY_CHAR = new Map<string, EmojiEntry>(EMOJI.map((e) => [e.char, e]));

/** Dataset pre-bucketed by group, in EMOJI_GROUPS display order. */
const GROUPED: { id: EmojiGroup; label: string; icon: string; entries: EmojiEntry[] }[] =
  EMOJI_GROUPS.map((g) => ({
    ...g,
    entries: EMOJI.filter((e) => e.group === g.id),
  }));

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string").slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function saveRecent(chars: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(chars));
  } catch {
    // localStorage unavailable (private mode / quota) — recents just don't persist.
  }
}

/** Hint the browser it can skip layout/paint for offscreen sections — cheap
 * virtualization-by-category without any scroll bookkeeping. */
function sectionStyle(count: number): CSSProperties {
  const rows = Math.ceil(count / COLS);
  return {
    contentVisibility: "auto",
    containIntrinsicSize: `${rows * 36 + 28}px`,
  } as CSSProperties;
}

export function EmojiPicker({
  onPick,
  onClose,
  className,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [hovered, setHovered] = useState<EmojiEntry | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>(() =>
    loadRecent().length > 0 ? "recent" : EMOJI_GROUPS[0]!.id,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Partial<Record<SectionId, HTMLDivElement | null>>>({});

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    return EMOJI.filter(
      (e) => e.name.includes(q) || e.keywords.some((k) => k.includes(q)),
    ).slice(0, SEARCH_MAX);
  }, [q]);

  const recentEntries = useMemo(
    () =>
      recent
        .map((c) => BY_CHAR.get(c))
        .filter((e): e is EmojiEntry => e !== undefined),
    [recent],
  );

  function pick(entry: EmojiEntry) {
    onPick(entry.char);
    setRecent((prev) => {
      const next = [entry.char, ...prev.filter((c) => c !== entry.char)].slice(0, RECENT_MAX);
      saveRecent(next);
      return next;
    });
  }

  /** Tab click: clear any search, then scroll the group's section into view. */
  function jumpTo(id: SectionId) {
    setQuery("");
    setActiveSection(id);
    requestAnimationFrame(() => {
      const section = sectionRefs.current[id];
      const scroller = scrollRef.current;
      if (section && scroller) {
        scroller.scrollTo({ top: section.offsetTop - 4 });
      }
    });
  }

  /** Scroll-spy: highlight the tab of the topmost visible section. */
  function handleScroll() {
    const scroller = scrollRef.current;
    if (!scroller || results) return;
    const top = scroller.scrollTop + 40;
    let current: SectionId | null = null;
    for (const [id, el] of Object.entries(sectionRefs.current)) {
      if (el && el.offsetTop <= top) {
        if (current === null || el.offsetTop > (sectionRefs.current[current]?.offsetTop ?? -1)) {
          current = id as SectionId;
        }
      }
    }
    if (current && current !== activeSection) setActiveSection(current);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // Enter in the search box picks the first hit — fast keyboard flow.
    if (e.key === "Enter" && results && results.length > 0 && e.target === searchRef.current) {
      e.preventDefault();
      pick(results[0]!);
    }
  }

  function renderCell(entry: EmojiEntry) {
    return (
      <button
        key={entry.char}
        type="button"
        onClick={() => pick(entry)}
        onMouseEnter={() => setHovered(entry)}
        onFocus={() => setHovered(entry)}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-xl transition-colors hover:bg-white/[0.08] focus-ring"
        aria-label={entry.name}
      >
        {entry.char}
      </button>
    );
  }

  const tabBase =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-base transition-colors focus-ring";

  return (
    <div
      role="dialog"
      aria-label="Emoji picker"
      onKeyDown={handleKeyDown}
      className={clsx(
        "glass-heavy flex h-96 w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl shadow-pop animate-slide-up",
        className,
      )}
    >
      {/* Search */}
      <div className="shrink-0 p-2 pb-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji…"
            aria-label="Search emoji"
            className="w-full rounded-lg border border-line bg-white/[0.04] py-1.5 pl-8 pr-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/50 focus:ring-2 focus:ring-stable-purple/15"
          />
        </div>
      </div>

      {/* Category tabs */}
      <div
        className="flex shrink-0 items-center gap-0.5 border-b border-white/[0.06] px-2 pb-1.5"
        role="tablist"
        aria-label="Emoji categories"
      >
        {recentEntries.length > 0 && (
          <button
            type="button"
            role="tab"
            aria-selected={!results && activeSection === "recent"}
            aria-label="Recently used"
            title="Recently used"
            onClick={() => jumpTo("recent")}
            className={clsx(
              tabBase,
              !results && activeSection === "recent"
                ? "bg-stable-purple/20 text-stable-purple-light"
                : "text-slate-400 hover:bg-white/[0.06]",
            )}
          >
            <Clock className="h-4 w-4" />
          </button>
        )}
        {EMOJI_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={!results && activeSection === g.id}
            aria-label={g.label}
            title={g.label}
            onClick={() => jumpTo(g.id)}
            className={clsx(
              tabBase,
              !results && activeSection === g.id
                ? "bg-stable-purple/20"
                : "opacity-70 grayscale-[0.3] hover:bg-white/[0.06] hover:opacity-100",
            )}
          >
            <span aria-hidden="true">{g.icon}</span>
          </button>
        ))}
      </div>

      {/* Grid */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative min-h-0 flex-1 overflow-y-auto px-2 py-1.5"
      >
        {results ? (
          results.length > 0 ? (
            <div className="grid grid-cols-8">{results.map(renderCell)}</div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-slate-500">
              <span className="text-2xl">🫥</span>
              <span className="text-xs">No emoji match “{query.trim()}”</span>
            </div>
          )
        ) : (
          <>
            {recentEntries.length > 0 && (
              <div
                ref={(el) => {
                  sectionRefs.current.recent = el;
                }}
              >
                <div className="px-1 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Recently used
                </div>
                <div className="grid grid-cols-8">{recentEntries.map(renderCell)}</div>
              </div>
            )}
            {GROUPED.map((g) => (
              <div
                key={g.id}
                ref={(el) => {
                  sectionRefs.current[g.id] = el;
                }}
                style={sectionStyle(g.entries.length)}
              >
                <div className="px-1 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {g.label}
                </div>
                <div className="grid grid-cols-8">{g.entries.map(renderCell)}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Hover preview footer */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-white/[0.06] px-3">
        {hovered ? (
          <>
            <span className="text-lg leading-none">{hovered.char}</span>
            <span className="truncate text-xs text-slate-400">{hovered.name}</span>
          </>
        ) : (
          <span className="text-xs text-slate-500">Pick an emoji</span>
        )}
      </div>
    </div>
  );
}
