/**
 * "Ask" — the Stable-scoped help agent.
 *
 * Three things this component is careful about, because they are the ways a
 * surface like this usually lies:
 *
 * 1. **Liveness.** The working indicator is bound to the actual in-flight
 *    request and nothing else. It is not a timer, not an optimistic flag, and
 *    not a presence dot — this agent is not a room member, so it has no
 *    presence to report. Same rule as `lib/agentStatus.ts` and
 *    `services/agent_status.py`: only claim what you can observe.
 *
 * 2. **Cost.** `$0` is printed only when the server says the model is local,
 *    where zero is the true number. When it is not, we say the call is billed
 *    upstream rather than inventing a price Stable does not know.
 *
 * 3. **Grounding.** Every answer names the articles it was given. If the
 *    sources look wrong, the answer probably is — and the reader can check in
 *    one click instead of trusting it.
 *
 * Capacity: one request at a time, started only by a user pressing send. No
 * polling, no warm-up, no retry — the local model pool is shared and serves one
 * request at a time, so a retry would compete with the request it is retrying.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  Loader2,
  Sparkles,
  StopCircle,
} from "lucide-react";
import { retrieveForAgent, type HelpArticle } from "@/content/help";
import { Tooltip } from "@/components/ui";
import { HelpMarkdown } from "./HelpMarkdown";
import {
  askHelpAgent,
  fetchHelpAgentStatus,
  HelpApiError,
  type HelpAgentStatus,
  type HelpAnswer,
  type HelpTurn,
} from "./helpApi";

/** How many prior turns to send back as context. Matches the server ceiling. */
const HISTORY_TURNS = 8;

interface Exchange {
  id: number;
  question: string;
  /** Present once the answer lands. */
  answer?: HelpAnswer;
  /** Present if it failed — the server's own user-facing message. */
  error?: string;
  /** The articles this question was grounded in. */
  sources: HelpArticle[];
}

const SUGGESTIONS = [
  "How do I get an agent to answer in a channel?",
  "What do the coloured dots next to an agent mean?",
  "How do I attach documents an agent can search?",
  "Why can't I see the server rail?",
];

interface HelpAgentPanelProps {
  /** Follow a `help:<id>` link out of an answer into the article browser. */
  onOpenArticle: (articleId: string) => void;
}

export function HelpAgentPanel({ onOpenArticle }: HelpAgentPanelProps) {
  const [status, setStatus] = useState<HelpAgentStatus | null>(null);
  const [statusChecked, setStatusChecked] = useState(false);
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  // True only while a request is genuinely in flight. This is the ONLY thing
  // that drives the working indicator.
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // One cheap read-only probe on mount. It lists models; it never generates, so
  // opening this tab does not consume the capacity it reports on.
  useEffect(() => {
    let live = true;
    fetchHelpAgentStatus()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => {
        /* Leaves status null => "couldn't check", which is not "it's down". */
      })
      .finally(() => {
        if (live) setStatusChecked(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // Abort an in-flight ask if the panel unmounts, so a closed modal cannot
  // leave a request occupying a shared-GPU slot.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [exchanges, pending]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || pending) return;

      // Retrieval happens here, over the markdown corpus already in the bundle
      // — the server holds no copy of the content. See content/help/index.ts.
      const sources = retrieveForAgent(text);
      const id = nextId.current++;
      setExchanges((prev) => [...prev, { id, question: text, sources }]);
      setQuestion("");
      setPending(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // Prior turns, oldest first, failures omitted — a failed exchange is not
      // conversation the agent should try to build on.
      const history: HelpTurn[] = exchanges
        .flatMap((ex): HelpTurn[] =>
          ex.answer
            ? [
                { role: "user", content: ex.question },
                { role: "assistant", content: ex.answer.answer },
              ]
            : [],
        )
        .slice(-HISTORY_TURNS);

      try {
        const answer = await askHelpAgent({
          question: text,
          articles: sources,
          history,
          signal: controller.signal,
        });
        setExchanges((prev) =>
          prev.map((ex) => (ex.id === id ? { ...ex, answer } : ex)),
        );
      } catch (err) {
        if (controller.signal.aborted) {
          setExchanges((prev) => prev.filter((ex) => ex.id !== id));
          return;
        }
        // The server sends user-facing detail strings (busy / starting up /
        // unreachable) so the UI does not have to guess which failure it was.
        const message =
          err instanceof HelpApiError
            ? err.message
            : "Couldn't reach the help agent. The articles still work.";
        setExchanges((prev) =>
          prev.map((ex) => (ex.id === id ? { ...ex, error: message } : ex)),
        );
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setPending(false);
      }
    },
    [exchanges, pending],
  );

  // Only a definite `false` from the server is an "off" claim. A failed probe
  // leaves status null, and we let the user try rather than pre-emptively
  // greying out something that may well work.
  const disabledByServer = status?.enabled === false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {exchanges.length === 0 && (
          <Intro
            status={status}
            statusChecked={statusChecked}
            disabled={disabledByServer || pending}
            onPick={send}
          />
        )}

        {exchanges.map((ex) => (
          <ExchangeView
            key={ex.id}
            exchange={ex}
            working={pending && ex.id === exchanges[exchanges.length - 1]?.id && !ex.answer && !ex.error}
            onOpenArticle={onOpenArticle}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(question);
          }}
          className="flex items-end gap-2"
        >
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(question);
              }
            }}
            rows={1}
            disabled={disabledByServer}
            placeholder={
              disabledByServer
                ? "The help agent is turned off on this server."
                : "Ask about Stable…"
            }
            aria-label="Ask the help agent about Stable"
            className="focus-ring max-h-32 min-h-[38px] flex-1 resize-y rounded-xl border border-line bg-surface-1/70 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {pending ? (
            <Tooltip content="Stop waiting for this answer" placement="top">
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                aria-label="Stop waiting for the answer"
                className="focus-ring flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl border border-line bg-surface-2/70 text-slate-300 transition hover:text-slate-100"
              >
                <StopCircle className="h-4 w-4" />
              </button>
            </Tooltip>
          ) : (
            <button
              type="submit"
              disabled={!question.trim() || disabledByServer}
              aria-label="Send question"
              className="focus-ring flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl bg-stable-purple/25 text-stable-purple-light transition hover:bg-stable-purple/35 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </form>
        <p className="mt-2 text-center text-[11px] text-slate-500">
          Answers only about Stable, only from the guides in this help section.
        </p>
      </div>
    </div>
  );
}

function Intro({
  status,
  statusChecked,
  disabled,
  onPick,
}: {
  status: HelpAgentStatus | null;
  statusChecked: boolean;
  disabled: boolean;
  onPick: (q: string) => void;
}) {
  return (
    <div>
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-line bg-surface-2/50 p-3.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stable-purple/15">
          <Sparkles aria-hidden="true" className="h-4 w-4 text-stable-purple-light" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-100">Ask about Stable</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            This agent answers from the guides in this help section — nothing
            else. It doesn't read your rooms, your messages or your files, and
            it will tell you when a question is outside what it covers.
          </p>
          {statusChecked && <CapacityNote status={status} />}
        </div>
      </div>

      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Try one
      </p>
      <ul className="space-y-1.5">
        {SUGGESTIONS.map((s) => (
          <li key={s}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(s)}
              className="focus-ring w-full rounded-lg border border-line bg-surface-1/50 px-3 py-2 text-left text-xs text-slate-300 transition hover:border-line-strong hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What a question costs and whether we could confirm the agent is reachable.
 *
 * `reachable` is tri-state all the way here: `null` means the probe failed,
 * which is not evidence of an outage — so it reads "couldn't check", and the
 * ask button stays enabled.
 */
function CapacityNote({ status }: { status: HelpAgentStatus | null }) {
  if (!status) {
    return (
      <p className="mt-2 text-[11px] text-slate-500">
        Couldn't check whether the help agent is reachable — asking may still
        work.
      </p>
    );
  }

  if (!status.enabled) {
    return (
      <p className="mt-2 text-[11px] text-amber-400/90">
        The help agent is turned off on this server. The guides still work.
      </p>
    );
  }

  const cost =
    status.pricing === "local_zero"
      ? "Runs on our own hardware — $0 per question."
      : "Runs on a hosted model; usage is billed upstream.";

  const reach =
    status.reachable === true
      ? ""
      : status.reachable === false
        ? " Not reachable right now."
        : " Couldn't confirm it's reachable.";

  return (
    <p className="mt-2 text-[11px] text-slate-500">
      {cost}
      {reach}
    </p>
  );
}

function ExchangeView({
  exchange,
  working,
  onOpenArticle,
}: {
  exchange: Exchange;
  working: boolean;
  onOpenArticle: (id: string) => void;
}) {
  return (
    <div className="mb-5 last:mb-0">
      <p className="mb-2 ml-auto w-fit max-w-[85%] rounded-xl rounded-br-sm bg-stable-purple/15 px-3 py-2 text-sm text-slate-100">
        {exchange.question}
      </p>

      {working && (
        <p
          role="status"
          className="flex items-center gap-2 px-1 py-2 text-xs text-slate-400"
        >
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          Working on it…
        </p>
      )}

      {exchange.error && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {exchange.error}
        </p>
      )}

      {exchange.answer && (
        <>
          <div className="rounded-xl border border-line bg-surface-1/50 px-3.5 py-3">
            <HelpMarkdown
              content={exchange.answer.answer}
              onNavigate={onOpenArticle}
            />
          </div>
          <Sources articles={exchange.sources} onOpenArticle={onOpenArticle} />
          <AnswerFooter answer={exchange.answer} />
        </>
      )}
    </div>
  );
}

function Sources({
  articles,
  onOpenArticle,
}: {
  articles: HelpArticle[];
  onOpenArticle: (id: string) => void;
}) {
  if (articles.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-slate-500">
        <BookOpen aria-hidden="true" className="h-3 w-3" /> From
      </span>
      {articles.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onOpenArticle(a.id)}
          className="focus-ring rounded-full border border-line bg-surface-2/60 px-2 py-0.5 text-[11px] text-slate-400 transition hover:border-line-strong hover:text-slate-200"
        >
          {a.title}
        </button>
      ))}
    </div>
  );
}

/**
 * The cost + routing line under an answer.
 *
 * `cost_usd === 0` is printed as a real `$0` because the model is ours. When
 * the server reports an external model, `cost_usd` is `null` and we say where
 * the charge lands instead of quoting a rate Stable has no way to know.
 *
 * `served_by` is shown when it differs from the logical name we asked for —
 * that difference IS the fleet move working, and hiding it would make a
 * relocated model look like a bug.
 */
function AnswerFooter({ answer }: { answer: HelpAnswer }) {
  const moved = answer.served_by && answer.served_by !== answer.model;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[11px] text-slate-500">
      <span>
        {answer.cost_usd === 0 ? "$0 — runs on our own hardware" : "Billed upstream"}
      </span>
      <span aria-hidden="true">·</span>
      <Tooltip
        content={
          moved
            ? `Requested "${answer.model}"; the gateway served it with "${answer.served_by}".`
            : "The logical model name; the gateway decides which machine serves it."
        }
        placement="top"
      >
        {/* tabIndex: Tooltip reveals on focus, but it does not make its
            child focusable. Without this a keyboard user can never reach
            the routing explanation that a mouse user gets for free. */}
        <span
          tabIndex={0}
          className="focus-ring cursor-help rounded underline decoration-dotted underline-offset-2"
        >
          {answer.model}
        </span>
      </Tooltip>
    </p>
  );
}

export default HelpAgentPanel;
