/**
 * The help centre: browse the guides, search them, or ask the help agent.
 *
 * Content comes from `content/help/*.md` — this component renders whatever is
 * in that directory and knows nothing about the articles themselves. Adding a
 * guide is adding a file; nothing here changes.
 *
 * Layout: a two-pane browser on desktop, and a drill-down (list → article →
 * back) on narrow screens. Every affordance is a real button — nothing here is
 * reachable by hover only, because on a touch screen that means unreachable.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeft, BookOpen, Search, Sparkles, X } from "lucide-react";
import { getArticle, HELP_SECTIONS, searchHelp } from "@/content/help";
import { HelpAgentPanel } from "./HelpAgentPanel";
import { HelpMarkdown } from "./HelpMarkdown";

type Tab = "guides" | "ask";

export interface HelpCenterProps {
  /** Open straight to this article. */
  initialArticleId?: string;
  /** Open straight to a tab. */
  initialTab?: Tab;
  /** Rendered in the header when the centre owns its own chrome (the modal). */
  onClose?: () => void;
}

/** The first article, used as the landing view. */
const DEFAULT_ARTICLE_ID = HELP_SECTIONS[0]?.articles[0]?.id ?? "";

export function HelpCenter({
  initialArticleId,
  initialTab = "guides",
  onClose,
}: HelpCenterProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(initialArticleId ?? DEFAULT_ARTICLE_ID);
  // Narrow screens show one pane at a time; this is which one.
  const [showingArticle, setShowingArticle] = useState(Boolean(initialArticleId));
  const articleRef = useRef<HTMLDivElement | null>(null);
  // Scoped ids: this component is mounted more than once (a Settings pane and
  // the standalone modal), and duplicate ids would wire a screen reader's tab
  // to the wrong panel.
  const uid = useId();
  const tabId = (t: Tab) => `${uid}-tab-${t}`;
  const panelId = (t: Tab) => `${uid}-panel-${t}`;

  const results = useMemo(() => searchHelp(query), [query]);
  const searching = query.trim().length > 1;
  const article = getArticle(activeId);

  // A new article starts at the top. Without this, opening a short article from
  // halfway down a long one leaves you looking at blank space.
  useEffect(() => {
    articleRef.current?.scrollTo({ top: 0 });
  }, [activeId]);

  function open(id: string) {
    if (!getArticle(id)) return;
    setActiveId(id);
    setShowingArticle(true);
    setTab("guides");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-stable-purple/15">
          <BookOpen aria-hidden="true" className="h-4 w-4 text-stable-purple-light" />
        </span>
        <h2 className="font-display text-base font-semibold text-slate-100">Help</h2>

        <div
          role="tablist"
          aria-label="Help sections"
          className="ml-auto inline-flex rounded-lg border border-line bg-surface-2/60 p-0.5"
        >
          <TabButton
            id={tabId("guides")}
            controls={panelId("guides")}
            active={tab === "guides"}
            onClick={() => setTab("guides")}
          >
            <BookOpen aria-hidden="true" className="h-3.5 w-3.5" /> Guides
          </TabButton>
          <TabButton
            id={tabId("ask")}
            controls={panelId("ask")}
            active={tab === "ask"}
            onClick={() => setTab("ask")}
          >
            <Sparkles aria-hidden="true" className="h-3.5 w-3.5" /> Ask
          </TabButton>
        </div>

        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close help"
            className="focus-ring -mr-1 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {tab === "ask" ? (
        <div
          role="tabpanel"
          id={panelId("ask")}
          aria-labelledby={tabId("ask")}
          className="min-h-0 flex-1"
        >
          <HelpAgentPanel onOpenArticle={open} />
        </div>
      ) : (
        <div
          role="tabpanel"
          id={panelId("guides")}
          aria-labelledby={tabId("guides")}
          className="flex min-h-0 flex-1"
        >
          {/* Navigator — full width on phones until an article is picked. */}
          <nav
            aria-label="Help topics"
            className={clsx(
              "min-h-0 w-full shrink-0 flex-col overflow-y-auto border-line sm:flex sm:w-64 sm:border-r",
              showingArticle ? "hidden sm:flex" : "flex",
            )}
          >
            <div className="sticky top-0 z-10 bg-surface-1/95 p-3 backdrop-blur">
              <label className="relative block">
                <span className="sr-only">Search help</span>
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help…"
                  className="focus-ring w-full rounded-lg border border-line bg-surface-2/70 py-2 pl-8 pr-2.5 text-sm text-slate-200 placeholder:text-slate-500"
                />
              </label>
            </div>

            <div className="px-2 pb-3">
              {searching ? (
                <SearchResults
                  results={results}
                  activeId={activeId}
                  onOpen={open}
                />
              ) : (
                HELP_SECTIONS.map((section) => (
                  <div key={section.name} className="mb-3 last:mb-0">
                    <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {section.name}
                    </p>
                    <ul>
                      {section.articles.map((a) => (
                        <li key={a.id}>
                          <NavRow
                            active={a.id === activeId}
                            onClick={() => open(a.id)}
                          >
                            {a.title}
                          </NavRow>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </nav>

          <div
            ref={articleRef}
            className={clsx(
              "min-h-0 flex-1 overflow-y-auto",
              showingArticle ? "block" : "hidden sm:block",
            )}
          >
            {article ? (
              <article className="px-4 py-4 sm:px-6 sm:py-5">
                <button
                  type="button"
                  onClick={() => setShowingArticle(false)}
                  className="focus-ring mb-3 -ml-1 flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-slate-400 transition hover:text-slate-100 sm:hidden"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> All topics
                </button>

                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  {article.section}
                </p>
                <h3 className="mb-4 font-display text-xl font-semibold text-slate-100">
                  {article.title}
                </h3>
                <HelpMarkdown content={article.body} onNavigate={open} />

                <div className="mt-8 border-t border-line pt-4">
                  <p className="text-xs text-slate-500">
                    Not what you were after?{" "}
                    <button
                      type="button"
                      onClick={() => setTab("ask")}
                      className="focus-ring rounded text-stable-purple-light hover:underline"
                    >
                      Ask the help agent
                    </button>
                    .
                  </p>
                </div>
              </article>
            ) : (
              <p className="p-6 text-sm text-slate-500">
                That topic doesn't exist. Pick one from the list.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SearchResults({
  results,
  activeId,
  onOpen,
}: {
  results: ReturnType<typeof searchHelp>;
  activeId: string;
  onOpen: (id: string) => void;
}) {
  if (results.length === 0) {
    return (
      <p className="px-2 py-3 text-xs leading-5 text-slate-500">
        Nothing in the guides matches that. The{" "}
        <span className="text-slate-400">Ask</span> tab may still be able to
        help — and if it can't either, this help section has a gap worth
        reporting.
      </p>
    );
  }

  return (
    <ul>
      {results.map(({ article, excerpt }) => (
        <li key={article.id}>
          <NavRow active={article.id === activeId} onClick={() => onOpen(article.id)}>
            <span className="block truncate">{article.title}</span>
            <span className="mt-0.5 block truncate text-[11px] font-normal text-slate-500">
              {excerpt || article.summary}
            </span>
          </NavRow>
        </li>
      ))}
    </ul>
  );
}

function NavRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "focus-ring w-full rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
        active
          ? "bg-stable-purple/15 font-medium text-slate-100"
          : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
      )}
    >
      {children}
    </button>
  );
}

function TabButton({
  id,
  controls,
  active,
  onClick,
  children,
}: {
  id: string;
  controls: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      // Roving tabindex: a tablist is one Tab stop, and arrow keys move within
      // it. Without this every tab is its own stop, which is the ARIA pattern
      // half-implemented — worse for a screen reader than no roles at all.
      tabIndex={active ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const tabs = Array.from(
          e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]',
          ) ?? [],
        );
        const at = tabs.indexOf(e.currentTarget);
        const next = tabs[(at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
        next?.focus();
        next?.click();
      }}
      onClick={onClick}
      className={clsx(
        "focus-ring flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-stable-purple/20 text-stable-purple-light"
          : "text-slate-400 hover:text-slate-100",
      )}
    >
      {children}
    </button>
  );
}

export default HelpCenter;
