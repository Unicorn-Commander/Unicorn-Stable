/**
 * Export a room's conversation to a downloadable Markdown file.
 *
 * Pages through the message history (newest-first cursor API), re-orders to
 * chronological, renders a readable Markdown transcript, and triggers a browser
 * download. Purely client-side — no backend endpoint needed.
 */
import { api, type Room, type Message } from "@/services/api";

const MAX_PAGES = 40; // safety cap: ~2000 messages at 50/page
const PAGE_SIZE = 50;

async function fetchAllMessages(roomId: string): Promise<Message[]> {
  const all: Message[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await api.getMessages(roomId, cursor, PAGE_SIZE);
    all.push(...page.items);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  // De-dupe (cursor overlaps can repeat a boundary row) and sort oldest→newest.
  const seen = new Set<string>();
  const unique = all.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  unique.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return unique;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "conversation"
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toMarkdown(room: Room, messages: Message[]): string {
  const title = room.name || room.display_name || "Conversation";
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `_Exported from Unicorn Stable on ${fmtTime(
      new Date().toISOString(),
    )} · ${messages.length} message${messages.length === 1 ? "" : "s"}_`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  let lastDay = "";
  for (const m of messages) {
    if (m.content_type === "system") {
      lines.push(`> _${(m.content || "").trim()}_`);
      lines.push("");
      continue;
    }
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay && day !== "Invalid Date") {
      lines.push(`### ${day}`);
      lines.push("");
      lastDay = day;
    }
    const who = m.sender_name || (m.sender_type === "agent" ? "Agent" : "User");
    const tag = m.sender_type === "agent" ? " 🤖" : "";
    lines.push(`**${who}${tag}** · ${fmtTime(m.created_at)}`);
    lines.push("");
    lines.push((m.content || "").trimEnd());
    if (m.edited) lines.push("\n_(edited)_");
    lines.push("");
  }
  return lines.join("\n");
}

function triggerDownload(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportRoomToMarkdown(room: Room): Promise<void> {
  const messages = await fetchAllMessages(room.id);
  const md = toMarkdown(room, messages);
  triggerDownload(`${slugify(room.name || "conversation")}.md`, md);
}
