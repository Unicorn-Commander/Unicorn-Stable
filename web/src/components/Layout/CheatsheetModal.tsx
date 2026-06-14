import { motion } from "framer-motion";
import { X, Keyboard } from "lucide-react";
import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";

interface Row {
  combo: string;
  desc: string;
}

const KEYS: Row[] = [
  { combo: `${mod} K`, desc: "Quick channel switcher" },
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
    <div className="mb-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h3>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.combo} className="flex items-start justify-between gap-3 text-sm">
            <kbd className="shrink-0 rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-slate-200">
              {r.combo}
            </kbd>
            <span className="flex-1 text-right text-slate-400">{r.desc}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CheatsheetModal() {
  const open = useAppStore((s) => s.ui.cheatsheetOpen);
  const toggle = useAppStore((s) => s.toggleCheatsheet);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, toggle]);

  if (!open) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-20"
      onClick={toggle}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="w-full max-w-2xl rounded-xl border border-slate-700/50 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-stable-purple" />
            <h2 className="text-base font-semibold text-slate-100">
              Shortcuts &amp; commands
            </h2>
          </div>
          <button
            onClick={toggle}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
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
        <p className="mt-3 border-t border-slate-800 pt-3 text-center text-xs text-slate-500">
          Press <kbd className="rounded bg-slate-800 px-1 py-0.5 text-slate-300">{mod} /</kbd> any time to reopen.
        </p>
      </motion.div>
    </motion.div>
  );
}
