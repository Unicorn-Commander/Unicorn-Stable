/**
 * Markdown renderer for help articles and help-agent answers.
 *
 * Separate from the Canvas renderer because it does one thing that one cannot:
 * it intercepts `help:<id>` links so an article can cross-reference another
 * article and navigate inside the help centre rather than leaving the app.
 *
 * SECURITY: `rehype-sanitize` runs on all of it. Help articles ship in the
 * bundle and are trusted, but agent ANSWERS are model output and are not — and
 * both go through this component, so the untrusted path cannot be forgotten.
 * No `rehype-raw`, so inline HTML never renders.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

interface HelpMarkdownProps {
  content: string;
  /** Called with the article id when a `help:<id>` link is followed. */
  onNavigate?: (articleId: string) => void;
}

export function HelpMarkdown({ content, onNavigate }: HelpMarkdownProps) {
  return (
    <div className="text-sm leading-relaxed text-slate-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-6 font-display text-lg font-semibold text-slate-100 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-6 font-display text-base font-semibold text-slate-100 first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-5 text-sm font-semibold text-slate-200 first:mt-0">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-3 ml-5 list-disc space-y-1.5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 ml-5 list-decimal space-y-1.5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-slate-100">{children}</strong>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-stable-purple/50 bg-white/[0.03] py-2 pl-3 pr-2 text-slate-400 last:mb-0">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            // react-markdown gives fenced blocks a `language-*` class and
            // inline code none, which is how we tell them apart without the
            // removed `inline` prop.
            const fenced = typeof className === "string" && className.includes("language-");
            if (fenced) {
              return (
                <code className="block overflow-x-auto whitespace-pre rounded-lg border border-line bg-surface-0/80 p-3 font-mono text-[12px] text-slate-200">
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded border border-line bg-white/[0.05] px-1 py-0.5 font-mono text-[12px] text-slate-200">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <div className="mb-3 last:mb-0">{children}</div>,
          // Wide tables scroll INSIDE their own container. The help panel must
          // never scroll sideways as a whole.
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto rounded-lg border border-line last:mb-0">
              <table className="w-full border-collapse text-left text-[13px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-line bg-white/[0.04] px-3 py-2 font-semibold text-slate-200">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-line/60 px-3 py-2 align-top text-slate-300">
              {children}
            </td>
          ),
          hr: () => <hr className="my-5 border-line" />,
          a: ({ href, children }) => {
            const target = typeof href === "string" ? href : "";

            if (target.startsWith("help:")) {
              const articleId = target.slice("help:".length);
              return (
                <button
                  type="button"
                  onClick={() => onNavigate?.(articleId)}
                  className="focus-ring rounded text-stable-purple-light underline decoration-stable-purple/40 underline-offset-2 hover:decoration-stable-purple"
                >
                  {children}
                </button>
              );
            }

            return (
              <a
                href={target}
                target="_blank"
                rel="noreferrer noopener"
                className="focus-ring rounded text-stable-purple-light underline decoration-stable-purple/40 underline-offset-2 hover:decoration-stable-purple"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default HelpMarkdown;
