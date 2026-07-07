import { motion } from "framer-motion";
import { X, Keyboard } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useModalA11y } from "@/hooks/useModalA11y";

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";

interface Row {
  combo: string;
  desc: string;
}

const KEYS: Row[] = [
  { combo: `${mod} K`, desc: "Quick channel switcher" },
  { combo: `${mod} \u21e7 F`, desc: "Search messages across all channels" },
  { combo: `${mod} /`, desc: "This cheatsheet" },
  { combo: `${mod} ↑`, desc: "Edit your last message" },
  { combo: "↑ / ↓", desc: "Navigate mention/emoji suggestions" },
  { combo: "Enter", desc: "Send message" },
  { combo: "Shift Enter", desc: "Newline in input" },
  { combo: "Esc", desc: "Close modal / cancel edit" },
];

const SLASH: Row[] = [
  { combo: "/me <action>", desc: "Italic narration" },
  { combo: "/shrug", desc: "Append ¯\\_(ツ)_/¯" },
  { combo: "/tableflip", desc: "Append (╯°□°）╯︵ ┻━┻" },
  { combo: "/unflip", desc: "Append ┬─┬ ノ( ゜-゜ノ)" },
  { combo: "/agent <id> ...", desc: "Explicit agent mention" },
  { combo: "/research <question>", desc: "Deep web research with citations (Center Deep)" },
  { combo: "/facilitate <question>", desc: "Orchestrator routes to the best specialist" },
  { combo: "/council <question>", desc: "Several models answer + synthesis" },
  { combo: '/poll "Q?" a b c', desc: "Inline poll with vote buttons" },
  { combo: "/help", desc: "Open this cheatsheet" },
];

const MENTIONS: Row[] = [
  { combo: "@username", desc: "Notify a person" },
  { combo: "@agent-id", desc: "Address a Brigade agent (col-finance, sql-analyst, …)" },
  { combo: "@channel", desc: "Notify everyone in this channel" },
  { combo: "@here", desc: "Notify online members only" },
];

const MARKDOWN: Row[] = [
  { combo: "**bold**", desc: "Bold" },
  { combo: "*italic* or _italic_", desc: "Italic" },
  { combo: "~~strike~~", desc: "Strikethrough" },
  { combo: "`code`", desc: "Inline code" },
  { combo: "```lang\n...\n```", desc: "Fenced code block" },
  { combo: "> quote", desc: "Blockquote" },
  { combo: "- item / 1. item", desc: "Bullet / numbered list" },
  { combo: "# / ## / ###", desc: "Headings" },
];

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.combo} className="flex items-start justify-between gap-3 text-sm">
            <kbd className="shrink-0 rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-200">
              {r.combo}
            </kbd>
            <span className="flex-1 text-right text-xs leading-5 text-slate-400">
              {r.desc}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CheatsheetModal() {
  const open = useAppStore((s) => s.ui.cheatsheetOpen);
  const toggle = useAppStore((s) => s.toggleCheatsheet);
  // Esc-to-close, focus trap + restore — shared modal a11y.
  const panelRef = useModalA11y(open, toggle);

  if (!open) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-20 backdrop-blur-sm"
      onClick={toggle}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cheatsheet-title"
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="glass-heavy w-full max-w-2xl overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-stable-purple/15">
              <Keyboard className="h-4 w-4 text-stable-purple-light" />
            </span>
            <h2
              id="cheatsheet-title"
              className="font-display text-base font-semibold text-slate-100"
            >
              Shortcuts &amp; commands
            </h2>
          </div>
          <button
            onClick={toggle}
            className="focus-ring -m-1 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close cheatsheet"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 pt-5">
          <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <div>
              <Section title="Keyboard" rows={KEYS} />
              <Section title="Mentions" rows={MENTIONS} />
            </div>
            <div>
              <Section title="Slash commands" rows={SLASH} />
              <Section title="Markdown" rows={MARKDOWN} />
            </div>
          </div>
        </div>
        <p className="border-t border-line px-6 py-3 text-center text-xs text-slate-500">
          Press{" "}
          <kbd className="rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-200">
            {mod} /
          </kbd>{" "}
          any time to reopen.
        </p>
      </motion.div>
    </motion.div>
  );
}
