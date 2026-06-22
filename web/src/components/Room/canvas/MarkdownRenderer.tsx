import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";

/**
 * Markdown artifact renderer. react-markdown + remark-gfm (tables, task lists,
 * strikethrough, autolinks) + rehype-highlight for fenced code (uses the
 * highlight.js already in the bundle) + rehype-sanitize.
 *
 * SECURITY: AI-/user-authored markdown is untrusted. react-markdown does not
 * render raw HTML by default (no rehype-raw here), and rehype-sanitize strips
 * anything dangerous from the produced hast — so `<script>`, `javascript:`
 * URLs, event handlers, etc. cannot survive. Lazy-loaded by CanvasRenderer to
 * keep the markdown stack out of the main bundle.
 *
 * `prose`-style spacing is hand-applied via Tailwind classes on the elements
 * (the app has no @tailwindcss/typography plugin), themed to the slate palette.
 */
export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="canvas-md px-4 py-3 text-sm leading-relaxed text-slate-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // sanitize runs BEFORE highlight so highlight's class names survive.
        rehypePlugins={[rehypeSanitize, rehypeHighlight]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 text-xl font-bold text-slate-100">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-4 text-lg font-bold text-slate-100">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-3 text-base font-semibold text-slate-100">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="my-2">{children}</p>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-stable-cyan underline decoration-stable-cyan/30 hover:text-stable-cyan-light"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc pl-5 marker:text-slate-500">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal pl-5 marker:text-slate-500">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-stable-purple/50 pl-3 text-slate-400">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            // Inline code has no language- class; block code does (set by
            // rehype-highlight / the fence info string).
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return <code className={className}>{children}</code>;
            }
            return (
              <code className="rounded bg-slate-800 px-1 py-0.5 text-xs text-pink-400">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg bg-slate-950/80 p-3 text-xs">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-slate-700 bg-slate-800/60 px-2 py-1 text-left font-semibold text-slate-200">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-slate-700/60 px-2 py-1 text-slate-300">
              {children}
            </td>
          ),
          hr: () => <hr className="my-3 border-slate-700/60" />,
          img: ({ src, alt }) => (
            <img
              src={typeof src === "string" ? src : undefined}
              alt={alt ?? ""}
              className="my-2 max-w-full rounded-lg border border-slate-700/60"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
