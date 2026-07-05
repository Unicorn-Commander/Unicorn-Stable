import { useState, useRef, useEffect, useMemo, createElement } from "react";
import {
  AlertTriangle,
  RotateCw,
  BriefcaseBusiness,
  ChevronDown,
  Copy as CopyIcon,
  ExternalLink,
  Link2,
  MessageSquare,
  Pencil,
  Trash2,
  Check,
  X,
  CornerDownRight,
  Smile,
  Pin,
  Quote,
  Bookmark,
  LayoutPanelLeft,
  RefreshCw,
  Square,
  CheckSquare,
  Volume2,
} from "lucide-react";
import clsx from "clsx";
import { formatDistanceToNowStrict, format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiError, type Message, type ProjectOpsProject } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { Avatar } from "@/components/Avatar";
import { identityFor } from "@/lib/identity";

const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "🤔", "✅", "🚀", "👀"];
const PO_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

type ProjectOpsPriority = (typeof PO_PRIORITIES)[number];

function projectOpsMeta(message: Message) {
  return (message.metadata as {
    projectops_task?: {
      id: string;
      project_number: string;
      task_number?: string | null;
      task_url?: string;
    };
  } | undefined)?.projectops_task;
}

/**
 * Reads the canvas-artifact pointer a Majik message carries when it authored an
 * artifact. The backend stamps `metadata.artifact_id` (+ optional
 * `metadata.artifact_title`); returns null when the message isn't tied to one.
 */
function artifactMeta(message: Message): { artifactId: string; artifactTitle: string | null } | null {
  const meta = message.metadata as {
    artifact_id?: string;
    artifact_title?: string;
  } | undefined;
  if (!meta?.artifact_id) return null;
  return { artifactId: meta.artifact_id, artifactTitle: meta.artifact_title ?? null };
}

function defaultTaskTitle(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact || "Stable message follow-up";
}

function buildDescriptionPreview(message: Message, note: string) {
  const content =
    message.content.length > 2048
      ? `${message.content.slice(0, 2048).trimEnd()}\n\n[Stable message truncated at 2048 characters]`
      : message.content;
  const permalink = `${window.location.origin}/c/${message.room_id}?message=${message.id}`;
  const parts = [];
  if (note.trim()) {
    parts.push(note.trim(), "");
  }
  parts.push(
    "Stable source message",
    `Permalink: ${permalink}`,
    `Sender: ${message.sender_name}`,
    `Timestamp: ${message.created_at}`,
    "",
    "Message:",
    content,
  );
  const metadata = { ...message.metadata };
  delete (metadata as { reactions?: unknown }).reactions;
  if (Object.keys(metadata).length > 0) {
    parts.push("", "Metadata:", JSON.stringify(metadata, null, 2));
  }
  return parts.join("\n");
}

function errorMessage(err: unknown) {
  const apiErr = err as ApiError;
  return apiErr?.detail || apiErr?.message || (err instanceof Error ? err.message : "Request failed");
}

/** Spoken names for the TeX commands the verbalizer recognizes. Unknown
 * commands are dropped wholesale (their brace contents survive). */
const TEX_WORDS: Record<string, string> = {
  cdot: "times",
  times: "times",
  div: "divided by",
  pm: "plus or minus",
  mp: "minus or plus",
  leq: "less than or equal to",
  le: "less than or equal to",
  geq: "greater than or equal to",
  ge: "greater than or equal to",
  neq: "not equal to",
  ne: "not equal to",
  approx: "approximately",
  rightarrow: "goes to",
  to: "goes to",
  int: "the integral",
  sum: "the sum",
  prod: "the product",
  lim: "the limit",
  infty: "infinity",
  sqrt: "square root of",
  partial: "partial",
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  varepsilon: "epsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  xi: "xi",
  pi: "pi",
  rho: "rho",
  sigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  varphi: "phi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
  Gamma: "gamma",
  Delta: "delta",
  Theta: "theta",
  Lambda: "lambda",
  Xi: "xi",
  Pi: "pi",
  Sigma: "sigma",
  Upsilon: "upsilon",
  Phi: "phi",
  Psi: "psi",
  Omega: "omega",
};

/** Speak an exponent: 2 and 3 get their natural English; anything else reads
 * as "to the …". */
function texPower(exp: string): string {
  const e = exp.trim();
  if (e === "2") return " squared ";
  if (e === "3") return " cubed ";
  return ` to the ${e} `;
}

/**
 * Convert a TeX math body into speakable words for TTS — "\frac{a}{b}" reads
 * as "a over b" instead of raw backslash soup. Covers the constructs agents
 * actually emit (fractions, powers, roots, greek letters, comparison
 * operators); unrecognized commands drop their name but keep brace contents.
 * Output never contains a backslash or brace.
 */
function verbalizeTex(tex: string): string {
  let s = tex;
  // Structural forms, innermost-first: each pass resolves brace groups that
  // contain no nested braces, so nesting unwinds across passes. Capped so
  // pathological input can't spin.
  for (let pass = 0; pass < 16; pass++) {
    const next = s
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 over $2 ")
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, " square root of $1 ")
      .replace(/\^\{([^{}]*)\}/g, (_m: string, exp: string) => texPower(exp))
      .replace(/_\{([^{}]*)\}/g, " sub $1 ");
    if (next === s) break;
    s = next;
  }
  return (
    s
      // Named commands: known → spoken word, unknown (\left, \text, …) → gone.
      .replace(/\\([a-zA-Z]+)/g, (_m: string, name: string) => {
        const word = TEX_WORDS[name];
        return word ? ` ${word} ` : " ";
      })
      // Bare-token powers/subscripts — x^2, a_i (brace forms already resolved
      // above; \s* absorbs the gap a replaced command leaves, e.g. `x^\pi`).
      .replace(/\^\s*([\w.]+)/g, (_m: string, exp: string) => texPower(exp))
      .replace(/_\s*([\w.]+)/g, " sub $1 ")
      // Unicode operators (looksLikeMath admits these too).
      .replace(/±/g, " plus or minus ")
      .replace(/[×·]/g, " times ")
      .replace(/÷/g, " divided by ")
      .replace(/≤/g, " less than or equal to ")
      .replace(/≥/g, " greater than or equal to ")
      .replace(/≠/g, " not equal to ")
      .replace(/≈/g, " approximately ")
      .replace(/∞/g, " infinity ")
      .replace(/√/g, " square root of ")
      .replace(/∑/g, " the sum ")
      .replace(/∫/g, " the integral ")
      // ASCII operators last, so words produced above pass through untouched.
      .replace(/=/g, " equals ")
      .replace(/\+/g, " plus ")
      .replace(/-/g, " minus ")
      .replace(/\//g, " over ")
      .replace(/</g, " less than ")
      .replace(/>/g, " greater than ")
      // Leftover braces / stray backslashes are never speakable.
      .replace(/[{}\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Replace TeX math segments with spoken words before markdown stripping runs
 * (the italic/underscore rules would otherwise mangle subscripts). Uses the
 * SAME delimiters and currency gating as the render path — shared via
 * inlineDollarMathRegexes/looksLikeMath — so "$5 vs $10" stays literal
 * dollars in speech exactly when it stays literal on screen.
 */
function speechMath(content: string): string {
  let s = content;
  // Display blocks on their own line(s): `$$ … $$` / `\[ … \]` — the same
  // line-anchored shape scanMathBlock accepts on the render path.
  s = s.replace(/^[^\S\n]*\$\$([\s\S]+?)\$\$[^\S\n]*$/gm, (_m: string, tex: string) => ` ${verbalizeTex(tex)} `);
  s = s.replace(/^[^\S\n]*\\\[([\s\S]+?)\\\][^\S\n]*$/gm, (_m: string, tex: string) => ` ${verbalizeTex(tex)} `);
  // Inline `\( … \)` — unambiguous, no gating needed.
  s = s.replace(inlineParenMathRegex(), (_m: string, tex: string) => ` ${verbalizeTex(tex)} `);
  // Inline `$…$` / mid-line `$$…$$` behind the shared currency gate.
  for (const re of inlineDollarMathRegexes()) {
    s = s.replace(re, (match: string, tex: string) =>
      looksLikeMath(tex) ? ` ${verbalizeTex(tex)} ` : match,
    );
  }
  return s;
}

/**
 * Flatten markdown into speakable prose for TTS — the engine would otherwise
 * read fence backticks, pipes, and heading hashes literally. Whole code blocks
 * become a spoken placeholder; links collapse to their text; TeX math becomes
 * spoken words via speechMath. Capped so a huge agent reply can't blow the
 * TTS request.
 */
function speechText(content: string): string {
  return speechMath(content)
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*]\s+\[[ xX]\]\s*/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "$1")
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

// One read-aloud at a time app-wide: starting a new one stops whatever is
// playing, even in a different bubble. The handle owns the Audio element and
// its object URL, so stop() from anywhere tears both down and resets the
// owning bubble's button state.
let activeSpeech: { stop: () => void } | null = null;

/** GFM table separator row, e.g. `| --- | :--: |`. Requires at least one pipe
 * so a bare `---` horizontal rule can never start a table. */
function isTableSeparator(line: string): boolean {
  return line.includes("|") && /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/.test(line);
}

/** Split a GFM table row into trimmed cells (outer pipes optional). */
function splitTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Scan for a display-math block starting at lines[start]: `$$ … $$` or
 * `\[ … \]`, single-line (`$$x^2$$`) or spanning multiple lines. Returns the
 * TeX body plus the index after the block, or null when the line doesn't open
 * one — or the opener never closes, so an unmatched `$$` stays plain text
 * instead of eating the rest of the message.
 */
function scanMathBlock(
  lines: string[],
  start: number,
): { tex: string; next: number } | null {
  const first = (lines[start] ?? "").trim();
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : null;
  if (!open) return null;
  const close = open === "$$" ? "$$" : "\\]";
  const rest = first.slice(2);
  // Single-line form: `$$x^2$$` / `\[x^2\]`.
  if (rest.length > close.length && rest.endsWith(close)) {
    const tex = rest.slice(0, -close.length).trim();
    return tex ? { tex, next: start + 1 } : null;
  }
  const buf: string[] = [rest];
  for (let j = start + 1; j < lines.length; j++) {
    const ln = lines[j] ?? "";
    if (ln.trim().endsWith(close)) {
      buf.push(ln.slice(0, ln.lastIndexOf(close)));
      const tex = buf.join("\n").trim();
      return tex ? { tex, next: j + 1 } : null;
    }
    buf.push(ln);
  }
  return null;
}

/**
 * Currency guard for inline `$…$`: only treat the span as math when the body
 * contains a backslash command or a letter/operator-ish char. "$5 and $10",
 * "$5-$10" (digits + punctuation only) stay literal dollars.
 */
function looksLikeMath(content: string): boolean {
  return /[\\a-zA-Z^_{}=<>±×÷√∑∫∞≈≠≤≥]/.test(content);
}

/**
 * Inline `$…$` / mid-line `$$…$$` matchers shared by the render path and the
 * read-aloud path so the currency gating can never drift between the two.
 * Fresh RegExp instances per call — /g regexes carry lastIndex state. The
 * opening $ must not be preceded by a word char / $ / backslash nor followed
 * by a space; the closing $ must not be preceded by a space nor followed by
 * a digit. Bodies must additionally pass looksLikeMath.
 */
function inlineDollarMathRegexes(): RegExp[] {
  return [
    /(?<![\w$\\])\$\$([^\s$](?:[^$\n]*[^\s$])?)\$\$(?!\d)/g,
    /(?<![\w$\\])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/g,
  ];
}

/** Inline `\( … \)` matcher, shared like the above — unambiguous, so no
 * currency gating applies. */
function inlineParenMathRegex(): RegExp {
  return /\\\(([^\n]+?)\\\)/g;
}

// Lazy-import KaTeX (and its stylesheet) the same way as hljs below: the
// first math span in any message triggers the load, then it's cached for the
// session. Messages without math never pay the ~270KB cost. Vite splits the
// dynamically-imported stylesheet into its own chunk and injects it on load.
let _katex: typeof import("katex").default | null = null;
let _katexLoading: Promise<void> | null = null;
function loadKatex(): Promise<void> {
  if (_katex) return Promise.resolve();
  if (_katexLoading) return _katexLoading;
  _katexLoading = Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([m]) => {
    _katex = m.default;
  });
  return _katexLoading;
}

/**
 * Subscribe a component to the lazy KaTeX module: returns it when loaded,
 * null before then (callers render the raw TeX as a placeholder), and
 * re-renders the component once the chunk lands.
 */
function useKatex(): typeof import("katex").default | null {
  const [ready, setReady] = useState(_katex !== null);
  useEffect(() => {
    if (ready) return;
    let active = true;
    void loadKatex().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [ready]);
  return _katex;
}

/** KaTeX display-math block. renderToString output is sanitized by
 * construction (KaTeX escapes its input; throwOnError:false renders bad TeX
 * as literal text instead of throwing). Wide equations scroll inside their
 * own strip rather than breaking the bubble; KaTeX inherits currentColor, so
 * text-slate-100 pins the equation to content color on the dark theme. */
function MathBlock({ tex }: { tex: string }) {
  const katex = useKatex();
  const html = useMemo(
    () =>
      katex
        ? katex.renderToString(tex, { displayMode: true, throwOnError: false })
        : null,
    [katex, tex],
  );
  // Module still in flight: show the raw TeX in a quiet code-ish strip; the
  // useKatex re-render swaps in the real equation once the chunk lands.
  if (html === null) {
    return (
      <div className="my-2 overflow-x-auto py-1 font-mono text-xs text-slate-400">
        {tex}
      </div>
    );
  }
  return (
    <div
      className="my-2 overflow-x-auto py-1 text-slate-100"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Inline KaTeX span — same sanitized-by-construction contract as MathBlock,
 * with the raw TeX shown code-style until the lazy module lands. */
function InlineMath({ tex }: { tex: string }) {
  const katex = useKatex();
  if (!katex) {
    return (
      <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[13px] text-slate-300">
        {tex}
      </span>
    );
  }
  return (
    <span
      className="text-slate-100"
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(tex, { throwOnError: false }),
      }}
    />
  );
}

// Lazy-import highlight.js so the main bundle stays small. First code block
// in any message triggers the load, then it's cached for the session.
let _hljs: typeof import("highlight.js").default | null = null;
let _hljsLoading: Promise<void> | null = null;
function loadHljs(): Promise<void> {
  if (_hljs) return Promise.resolve();
  if (_hljsLoading) return _hljsLoading;
  _hljsLoading = import("highlight.js").then((m) => {
    _hljs = m.default;
  });
  return _hljsLoading;
}

function CodeBlock({ lang, content }: { lang: string | null; content: string }) {
  const [html, setHtml] = useState<string | null>(null);
  // Language highlightAuto guessed when no fence language was given — shown in
  // the header instead of the generic "code" label.
  const [autoLang, setAutoLang] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    loadHljs().then(() => {
      if (!active || !_hljs) return;
      try {
        if (lang && _hljs.getLanguage(lang)) {
          setHtml(_hljs.highlight(content, { language: lang, ignoreIllegals: true }).value);
          setAutoLang(null);
        } else {
          const result = _hljs.highlightAuto(content);
          setHtml(result.value);
          setAutoLang(result.language ?? null);
        }
      } catch {
        setHtml(null);
        setAutoLang(null);
      }
    });
    return () => {
      active = false;
    };
  }, [lang, content]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }
  return (
    <div className="group/code relative my-2 overflow-hidden rounded-xl border border-line bg-slate-950/80">
      {/* Header bar: language label + hover "Copy" — standard in
          OpenWebUI/Discord/Slack. */}
      <div className="flex items-center justify-between gap-2 border-b border-line bg-white/[0.03] px-3 py-1.5">
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-slate-500">
          {lang || autoLang || "code"}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-slate-400 opacity-0 transition hover:bg-white/[0.06] hover:text-slate-100 focus:opacity-100 focus-ring group-hover/code:opacity-100"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <CopyIcon className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        {html ? (
          <code
            className={`hljs ${lang ? `language-${lang}` : ""} text-slate-200`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <code className="text-slate-300">{content}</code>
        )}
      </pre>
    </div>
  );
}

/**
 * In-app image viewer for image attachments: full-screen dimmed overlay with
 * the image centered at up to 90% of the viewport. Click-outside or Esc
 * closes; "Open original" keeps the old open-in-new-tab behavior for
 * full-res viewing / save-as. Non-image attachments never route here.
 */
function ImageLightbox({
  url,
  filename,
  onClose,
}: {
  url: string;
  filename: string;
  onClose: () => void;
}) {
  // Mount at scale-95, release to scale-100 on the next frame — a subtle
  // scale-in from existing transition utilities, no bespoke keyframe needed.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={filename}
    >
      <img
        src={url}
        alt={filename}
        onClick={(e) => e.stopPropagation()}
        className={clsx(
          "max-h-[90%] max-w-[90%] rounded-xl object-contain shadow-pop transition-transform duration-200 ease-out",
          entered ? "scale-100" : "scale-95",
        )}
      />
      <div
        className="glass-heavy absolute bottom-4 left-1/2 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-xs shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="max-w-[40ch] truncate text-slate-300" title={filename}>
          {filename}
        </span>
        <span aria-hidden="true" className="h-3 w-px shrink-0 bg-white/15" />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-slate-200 transition-colors hover:bg-white/[0.08] hover:text-slate-100 focus-ring"
        >
          <ExternalLink className="h-3 w-3" /> Open original
        </a>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-slate-200 focus-ring"
          aria-label="Close image viewer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function QuickReact({ onReact }: { onReact: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
        aria-label="Add reaction"
      >
        <Smile className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className="glass-heavy absolute bottom-full right-0 mb-1 flex gap-0.5 rounded-xl p-1 shadow-pop"
          onMouseLeave={() => setOpen(false)}
        >
          {QUICK_EMOJI.map((e) => (
            <button
              key={e}
              onClick={() => {
                setOpen(false);
                onReact(e);
              }}
              className="rounded-md px-1 py-0.5 text-base transition-colors hover:bg-white/[0.08] focus-ring"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolFooter({ rawHtml }: { rawHtml: string }) {
  // Brigade emits inner HTML with <br>, code, etc. Strip tags and split into
  // bullet items for a clean chip view. Preserves text content.
  const text = rawHtml
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
  const items = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  return (
    <details className="mt-2 rounded-lg border border-line bg-slate-950/40 p-2 text-xs">
      <summary className="focus-ring cursor-pointer select-none rounded text-slate-400 transition-colors hover:text-slate-200">
        🔧 Tools used ({items.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-1 pl-2 text-slate-300">
        {items.map((it, i) => (
          <li key={i} className="font-mono text-[11px] leading-relaxed">
            {it}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PollCard({
  messageId,
  poll,
  reactions,
}: {
  messageId: string;
  poll: { question: string; options: string[] };
  reactions: Record<string, string[]> | null;
}) {
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  // Encode votes as reaction emojis: 1️⃣ 2️⃣ … so they share storage with
  // normal reactions (no new schema). 10 max options.
  const VOTE_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  const totalVotes = poll.options.reduce(
    (sum, _opt, i) => sum + ((reactions?.[VOTE_EMOJI[i]!] ?? []).length),
    0,
  );
  return (
    <div className="my-2 max-w-md rounded-xl border border-stable-purple/25 bg-stable-purple/[0.06] p-3">
      <p className="mb-2 text-sm font-medium text-slate-100">{poll.question}</p>
      <ul className="flex flex-col gap-1.5">
        {poll.options.map((opt, i) => {
          const emoji = VOTE_EMOJI[i]!;
          const voters = reactions?.[emoji] ?? [];
          const mine = currentUserId ? voters.includes(currentUserId) : false;
          const pct = totalVotes > 0 ? Math.round((voters.length / totalVotes) * 100) : 0;
          return (
            <li key={i}>
              <button
                onClick={() => api.toggleReaction(messageId, emoji).catch(() => {})}
                className={clsx(
                  "relative flex w-full items-center gap-2 overflow-hidden rounded-lg border px-2 py-1.5 text-left text-xs transition-colors focus-ring",
                  mine
                    ? "border-stable-purple/60 bg-stable-purple/15 text-slate-100"
                    : "border-line text-slate-300 hover:border-line-strong hover:bg-white/[0.04]",
                )}
              >
                <span
                  className="absolute inset-y-0 left-0 bg-stable-purple/20"
                  style={{ width: `${pct}%` }}
                />
                <span className="relative">{emoji}</span>
                <span className="relative flex-1 truncate">{opt}</span>
                <span className="relative text-[10px] tabular-nums text-slate-400">
                  {voters.length} ({pct}%)
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[10px] text-slate-500">
        {totalVotes} {totalVotes === 1 ? "vote" : "votes"} · click to vote
      </p>
    </div>
  );
}

function ReactionRow({
  reactions,
  onToggle,
}: {
  reactions: Record<string, string[]> | null;
  onToggle: (emoji: string) => void;
}) {
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  if (!reactions || Object.keys(reactions).length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {Object.entries(reactions).map(([emoji, users]) => {
        const mine = currentUserId ? users.includes(currentUserId) : false;
        return (
          <button
            key={emoji}
            onClick={() => onToggle(emoji)}
            className={clsx(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors focus-ring",
              mine
                ? "border-stable-purple/40 bg-stable-purple/15 text-stable-purple-light"
                : "border-line bg-white/[0.05] text-slate-300 hover:border-line-strong hover:bg-white/[0.08]",
            )}
            aria-label={`${emoji} ${users.length}`}
          >
            <span>{emoji}</span>
            <span className="text-[10px] tabular-nums">{users.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function PromoteToProjectOpsModal({
  message,
  onClose,
  onPromoted,
}: {
  message: Message;
  onClose: () => void;
  onPromoted: (data: {
    task_id: string;
    project_number: string;
    task_url: string;
    task_number: string | null;
  }) => void;
}) {
  const [projects, setProjects] = useState<ProjectOpsProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectNumber, setProjectNumber] = useState("");
  const [title, setTitle] = useState(defaultTaskTitle(message.content));
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<ProjectOpsPriority>("MEDIUM");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingProjects(true);
    api
      .getProjectOpsProjects()
      .then((rows) => {
        if (!active) return;
        setProjects(rows);
        setProjectNumber((current) => current || rows[0]?.projectNumber || "");
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoadingProjects(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const preview = buildDescriptionPreview(message, description);

  async function submit() {
    if (!projectNumber || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.promoteToProjectOpsTask(message.id, {
        project_number: projectNumber,
        title,
        description,
        priority,
      });
      onPromoted(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm">
      <div className="glass-heavy w-full max-w-xl overflow-hidden rounded-2xl shadow-pop animate-slide-up">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="gradient-bg grid h-7 w-7 shrink-0 place-items-center rounded-lg">
              <BriefcaseBusiness className="h-3.5 w-3.5 text-white" />
            </span>
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Promote to Project Ops task
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 focus-ring"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 px-4 py-3">
          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Project
            <select
              value={projectNumber}
              onChange={(e) => setProjectNumber(e.target.value)}
              disabled={loadingProjects}
              className="rounded-xl border border-line bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            >
              {loadingProjects && <option>Loading projects...</option>}
              {!loadingProjects && projects.length === 0 && <option>No projects found</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.projectNumber}>
                  {project.projectNumber} - {project.title}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-xl border border-line bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
          </label>

          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Priority
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as ProjectOpsPriority)}
              className="rounded-xl border border-line bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            >
              {PO_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Description note
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="resize-none rounded-xl border border-line bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
          </label>

          <label className="grid gap-1 text-xs font-medium text-slate-400">
            Description preview
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-slate-950/60 p-3 text-xs font-normal leading-relaxed text-slate-300">
              {preview}
            </pre>
          </label>

          {error && (
            <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-xl border border-line bg-surface-2 px-3.5 py-1.5 text-sm text-slate-300 transition hover:border-line-strong hover:bg-surface-3 focus-ring"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!projectNumber || submitting}
            className="gradient-bg rounded-xl px-4 py-1.5 text-sm font-semibold text-white shadow-glow-iris transition hover:opacity-95 active:scale-[0.98] focus-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onReply: (messageId: string) => void;
  onRetry?: (messageId: string) => Promise<void>;
  /** When this becomes true, the bubble enters edit mode (one-shot rising edge). */
  forceEditTick?: number;
  /** Label of the room's model override, if any — agent replies get a "via …"
   * chip so overridden traffic is always visibly badged. */
  overrideModelLabel?: string | null;
}

export function MessageBubble({
  message,
  isOwn,
  showAvatar,
  onEdit,
  onDelete,
  onReply,
  onRetry,
  forceEditTick,
  overrideModelLabel,
}: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Chevron half of the regenerate split control — a compact model menu.
  const [regenMenuOpen, setRegenMenuOpen] = useState(false);
  // Image attachment currently open in the in-app lightbox.
  const [lightbox, setLightbox] = useState<{ url: string; filename: string } | null>(null);
  const promoted = projectOpsMeta(message);
  const artifact = artifactMeta(message);
  const pushToast = useAppStore((s) => s.pushToast);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const currentUserId = useAppStore((s) => s.currentUser?.id);

  const serverReactions =
    (message.metadata as { reactions?: Record<string, string[]> } | undefined)
      ?.reactions ?? null;
  // Optimistic reaction overlay: shows the toggled state immediately instead
  // of waiting on the ws echo. The echo rewrites metadata.reactions (new
  // reference), which discards the overlay via the effect below — server
  // truth always wins once it arrives.
  const [reactionOverlay, setReactionOverlay] =
    useState<Record<string, string[]> | null>(null);
  useEffect(() => {
    setReactionOverlay(null);
  }, [serverReactions]);

  function handleToggleReaction(emoji: string) {
    if (currentUserId) {
      const base = reactionOverlay ?? serverReactions ?? {};
      const users = base[emoji] ?? [];
      const next: Record<string, string[]> = {
        ...base,
        [emoji]: users.includes(currentUserId)
          ? users.filter((u) => u !== currentUserId)
          : [...users, currentUserId],
      };
      if (next[emoji]!.length === 0) delete next[emoji];
      setReactionOverlay(next);
    }
    api.toggleReaction(message.id, emoji).catch((err) => {
      setReactionOverlay(null);
      pushToast({ title: "Reaction failed", body: errorMessage(err) });
    });
  }

  function handleTogglePin() {
    api
      .togglePin(message.room_id, message.id)
      .then((pins) =>
        pushToast({
          title: pins.includes(message.id) ? "Pinned to room" : "Unpinned",
        }),
      )
      .catch((err) => pushToast({ title: "Pin failed", body: errorMessage(err) }));
  }

  function handleToggleSave() {
    api
      .toggleSave(message.id)
      .then((updated) => {
        // The updated message carries saved_by when the backend exposes it;
        // fall back to generic phrasing when it doesn't.
        const savedBy = (updated.metadata as { saved_by?: string[] } | undefined)
          ?.saved_by;
        const title =
          Array.isArray(savedBy) && currentUserId
            ? savedBy.includes(currentUserId)
              ? "Saved"
              : "Removed from saved"
            : "Saved";
        pushToast({ title });
      })
      .catch((err) => pushToast({ title: "Save failed", body: errorMessage(err) }));
  }

  // Models for "regenerate with…" — same query key as ModelSwitcher so the
  // list is fetched once and shared; only fetched when the menu first opens.
  const { data: regenModels = [] } = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => api.getModels(),
    staleTime: 5 * 60_000,
    enabled: regenMenuOpen,
  });

  // Close the regenerate-model menu on any window click or escape (mirrors
  // the context-menu dismissal below).
  useEffect(() => {
    if (!regenMenuOpen) return;
    function onAway() {
      setRegenMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setRegenMenuOpen(false);
    }
    window.addEventListener("click", onAway);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onAway);
      window.removeEventListener("keydown", onKey);
    };
  }, [regenMenuOpen]);

  /** Re-run the responder on this reply — optionally forcing a specific model
   * for the new attempt (the chevron menu path). */
  function runRegenerate(model?: string) {
    if (regenerating) return;
    setRegenMenuOpen(false);
    setRegenerating(true);
    void api
      .regenerateReply(message.id, model)
      .catch((err) => {
        // 409 = someone already regenerated this reply (double-tap /
        // two members). Benign and expected — don't alarm the user.
        if ((err as ApiError)?.status === 409) return;
        pushToast({
          title: "Regenerate failed",
          body: errorMessage(err),
        });
      })
      .finally(() => setRegenerating(false));
  }

  // Read-aloud lifecycle. "loading" = TTS blob in flight, "speaking" = audio
  // playing; a second click in either state stops. The module-level
  // activeSpeech singleton guarantees at most one voice app-wide.
  const [ttsState, setTtsState] = useState<"idle" | "loading" | "speaking">("idle");
  const ttsHandleRef = useRef<{ stop: () => void } | null>(null);
  // Unmount (room switch, delete) must not leak a playing Audio / object URL.
  useEffect(() => () => ttsHandleRef.current?.stop(), []);

  function handleReadAloud() {
    if (ttsHandleRef.current) {
      ttsHandleRef.current.stop();
      return;
    }
    activeSpeech?.stop();
    setTtsState("loading");
    let cancelled = false;
    let audio: HTMLAudioElement | null = null;
    let url: string | null = null;
    const handle = {
      stop() {
        cancelled = true;
        audio?.pause();
        if (url) URL.revokeObjectURL(url);
        if (activeSpeech === handle) activeSpeech = null;
        if (ttsHandleRef.current === handle) ttsHandleRef.current = null;
        setTtsState("idle");
      },
    };
    activeSpeech = handle;
    ttsHandleRef.current = handle;
    // Per-agent voice: the backend maps the agent identifier to that agent's
    // voice-call preset. Prefer an explicit brigade agent id stamped on the
    // message (stable slug like "majik"); fall back to the display name,
    // which the backend normalizes.
    const voiceAgent =
      (message.metadata as { brigade_agent_id?: string } | undefined)
        ?.brigade_agent_id || message.sender_name;
    void api
      .ttsSpeech(speechText(message.content), { agent: voiceAgent })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.onended = () => handle.stop();
        audio.onerror = () => handle.stop();
        return audio.play().then(() => {
          if (!cancelled) setTtsState("speaking");
        });
      })
      .catch((err) => {
        if (cancelled) return;
        handle.stop();
        pushToast({
          title: "Read-aloud failed",
          body: errorMessage(err) || "TTS service unreachable",
        });
      });
  }

  // Close context menu on any window click or escape.
  useEffect(() => {
    if (!ctxMenu) return;
    function onAway() {
      setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCtxMenu(null);
    }
    window.addEventListener("click", onAway);
    window.addEventListener("contextmenu", onAway);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onAway);
      window.removeEventListener("contextmenu", onAway);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);
  const [editing, setEditing] = useState(false);
  const failed = Boolean(
    (message.metadata as { failed?: boolean } | undefined)?.failed,
  );
  const failedError = (message.metadata as { failed_error?: string } | undefined)?.failed_error;
  const [editContent, setEditContent] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.selectionStart = editRef.current.value.length;
    }
  }, [editing]);

  // Cmd+Up trigger from MessageInput — enter edit on rising-edge tick.
  useEffect(() => {
    if (forceEditTick && forceEditTick > 0 && !editing) {
      setEditContent(message.content);
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceEditTick]);

  function handleEditSubmit() {
    if (editContent.trim() && editContent !== message.content) {
      onEdit(message.id, editContent.trim());
    }
    setEditing(false);
  }

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleEditSubmit();
    }
    if (e.key === "Escape") {
      setEditing(false);
      setEditContent(message.content);
    }
  }

  function handlePromoted(result: {
    task_id: string;
    project_number: string;
    task_url: string;
    task_number: string | null;
  }) {
    const nextMeta = {
      ...message.metadata,
      projectops_task: {
        id: result.task_id,
        project_number: result.project_number,
        task_number: result.task_number,
        task_url: result.task_url,
      },
    };
    updateMessage(message.room_id, message.id, { metadata: nextMeta });
    pushToast({
      title: `Task created: ${result.task_number || result.project_number}`,
      body: result.task_url,
    });
    setPromoteOpen(false);
  }

  function renderTimestamp() {
    try {
      const date = new Date(message.created_at);
      const relative = formatDistanceToNowStrict(date, { addSuffix: true });
      const full = format(date, "MMM d, yyyy 'at' h:mm a");
      return (
        <time
          dateTime={message.created_at}
          title={full}
          className="text-[11px] text-slate-500 tabular-nums"
        >
          {relative}
        </time>
      );
    } catch {
      return null;
    }
  }

  if (message.sender_type === "system") {
    return (
      <div className="flex justify-center py-2">
        <p className="rounded-full border border-line bg-white/[0.04] px-4 py-1 text-xs text-slate-400">
          {message.content}
        </p>
      </div>
    );
  }

  const isAgent = message.sender_type === "agent";
  // Identity hue for this resident — drives the sender name, AI chip, and the
  // tinted agent-reply card.
  const ident = identityFor(message.sender_id, message.sender_name);
  // An agent reply that is still being produced. Driven purely by the ws
  // streaming flag (set on the placeholder, cleared on finalize) — NOT the "…"
  // content, so a persisted/crashed placeholder can never strand a Stop pill on
  // a message with no live responder behind it.
  const isGenerating = isAgent && message.streaming === true;
  // Placeholder-only content (dots/ellipsis while the agent spins up) — the
  // shimmer goes on this, never on real streamed tokens.
  const isPlaceholder = isGenerating && /^[\s.…]*$/.test(message.content);

  if (message.content_type === "action") {
    const decision = (
      message.metadata as { decision?: "approved" | "rejected"; decided_by_name?: string } | undefined
    )?.decision;
    const decidedBy = (
      message.metadata as { decided_by_name?: string } | undefined
    )?.decided_by_name;
    return (
      <div className="my-2 flex justify-center px-4">
        <div className="glass-heavy max-w-md rounded-2xl p-4 shadow-pop">
          <div className="mb-3 flex items-start gap-2">
            <Avatar
              name={message.sender_name}
              src={message.sender_avatar}
              size="sm"
              isAgent={isAgent}
              id={message.sender_id}
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-200">
                {message.sender_name} requests approval
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">
                {message.content}
              </p>
            </div>
          </div>
          {decision ? (
            <div
              className={clsx(
                "rounded-md px-3 py-1.5 text-xs font-medium",
                decision === "approved"
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-rose-500/15 text-rose-300",
              )}
            >
              {decision === "approved" ? "✓ Approved" : "✗ Rejected"}
              {decidedBy ? ` by ${decidedBy}` : ""}
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() =>
                  api
                    .decideAction(message.id, "approved")
                    .catch((e) =>
                      pushToast({ title: "Approve failed", body: errorMessage(e) }),
                    )
                }
                className="flex-1 rounded-lg bg-emerald-500/15 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/25 focus-ring"
              >
                Approve
              </button>
              <button
                onClick={() =>
                  api
                    .decideAction(message.id, "rejected")
                    .catch((e) =>
                      pushToast({ title: "Reject failed", body: errorMessage(e) }),
                    )
                }
                className="flex-1 rounded-lg bg-rose-500/15 py-1.5 text-xs font-semibold text-rose-300 transition-colors hover:bg-rose-500/25 focus-ring"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Detect Brigade's tool-use footer (HTML `<details>` block) and split it
  // off so we can render the body normally and the tools as a styled chip.
  function splitToolsFooter(content: string): { body: string; tools: string | null } {
    const m = content.match(/<details>\s*<summary>(?:🔧|🛠️)?\s*([^<]*)<\/summary>([\s\S]*?)<\/details>/i);
    if (!m) return { body: content, tools: null };
    const before = content.slice(0, m.index ?? 0).trimEnd();
    const after = content.slice((m.index ?? 0) + m[0].length).trimStart();
    return {
      body: (before + (after ? "\n\n" + after : "")).trim(),
      tools: (m[2] ?? "").trim(),
    };
  }

  function renderContent(content: string) {
    // Pull fenced code blocks out first; whatever's left is inline+block markdown.
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    const parts: Array<{ type: "text" | "code"; content: string; lang?: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: "text", content: content.slice(lastIndex, match.index) });
      }
      parts.push({ type: "code", content: match[2] ?? "", lang: match[1] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < content.length) {
      parts.push({ type: "text", content: content.slice(lastIndex) });
    }
    if (parts.length === 0) parts.push({ type: "text", content });

    return parts.map((part, i) => {
      if (part.type === "code") {
        return <CodeBlock key={i} lang={part.lang ?? null} content={part.content} />;
      }
      return <span key={i}>{renderTextBlock(part.content)}</span>;
    });
  }

  /**
   * Block-level markdown for a chunk of plain text (no fenced code in here).
   * Recognises: # / ## / ### headings, > blockquote, -/* unordered list,
   * 1. ordered list, otherwise paragraph. Inline formatting runs inside each.
   */
  function renderTextBlock(text: string): React.ReactNode {
    const lines = text.split("\n");
    const out: React.ReactElement[] = [];
    let i = 0;
    let key = 0;

    function pushLines(rendered: React.ReactNode[]) {
      out.push(<span key={key++}>{rendered}</span>);
    }

    while (i < lines.length) {
      const line = lines[i] ?? "";

      // Display math: `$$ … $$` / `\[ … \]` on its own line(s). An opener
      // that never closes falls through and renders as plain text.
      const mathBlk = scanMathBlock(lines, i);
      if (mathBlk) {
        out.push(<MathBlock key={key++} tex={mathBlk.tex} />);
        i = mathBlk.next;
        continue;
      }

      // Heading
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1]!.length;
        const body = heading[2]!;
        const cls =
          level === 1
            ? "text-base font-bold text-slate-100 mt-1"
            : level === 2
              ? "text-sm font-bold text-slate-100 mt-1"
              : "text-sm font-semibold text-slate-200 mt-1";
        const tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
        out.push(
          createElement(
            tag,
            { key: key++, className: cls },
            renderInlineContent(body),
          ),
        );
        i++;
        continue;
      }

      // GFM table: a pipe-bearing header row followed by a |---|---| separator.
      // Wide tables scroll inside their own wrapper instead of breaking the
      // bubble. Rows shorter than the header get empty trailing cells.
      if (line.includes("|") && isTableSeparator(lines[i + 1] ?? "")) {
        const header = splitTableRow(line);
        const aligns = splitTableRow(lines[i + 1] ?? "").map((c) =>
          c.startsWith(":") && c.endsWith(":")
            ? ("center" as const)
            : c.endsWith(":")
              ? ("right" as const)
              : ("left" as const),
        );
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && (lines[i] ?? "").includes("|")) {
          rows.push(splitTableRow(lines[i]!));
          i++;
        }
        out.push(
          <div
            key={key++}
            className="my-2 overflow-x-auto rounded-lg border border-line"
          >
            <table className="w-full min-w-max border-collapse text-xs">
              <thead>
                <tr className="bg-slate-950/60">
                  {header.map((h, hi) => (
                    <th
                      key={hi}
                      className="border-b border-line px-2.5 py-1.5 font-semibold text-slate-200"
                      style={{ textAlign: aligns[hi] ?? "left" }}
                    >
                      {renderInlineContent(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr
                    key={ri}
                    className={ri < rows.length - 1 ? "border-b border-line" : undefined}
                  >
                    {header.map((_h, ci) => (
                      <td
                        key={ci}
                        className="px-2.5 py-1.5 text-slate-300"
                        style={{ textAlign: aligns[ci] ?? "left" }}
                      >
                        {renderInlineContent(r[ci] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }

      // Blockquote run
      if (line.startsWith("> ") || line === ">") {
        const buf: string[] = [];
        while (
          i < lines.length &&
          (lines[i]!.startsWith("> ") || lines[i] === ">")
        ) {
          buf.push((lines[i]!.replace(/^>\s?/, "")) || "");
          i++;
        }
        out.push(
          <blockquote
            key={key++}
            className="my-1 border-l-2 border-stable-purple/40 pl-3 text-slate-400"
          >
            {buf.map((b, bi) => (
              <span key={bi}>
                {renderInlineContent(b)}
                {bi < buf.length - 1 && <br />}
              </span>
            ))}
          </blockquote>,
        );
        continue;
      }

      // Unordered list
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
          items.push(lines[i]!.replace(/^[-*]\s+/, ""));
          i++;
        }
        out.push(
          <ul key={key++} className="my-1 list-disc pl-5 marker:text-slate-500">
            {items.map((it, idx) => {
              // Task-list item: `[ ]` / `[x]` after the bullet. Read-only —
              // the glyph shows state, it doesn't toggle anything.
              const task = it.match(/^\[([ xX])\]\s*(.*)$/);
              if (!task) return <li key={idx}>{renderInlineContent(it)}</li>;
              const checked = task[1] !== " ";
              return (
                <li key={idx} className="-ml-5 flex list-none items-start gap-1.5">
                  {checked ? (
                    <CheckSquare
                      aria-hidden="true"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stable-mint"
                    />
                  ) : (
                    <Square
                      aria-hidden="true"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500"
                    />
                  )}
                  <span className={checked ? "text-slate-400" : undefined}>
                    {renderInlineContent(task[2] ?? "")}
                  </span>
                </li>
              );
            })}
          </ul>,
        );
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
          items.push(lines[i]!.replace(/^\d+\.\s+/, ""));
          i++;
        }
        out.push(
          <ol key={key++} className="my-1 list-decimal pl-5 marker:text-slate-500">
            {items.map((it, idx) => (
              <li key={idx}>{renderInlineContent(it)}</li>
            ))}
          </ol>,
        );
        continue;
      }

      // Plain line(s)
      const buf: React.ReactNode[] = [];
      while (i < lines.length) {
        const ln = lines[i] ?? "";
        if (
          ln.match(/^(#{1,3})\s+/) ||
          ln.startsWith("> ") || ln === ">" ||
          /^[-*]\s+/.test(ln) ||
          /^\d+\.\s+/.test(ln) ||
          (ln.includes("|") && isTableSeparator(lines[i + 1] ?? "")) ||
          scanMathBlock(lines, i) !== null
        ) {
          break;
        }
        if (buf.length > 0) buf.push(<br key={`br-${i}`} />);
        buf.push(<span key={`ln-${i}`}>{renderInlineContent(ln)}</span>);
        i++;
      }
      if (buf.length > 0) pushLines(buf);
    }
    return out;
  }

  function renderInlineContent(text: string) {
    // Inline: URL, `code`, **bold**, *italic*/_italic_, ~~strike~~.
    // Build a non-overlapping set of spans, longest-first to win on overlaps.
    const elements: Array<{
      type: "url" | "code" | "bold" | "italic" | "strike" | "mention" | "math";
      content: string;
      start: number;
      end: number;
    }> = [];
    const collect = (
      re: RegExp,
      type: "url" | "code" | "bold" | "italic" | "strike" | "mention" | "math",
      group: number,
    ) => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        elements.push({
          type,
          content: m[group] ?? m[0],
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    };
    collect(/(@channel\b|@here\b|@[\w-]+)/g, "mention", 0);
    collect(/(https?:\/\/[^\s]+)/g, "url", 0);
    collect(/`([^`\n]+)`/g, "code", 1);
    collect(/\*\*([^*\n]+)\*\*/g, "bold", 1);
    collect(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "italic", 1);
    collect(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "italic", 1);
    collect(/~~([^~\n]+)~~/g, "strike", 1);
    // Inline math. `\( … \)` is unambiguous, so it collects unconditionally.
    collect(inlineParenMathRegex(), "math", 1);
    // `$…$` (and mid-line `$$…$$`) is gated hard against currency — see
    // inlineDollarMathRegexes (shared with the read-aloud path) — plus the
    // looksLikeMath body check. "$5 and $10" survives as dollars ("5 and "
    // has a trailing space AND is digits/punct only).
    for (const re of inlineDollarMathRegexes()) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const body = m[1] ?? "";
        if (!looksLikeMath(body)) continue;
        elements.push({
          type: "math",
          content: body,
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    }

    if (elements.length === 0) return text;

    // Resolve overlaps: prefer earlier start, then larger span.
    elements.sort((a, b) => a.start - b.start || b.end - a.end - (a.end - a.start));
    const filtered: typeof elements = [];
    let lastEnd = -1;
    for (const el of elements) {
      if (el.start >= lastEnd) {
        filtered.push(el);
        lastEnd = el.end;
      }
    }

    const result: Array<string | React.ReactElement> = [];
    let cursor = 0;
    filtered.forEach((el, i) => {
      if (el.start > cursor) result.push(text.slice(cursor, el.start));
      if (el.type === "url") {
        result.push(
          <a
            key={`link-${i}`}
            href={el.content}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stable-cyan underline decoration-stable-cyan/40 transition-colors hover:text-stable-cyan-light hover:decoration-stable-cyan"
          >
            {el.content}
          </a>,
        );
      } else if (el.type === "code") {
        result.push(
          <code
            key={`c-${i}`}
            className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[13px] text-stable-cyan-light"
          >
            {el.content}
          </code>,
        );
      } else if (el.type === "bold") {
        result.push(
          <strong key={`b-${i}`} className="font-semibold">
            {el.content}
          </strong>,
        );
      } else if (el.type === "italic") {
        result.push(
          <em key={`i-${i}`} className="italic">
            {el.content}
          </em>,
        );
      } else if (el.type === "strike") {
        result.push(
          <s key={`s-${i}`} className="text-slate-500">
            {el.content}
          </s>,
        );
      } else if (el.type === "math") {
        // Lazy KaTeX: InlineMath shows the raw TeX code-style until the
        // module chunk lands, then re-renders itself with the real markup.
        result.push(<InlineMath key={`math-${i}`} tex={el.content} />);
      } else if (el.type === "mention") {
        const isBroad = el.content === "@channel" || el.content === "@here";
        result.push(
          <span
            key={`m-${i}`}
            className={
              isBroad
                ? "rounded bg-amber-500/20 px-1 py-0.5 font-medium text-amber-300"
                : "rounded bg-stable-purple/20 px-1 py-0.5 font-medium text-stable-purple-light"
            }
          >
            {el.content}
          </span>,
        );
      }
      cursor = el.end;
    });
    if (cursor < text.length) result.push(text.slice(cursor));
    return result;
  }

  return (
    <div
      className={clsx(
        "group relative flex gap-3 rounded-xl px-2 py-1 transition-colors",
        // Group rhythm: heads of a sender-group breathe, continuations tighten.
        showAvatar && "mt-2",
        hovered && "bg-white/[0.03]",
        !showAvatar && "pl-12",
        failed && "border-l-2 border-rose-500/70 bg-rose-500/5",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      role="article"
      aria-label={`Message from ${message.sender_name}`}
    >
      {showAvatar && (
        <div className="mt-0.5 shrink-0">
          <Avatar
            name={message.sender_name}
            src={message.sender_avatar}
            size="md"
            isAgent={isAgent}
            id={message.sender_id}
          />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Agent turns read as tinted identity cards (recipe 4.2); human turns
            stay unboxed — the asymmetry is deliberate. */}
        <div
          className={clsx(isAgent && "relative rounded-xl border px-3.5 py-2.5")}
          style={
            isAgent
              ? { background: ident.faint, borderColor: ident.border }
              : undefined
          }
        >
        {isAgent && (
          <span
            aria-hidden="true"
            className="absolute bottom-2 left-0 top-2 w-[3px] rounded-full"
            style={{ background: ident.color }}
          />
        )}
        {showAvatar && (
          <div className="mb-1 flex items-center gap-2">
            <span
              className="text-sm font-semibold"
              style={{ color: ident.text }}
            >
              {message.sender_name}
            </span>
            {isAgent && (
              <span
                className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: ident.soft, color: ident.text }}
              >
                AI
              </span>
            )}
            {isAgent && overrideModelLabel && (
              <span
                className="rounded-md border border-stable-cyan/25 bg-stable-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-stable-cyan/90"
                title="This room overrides the agent's default model — reset it from the model chip in the header"
              >
                via {overrideModelLabel}
              </span>
            )}
            {renderTimestamp()}
            {promoted && (
              <a
                href={promoted.task_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 focus-ring"
                title="Open Project Ops task"
              >
                <BriefcaseBusiness className="h-3 w-3" />
                {promoted.task_number || promoted.project_number}
              </a>
            )}
            {artifact && (
              <button
                type="button"
                onClick={() =>
                  void useCanvasStore.getState().openArtifactById(artifact.artifactId)
                }
                className="inline-flex items-center gap-1 rounded-md bg-stable-purple/10 px-1.5 py-0.5 text-[10px] font-medium text-stable-purple-light transition-colors hover:bg-stable-purple/20 focus-ring"
                title={artifact.artifactTitle ? `Open "${artifact.artifactTitle}" in canvas` : "Open in canvas"}
              >
                <LayoutPanelLeft className="h-3 w-3" />
                {artifact.artifactTitle ? `Open "${artifact.artifactTitle}" in canvas` : "Open in canvas"}
              </button>
            )}
          </div>
        )}

        {editing ? (
          <div className="flex flex-col gap-1">
            <textarea
              ref={editRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleEditKeyDown}
              className="min-h-[2.5rem] resize-none rounded-xl border border-line bg-slate-950/60 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
              rows={2}
            />
            <div className="flex items-center gap-1 text-[11px] text-slate-500">
              <span>Escape to cancel</span>
              <span className="mx-1 text-slate-600">·</span>
              <span>Enter to save</span>
              <div className="ml-auto flex gap-1">
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditContent(message.content);
                  }}
                  className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200 focus-ring"
                  aria-label="Cancel edit"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={handleEditSubmit}
                  className="rounded-md p-1 text-emerald-400 transition-colors hover:bg-emerald-500/10 hover:text-emerald-300 focus-ring"
                  aria-label="Save edit"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className={clsx(
              "whitespace-pre-wrap break-words text-sm leading-relaxed",
              isAgent
                ? "text-slate-200"
                : "text-slate-300",
              isPlaceholder && "animate-shimmer",
            )}
          >
            {(() => {
              const split = splitToolsFooter(message.content);
              return (
                <>
                  {renderContent(split.body)}
                  {split.tools && (
                    <ToolFooter rawHtml={split.tools} />
                  )}
                </>
              );
            })()}
            {message.edited && (
              <span className="ml-1.5 text-[10px] text-slate-500">(edited)</span>
            )}
            {promoted && !showAvatar && (
              <a
                href={promoted.task_url}
                target="_blank"
                rel="noreferrer"
                className="ml-2 inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 focus-ring"
                title="Open Project Ops task"
              >
                <BriefcaseBusiness className="h-3 w-3" />
                {promoted.task_number || promoted.project_number}
              </a>
            )}
            {artifact && !showAvatar && (
              <button
                type="button"
                onClick={() =>
                  void useCanvasStore.getState().openArtifactById(artifact.artifactId)
                }
                className="ml-2 inline-flex items-center gap-1 rounded-md bg-stable-purple/10 px-1.5 py-0.5 text-[10px] font-medium text-stable-purple-light transition-colors hover:bg-stable-purple/20 focus-ring"
                title={artifact.artifactTitle ? `Open "${artifact.artifactTitle}" in canvas` : "Open in canvas"}
              >
                <LayoutPanelLeft className="h-3 w-3" />
                {artifact.artifactTitle ? `Open "${artifact.artifactTitle}" in canvas` : "Open in canvas"}
              </button>
            )}
            {Array.isArray(
              (message.metadata as { attachments?: unknown[] } | undefined)
                ?.attachments,
            ) && (
              <div className="mt-2 flex flex-wrap gap-2">
                {((message.metadata as {
                  attachments: Array<{
                    url: string;
                    filename: string;
                    content_type: string;
                    size: number;
                  }>;
                }).attachments).map((a, i) =>
                  a.content_type.startsWith("image/") ? (
                    // Opens the in-app lightbox — "Open original" inside it
                    // keeps the old open-in-new-tab behavior.
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        setLightbox({ url: a.url, filename: a.filename })
                      }
                      className="focus-ring block max-w-xs cursor-zoom-in overflow-hidden rounded-xl border border-line transition-colors hover:border-line-strong"
                      aria-label={`View ${a.filename}`}
                    >
                      <img
                        src={a.url}
                        alt={a.filename}
                        className="max-h-64 w-full object-cover"
                      />
                    </button>
                  ) : (
                    <a
                      key={i}
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="focus-ring flex items-center gap-2 rounded-lg border border-line bg-white/[0.04] px-2.5 py-1.5 text-xs text-slate-200 transition-colors hover:border-line-strong hover:bg-white/[0.06]"
                    >
                      📎 <span className="truncate max-w-[20ch]">{a.filename}</span>
                      <span className="text-slate-500">
                        ({Math.round(a.size / 1024)} KB)
                      </span>
                    </a>
                  ),
                )}
              </div>
            )}
          </div>
        )}

        {(() => {
          const poll = (message.metadata as { poll?: { question: string; options: string[] } } | undefined)?.poll;
          if (!poll) return null;
          return <PollCard messageId={message.id} poll={poll} reactions={(message.metadata as { reactions?: Record<string, string[]> } | undefined)?.reactions ?? null} />;
        })()}

        <ReactionRow
          reactions={reactionOverlay ?? serverReactions}
          onToggle={handleToggleReaction}
        />

        {message.reply_count > 0 && !editing && (
          <button
            onClick={() => onReply(message.id)}
            className="mt-1.5 flex items-center gap-1 rounded-md text-xs font-medium text-stable-purple-light transition-colors hover:text-stable-purple focus-ring"
          >
            <CornerDownRight className="h-3 w-3" />
            {message.reply_count} {message.reply_count === 1 ? "reply" : "replies"}
          </button>
        )}
        </div>
      </div>

      {/* Toolbar stays mounted while the regenerate-model menu is open, even
          if the pointer wanders off the bubble. */}
      {(hovered || regenMenuOpen) && !editing && (
        <div className="glass-heavy absolute -top-3 right-2 z-10 flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center justify-end gap-0.5 rounded-lg p-1 shadow-pop animate-fade-in md:max-w-none md:flex-nowrap">
          <QuickReact onReact={handleToggleReaction} />
          <button
            onClick={() => onReply(message.id)}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
            aria-label="Reply in thread"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              const quote = `> **${message.sender_name}:** ${message.content}\n\n`;
              useAppStore.getState().requestInsert(message.room_id, quote);
            }}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
            aria-label="Quote reply"
            title="Quote and reply"
          >
            <Quote className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleToggleSave}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
            aria-label="Save message"
            title="Save to your bookmarks"
          >
            <Bookmark className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setPromoteOpen(true)}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
            aria-label="Promote to Project Ops task"
            title="Promote to Project Ops task"
          >
            <BriefcaseBusiness className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleTogglePin}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
            aria-label="Pin / unpin message"
            title="Pin or unpin"
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
          {isAgent && !isGenerating && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleReadAloud();
              }}
              className={clsx(
                "rounded-md p-1.5 transition-colors focus-ring",
                ttsState === "speaking"
                  ? "text-stable-mint hover:bg-stable-mint/15"
                  : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-100",
                ttsState === "loading" && "animate-pulse-soft",
              )}
              aria-label={ttsState === "idle" ? "Read aloud" : "Stop reading"}
              title={ttsState === "idle" ? "Read this reply aloud" : "Stop reading"}
            >
              {ttsState === "speaking" ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {isAgent && !isGenerating && (
            // Split control: the refresh half regenerates as-is (unchanged
            // behavior); the chevron half opens a compact model menu so one
            // reply can be re-rolled on a different lane.
            <div className="relative flex items-center">
              <button
                disabled={regenerating}
                onClick={(e) => {
                  e.stopPropagation();
                  runRegenerate();
                }}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-stable-purple/15 hover:text-stable-purple-light focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Regenerate reply"
                title="Regenerate this reply"
              >
                <RefreshCw
                  className={clsx("h-3.5 w-3.5", regenerating && "animate-spin")}
                />
              </button>
              <button
                disabled={regenerating}
                onClick={(e) => {
                  e.stopPropagation();
                  setRegenMenuOpen((v) => !v);
                }}
                className="-ml-0.5 rounded-md p-1 text-slate-400 transition-colors hover:bg-stable-purple/15 hover:text-stable-purple-light focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Regenerate with a different model"
                title="Regenerate with a different model"
                aria-haspopup="menu"
                aria-expanded={regenMenuOpen}
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              {regenMenuOpen && (
                <div
                  role="menu"
                  className="glass-heavy absolute right-0 top-full z-50 mt-1 max-h-64 w-60 overflow-auto rounded-xl p-1 shadow-pop animate-fade-in"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Regenerate with
                  </div>
                  <button
                    role="menuitem"
                    onClick={() => runRegenerate()}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
                  >
                    <RefreshCw className="h-3 w-3 shrink-0 text-slate-400" />
                    Same model
                  </button>
                  {regenModels.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-slate-500">
                      No models available.
                    </div>
                  ) : (
                    regenModels.map((m) => (
                      <button
                        key={m.id}
                        role="menuitem"
                        title={m.id}
                        onClick={() => runRegenerate(m.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
                      >
                        <span className="truncate">{m.label}</span>
                        {m.badge && (
                          <span
                            className={clsx(
                              "ml-auto shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide",
                              m.badge === "Local"
                                ? "bg-stable-mint/15 text-stable-mint"
                                : "bg-sky-400/15 text-sky-300",
                            )}
                          >
                            {m.badge}
                          </span>
                        )}
                        {m.cost === "$" && (
                          <span
                            className="shrink-0 text-[10px] font-semibold text-amber-300/90"
                            title="Paid cloud lane"
                          >
                            $
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          {isOwn && (
            <>
              <button
                onClick={() => {
                  setEditing(true);
                  setEditContent(message.content);
                }}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
                aria-label="Edit message"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => {
                  // Confirm here too — the hover toolbar deleted instantly
                  // while only the context-menu path asked (easy mis-click).
                  if (window.confirm("Delete this message?")) {
                    void onDelete(message.id);
                  }
                }}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-rose-500/15 hover:text-rose-300 focus-ring"
                aria-label="Delete message"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {isGenerating && (
        <div className="absolute -bottom-3 right-3 z-10">
          <button
            onClick={(e) => {
              e.stopPropagation();
              void api.stopGenerating(message.id).catch(() => {});
            }}
            className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-rose-300 shadow-pop transition-colors hover:border-rose-400/50 hover:text-rose-200 focus-ring"
            aria-label="Stop generating"
            title="Stop generating"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
            Stop
          </button>
        </div>
      )}

      {failed && onRetry && (
        <div
          className="absolute -right-2 top-1 flex items-center gap-1 rounded-md border border-rose-500/50 bg-rose-500/15 px-1.5 py-0.5 text-xs text-rose-300"
          title={failedError || "Send failed"}
        >
          <AlertTriangle className="h-3 w-3" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              void onRetry(message.id);
            }}
            className="flex items-center gap-1 transition-colors hover:text-rose-200 focus-ring rounded"
          >
            <RotateCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}
      {ctxMenu && (
        <ul
          className="glass-heavy fixed z-50 min-w-[180px] rounded-xl p-1 text-sm shadow-pop"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <li>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(message.content);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
            >
              <CopyIcon className="h-3.5 w-3.5" /> Copy text
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                const url = `${window.location.origin}/c/${message.room_id}?message=${message.id}`;
                void navigator.clipboard.writeText(url);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
            >
              <Link2 className="h-3.5 w-3.5" /> Copy link
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                onReply(message.id);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
            >
              ↪ Reply / quote
            </button>
          </li>
          {isAgent && !isGenerating && (
            <li>
              <button
                onClick={() => {
                  handleReadAloud();
                  setCtxMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
              >
                {ttsState === "idle" ? (
                  <Volume2 className="h-3.5 w-3.5" />
                ) : (
                  <Square className="h-3.5 w-3.5 fill-current" />
                )}
                {ttsState === "idle" ? "Read aloud" : "Stop reading"}
              </button>
            </li>
          )}
          <li>
            <button
              onClick={() => {
                setPromoteOpen(true);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
            >
              <BriefcaseBusiness className="h-3.5 w-3.5" /> Promote to Project Ops task
            </button>
          </li>
          {isOwn && (
            <>
              <li>
                <button
                  onClick={() => {
                    setEditing(true);
                    setCtxMenu(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
                >
                  ✏️ Edit
                </button>
              </li>
              <li>
                <button
                  onClick={() => {
                    if (window.confirm("Delete this message?")) {
                      void onDelete(message.id);
                    }
                    setCtxMenu(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-rose-300 transition-colors hover:bg-rose-500/15 focus-ring"
                >
                  🗑 Delete
                </button>
              </li>
            </>
          )}
        </ul>
      )}
      {promoteOpen && (
        <PromoteToProjectOpsModal
          message={message}
          onClose={() => setPromoteOpen(false)}
          onPromoted={handlePromoted}
        />
      )}
      {lightbox && (
        <ImageLightbox
          url={lightbox.url}
          filename={lightbox.filename}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
