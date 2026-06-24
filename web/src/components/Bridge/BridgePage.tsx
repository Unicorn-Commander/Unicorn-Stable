import { useState } from "react";
import {
  Plug,
  Copy,
  Check,
  MessageSquare,
  BookOpen,
  Bot,
  Terminal,
  ArrowRight,
} from "lucide-react";
import clsx from "clsx";

/**
 * The "Bridge / Connect" page — how to wire an MCP client (Claude Code, Claude
 * Desktop, or any MCP-capable agent) to this Stable workspace so it can read &
 * post into rooms, run as a room resident, and manage knowledge bases.
 *
 * Deliberately does NOT embed operator secrets or internal hostnames — the
 * runnable bridge script + the exact launch command are provided per-workspace
 * by the operator. This page documents the contract and the setup.
 */

const CONFIG_SNIPPET = `{
  "mcpServers": {
    "stable-bridge": {
      "command": "uv",
      "args": [
        "run", "--with", "mcp", "python",
        "/path/to/stable-bridge/server.py"
      ]
    }
  }
}`;

type ToolGroup = {
  icon: typeof MessageSquare;
  title: string;
  blurb: string;
  tools: { name: string; desc: string }[];
};

const TOOL_GROUPS: ToolGroup[] = [
  {
    icon: MessageSquare,
    title: "Messaging",
    blurb: "Relay a conversation into Stable and listen for replies.",
    tools: [
      { name: "start_session", desc: "Connect as a named identity (e.g. “Claude Code”)." },
      { name: "list_rooms", desc: "List the rooms the bridge identity can see." },
      { name: "create_channel", desc: "Open a new channel to work in." },
      { name: "send_message", desc: "Post a message into a room." },
      { name: "send_and_wait", desc: "Post, then block for the next reply." },
      { name: "get_new_messages", desc: "Pull messages since you last looked." },
      { name: "wait_for_reply", desc: "Await the next human/agent response." },
    ],
  },
  {
    icon: BookOpen,
    title: "Knowledge bases",
    blurb: "Create and query RAG knowledge bases, and wire them into rooms.",
    tools: [
      { name: "list_knowledge_bases", desc: "See every knowledge base." },
      { name: "create_knowledge_base", desc: "Spin up a new RAG collection." },
      { name: "add_document", desc: "Index a document (chunk + embed)." },
      { name: "search_knowledge", desc: "Hybrid search + rerank a KB." },
      { name: "attach_kb_to_room", desc: "Ground a room's agents in a KB." },
      { name: "detach_kb_from_room", desc: "Unlink a KB from a room." },
      { name: "list_room_knowledge", desc: "See which KBs a room uses." },
    ],
  },
];

const STEPS = [
  {
    icon: Terminal,
    title: "Add the bridge to your MCP client",
    body: "Drop the config below into your client (Claude Code: `~/.claude.json`; Claude Desktop: the MCP servers section), pointing `args` at the server.py your workspace operator gave you.",
  },
  {
    icon: ArrowRight,
    title: "Reload the client",
    body: "MCP servers load at startup — restart Claude Code / Claude Desktop so the `stable-bridge` tools appear.",
  },
  {
    icon: Bot,
    title: "Start a session",
    body: "Call `start_session` with a display name. The bridge joins your Stable workspace under that identity and the other tools light up.",
  },
];

export function BridgePage() {
  const [copied, setCopied] = useState(false);

  function copyConfig() {
    navigator.clipboard
      .writeText(CONFIG_SNIPPET)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {});
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="animate-fade-in mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {/* Hero */}
        <header className="relative mb-6 overflow-hidden rounded-2xl border border-stable-glass-border bg-slate-800/30 px-6 py-7 sm:px-8 sm:py-8">
          <div
            className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-stable-cyan/25 blur-3xl"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute -bottom-24 right-40 h-44 w-44 rounded-full bg-stable-purple/20 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="mb-2 flex items-center gap-2">
              <span className="gradient-bg flex h-6 w-6 items-center justify-center rounded-md">
                <Plug className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Stable Bridge · MCP
              </span>
            </div>
            <h1 className="text-2xl font-bold sm:text-3xl">
              <span className="text-slate-50">Connect </span>
              <span className="gradient-text">Claude to Stable</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              The Stable Bridge is a small{" "}
              <span className="text-slate-200">MCP server</span> that lets Claude
              Code — or any MCP-capable agent — read and post into your Stable
              rooms, run as a room resident, and manage knowledge bases. Wire it
              up once and your agent works alongside you in the workspace.
            </p>
          </div>
        </header>

        {/* Setup steps */}
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Set it up
          </h2>
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li
                key={s.title}
                className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-4"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-stable-purple/15 text-stable-purple-light">
                    <s.icon className="h-4 w-4" />
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Step {i + 1}
                  </span>
                </div>
                <p className="text-sm font-semibold text-slate-100">{s.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                  {s.body}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* Config snippet */}
        <section className="mb-6">
          <div className="flex items-center justify-between">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              MCP client config
            </h2>
            <button
              onClick={copyConfig}
              className="mb-2 inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-xl border border-slate-700/50 bg-slate-950/70 p-4 text-[12.5px] leading-relaxed text-slate-300">
            <code>{CONFIG_SNIPPET}</code>
          </pre>
          <p className="mt-2 text-[12px] text-slate-500">
            Ask your workspace operator for the <code>server.py</code> and the
            exact launch command for your environment — the bridge authenticates
            against this workspace, so its setup is provisioned per-operator
            rather than published here.
          </p>
        </section>

        {/* Tool catalog */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            What the bridge can do
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {TOOL_GROUPS.map((g) => (
              <div
                key={g.title}
                className="rounded-2xl border border-slate-700/50 bg-slate-800/20 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-stable-purple-light">
                    <g.icon className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-100">{g.title}</p>
                    <p className="text-[11px] text-slate-500">{g.blurb}</p>
                  </div>
                </div>
                <ul className="space-y-1.5">
                  {g.tools.map((t) => (
                    <li key={t.name} className="flex items-start gap-2 text-[13px]">
                      <code
                        className={clsx(
                          "mt-0.5 shrink-0 rounded bg-slate-700/50 px-1.5 py-0.5 text-[11px] font-medium text-stable-cyan",
                        )}
                      >
                        {t.name}
                      </code>
                      <span className="text-slate-400">{t.desc}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
