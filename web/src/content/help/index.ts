/**
 * The help corpus: every `.md` file in this directory, parsed once at module
 * load.
 *
 * Content lives in markdown files, NOT in components. That is the whole point
 * of this module — adding an article is dropping a file next to this one, and
 * nothing in `components/Help` has to change. See README.md here for the
 * frontmatter contract.
 *
 * The same corpus is the grounding the help agent answers from (the client
 * retrieves the relevant articles and sends them with the question), which is
 * why there is exactly one copy of it: a server-side duplicate would drift, and
 * a drifted duplicate would teach the agent to state stale things as fact.
 */

export interface HelpArticle {
  /** Stable slug from frontmatter — deep-link target, e.g. `help:agents`. */
  id: string;
  title: string;
  section: string;
  /** Sort key within (and, via its first article, between) sections. */
  order: number;
  /** One-line description shown in lists and search results. */
  summary: string;
  /** Extra search terms that are not in the body. */
  keywords: string[];
  /** Markdown body, frontmatter stripped. */
  body: string;
  /** Lowercased body, precomputed for search. */
  searchText: string;
}

/**
 * Eager because the corpus is a few dozen KB of text and the Help surface is
 * useless without all of it (search has to see every article on the first
 * keystroke). `?raw` keeps markdown as a string rather than trying to parse it
 * at build time.
 */
const RAW = import.meta.glob("./*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Frontmatter delimiter — a `---` line at the very top and one to close it. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Deliberately a tiny key/value parser rather than a YAML dependency: the
 * contract is one `key: value` per line, values are plain text, and anything
 * fancier belongs in the body. A malformed file loses its metadata, not the
 * whole corpus.
 */
function parseFrontmatter(raw: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match || match[1] === undefined) return { fields: {}, body: raw };

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    if (key) fields[key] = line.slice(sep + 1).trim();
  }
  return { fields, body: raw.slice(match[0].length) };
}

function toArticle(path: string, raw: string): HelpArticle | null {
  const { fields, body } = parseFrontmatter(raw);

  // `skip: true` is how README.md (and any future non-article note) opts out.
  if ((fields.skip ?? "").toLowerCase() === "true") return null;

  const id = fields.id?.trim();
  const title = fields.title?.trim();
  const section = fields.section?.trim();
  if (!id || !title || !section) {
    // A file that cannot say what it is gets dropped rather than rendered as a
    // blank row. Loud in dev, silent in prod — never a broken article.
    if (import.meta.env.DEV) {
      console.warn(
        `[help] ${path} is missing required frontmatter (id, title, section) — skipped.`,
      );
    }
    return null;
  }

  const keywords = (fields.keywords ?? "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  const trimmedBody = body.trim();

  return {
    id,
    title,
    section,
    order: Number.parseInt(fields.order ?? "", 10) || 0,
    summary: fields.summary?.trim() ?? "",
    keywords,
    body: trimmedBody,
    searchText: `${title}\n${fields.summary ?? ""}\n${keywords.join(" ")}\n${trimmedBody}`.toLowerCase(),
  };
}

export const HELP_ARTICLES: HelpArticle[] = Object.entries(RAW)
  .map(([path, raw]) => toArticle(path, raw))
  .filter((a): a is HelpArticle => a !== null)
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

export interface HelpSection {
  name: string;
  articles: HelpArticle[];
}

/**
 * Sections in the order their first article declares, so ordering is expressed
 * once — in the `order` frontmatter — instead of in a hand-maintained list here
 * that a new file would silently fall off the end of.
 */
export const HELP_SECTIONS: HelpSection[] = (() => {
  const byName = new Map<string, HelpArticle[]>();
  for (const article of HELP_ARTICLES) {
    const bucket = byName.get(article.section);
    if (bucket) bucket.push(article);
    else byName.set(article.section, [article]);
  }
  return [...byName.entries()].map(([name, articles]) => ({ name, articles }));
})();

const BY_ID = new Map(HELP_ARTICLES.map((a) => [a.id, a]));

export function getArticle(id: string): HelpArticle | undefined {
  return BY_ID.get(id);
}

export interface HelpSearchHit {
  article: HelpArticle;
  score: number;
  /** A body excerpt around the first match, for the result row. */
  excerpt: string;
}

/** Token-frequency scoring, weighted by where the term was found. */
function scoreArticle(article: HelpArticle, terms: string[]): number {
  let score = 0;
  const title = article.title.toLowerCase();
  const summary = article.summary.toLowerCase();

  for (const term of terms) {
    if (title.includes(term)) score += 12;
    if (article.id.includes(term)) score += 8;
    if (article.keywords.some((k) => k.includes(term))) score += 6;
    if (summary.includes(term)) score += 4;

    // Body hits count, with diminishing returns so one long article cannot
    // outrank a short article that is actually about the thing you asked for.
    let from = 0;
    let hits = 0;
    for (;;) {
      const at = article.searchText.indexOf(term, from);
      if (at === -1 || hits >= 5) break;
      hits += 1;
      from = at + term.length;
    }
    score += hits;

    // Every term must appear SOMEWHERE, or this is not a match at all.
    if (!article.searchText.includes(term)) return 0;
  }
  return score;
}

function excerptFor(article: HelpArticle, terms: string[]): string {
  const first = terms
    .map((t) => article.searchText.indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (first === undefined) return article.summary;

  // Offsets are into searchText, which is `title\nsummary\nkeywords\nbody` —
  // so shift into body coordinates and clamp rather than slicing blind.
  const prefixLength = article.searchText.length - article.body.length;
  const inBody = Math.max(0, first - prefixLength);
  const start = Math.max(0, inBody - 60);
  const raw = article.body.slice(start, start + 200).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + raw + (start + 200 < article.body.length ? "…" : "");
}

/**
 * Search the corpus. Every term must appear in an article for it to match
 * (AND, not OR) — a two-word question should narrow, not widen.
 */
export function searchHelp(query: string, limit = 12): HelpSearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9/@#.+-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  return HELP_ARTICLES.map((article) => ({
    article,
    score: scoreArticle(article, terms),
    excerpt: "",
  }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => ({ ...hit, excerpt: excerptFor(hit.article, terms) }));
}

/**
 * The articles to ground a help-agent answer in.
 *
 * Retrieval happens HERE, on the client, because the client is where the corpus
 * lives — see the module docstring. Falls back to the orientation article when
 * a question matches nothing, so the agent always has enough context to say
 * "the help section does not cover that" from a position of knowing what it
 * does cover.
 */
export function retrieveForAgent(question: string, max = 4): HelpArticle[] {
  const hits = searchHelp(question, max).map((h) => h.article);
  if (hits.length > 0) return hits;
  const fallback = getArticle("what-is-stable");
  return fallback ? [fallback] : HELP_ARTICLES.slice(0, 1);
}
