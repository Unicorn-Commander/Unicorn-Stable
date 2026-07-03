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

// Numbered step chips cycle the brand triad: iris → aqua → mint.
const STEP_HUES = [
  "bg-stable-purple/15 text-stable-purple-light",
  "bg-stable-cyan/15 text-stable-cyan-light",
  "bg-stable-mint/15 text-emerald-300",
] as const;

// Tool-group icon tiles alternate iris / aqua.
const GROUP_HUES = [
  "bg-stable-purple/15 text-stable-purple-light",
  "bg-stable-cyan/10 text-stable-cyan-light",
] as const;

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
        <header className="card relative mb-8 overflow-hidden px-6 py-7 sm:px-8 sm:py-8">
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_90%_at_88%_0%,rgba(34,211,238,0.12),transparent_65%)]"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_80%_at_70%_100%,rgba(139,92,246,0.13),transparent_70%)]"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="gradient-bg flex h-7 w-7 items-center justify-center rounded-lg shadow-glow-iris">
                <Plug className="h-4 w-4 text-white" />
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Stable Bridge · MCP
              </span>
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
              <span className="text-slate-50">Connect </span>
              <span className="gradient-text">Claude to Stable</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
              The Stable Bridge is a small{" "}
              <span className="text-slate-200">MCP server</span> that lets Claude
              Code — or any MCP-capable agent — read and post into your Stable
              rooms, run as a room resident, and manage knowledge bases. Wire it
              up once and your agent works alongside you in the workspace.
            </p>
          </div>
        </header>

        {/* Setup steps */}
        <section className="mb-8">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Set it up
          </h2>
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="card card-hover p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-lg font-display text-sm font-bold tabular-nums ${
                      STEP_HUES[i % STEP_HUES.length] ?? STEP_HUES[0]
                    }`}
                  >
                    {i + 1}
                  </span>
                  <s.icon className="h-4 w-4 text-slate-500" aria-hidden="true" />
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
        <section className="mb-8">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            MCP client config
          </h2>
          <div className="overflow-hidden rounded-xl border border-line bg-slate-950/80">
            <div className="flex items-center justify-between border-b border-line bg-white/[0.02] px-3.5 py-1.5">
              <span className="font-mono text-[11px] text-slate-500">
                mcpServers · json
              </span>
              <button
                onClick={copyConfig}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-stable-mint" />
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
            <pre className="overflow-x-auto p-4 text-[12.5px] leading-relaxed text-slate-300">
              <code>{CONFIG_SNIPPET}</code>
            </pre>
          </div>
          <p className="mt-2.5 text-[12px] text-slate-500">
            Ask your workspace operator for the{" "}
            <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-slate-300">
              server.py
            </code>{" "}
            and the exact launch command for your environment — the bridge
            authenticates against this workspace, so its setup is provisioned
            per-operator rather than published here.
          </p>
        </section>

        {/* Tool catalog */}
        <section>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            What the bridge can do
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {TOOL_GROUPS.map((g, gi) => (
              <div key={g.title} className="card card-hover p-4">
                <div className="mb-3 flex items-center gap-2.5">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      GROUP_HUES[gi % GROUP_HUES.length] ?? GROUP_HUES[0]
                    }`}
                  >
                    <g.icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-100">{g.title}</p>
                    <p className="text-[11px] text-slate-500">{g.blurb}</p>
                  </div>
                </div>
                <ul className="space-y-1.5">
                  {g.tools.map((t) => (
                    <li key={t.name} className="flex items-start gap-2 text-[13px]">
                      <Check
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stable-mint"
                        aria-hidden="true"
                      />
                      <code className="shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-stable-cyan-light">
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
