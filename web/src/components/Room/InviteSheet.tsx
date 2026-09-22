import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, X } from "lucide-react";
import { api } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { agentModeLabel, guestLinkConsequence } from "@/lib/conversation";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { useModalA11y } from "@/hooks/useModalA11y";
import { AgentModeChip } from "./AgentModeChip";

/**
 * People picker (humans + agents, with mode chips) plus an invite link.
 * The guest link stays a separate door with its own consequence line.
 */
export function InviteSheet({
  roomId,
  onOpenGuestAccess,
}: {
  roomId: string;
  onOpenGuestAccess?: () => void;
}) {
  const openFor = useConversationUi((s) => s.inviteSheetRoomId);
  const close = useConversationUi((s) => s.closeInviteSheet);
  const open = openFor === roomId;
  const panelRef = useModalA11y(open, close);
  const [q, setQ] = useState("");
  const [hours, setHours] = useState(24 * 7);
  const [maxUses, setMaxUses] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const agents = useAppStore((s) => s.agents);
  const members = useAppStore((s) => s.participants[roomId]) ?? [];

  const { data: people = [] } = useQuery({
    queryKey: ["people-directory", "invite", q],
    queryFn: () => api.getPeopleDirectory(q),
    enabled: open,
  });

  if (!open) return null;

  const memberIds = new Set(
    members.map((m) => m.participant_id || m.user_id).filter(Boolean),
  );

  async function addPerson(participantId: string) {
    try {
      await api.inviteUserToRoom(roomId, { participant_id: participantId });
      await qc.invalidateQueries({ queryKey: ["room-members", roomId] });
      useAppStore.getState().pushToast({
        title: "Invited",
        body: "They'll see this room in Needs you.",
        kind: "success",
      });
    } catch (err) {
      useAppStore.getState().pushToast({
        title: "Couldn't invite them",
        body: (err as Error).message,
        kind: "error",
      });
    }
  }

  async function addAgent(agentId: string) {
    try {
      await api.inviteBrigadeAgent(roomId, agentId, undefined, { dispatch: false });
      await qc.invalidateQueries({ queryKey: ["room-members", roomId] });
    } catch (err) {
      useAppStore.getState().pushToast({
        title: "Couldn't add that agent",
        body: (err as Error).message,
        kind: "error",
      });
    }
  }

  async function copyLink() {
    if (busy) return;
    setBusy(true);
    try {
      const uses = maxUses.trim() ? Number(maxUses) : null;
      const invite = await api.mintRoomInvite(roomId, {
        expires_hours: hours,
        max_uses: uses && uses > 0 ? uses : null,
        role,
      });
      const path = invite.url_path || (invite.token ? `/join/${invite.token}` : "");
      const url = path.startsWith("http") ? path : `${window.location.origin}${path}`;
      await navigator.clipboard.writeText(url);
      useConversationUi.getState().noteInvite({
        id: invite.id,
        roomId,
        label: `Invite link · ${invite.token_prefix}`,
        at: Date.now(),
      });
      useAppStore.getState().pushToast({
        title: "Invite link copied",
        body: `Expires in ${hours / 24} days${uses ? `, ${uses} uses` : ""}.`,
        kind: "success",
      });
    } catch (err) {
      useAppStore.getState().pushToast({
        title: "Couldn't create an invite link",
        body: (err as { detail?: string }).detail || (err as Error).message,
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  const qNorm = q.trim().toLowerCase();
  const agentRows = agents.filter((agent) =>
    `${agent.display_name} ${agent.name} ${agent.id}`.toLowerCase().includes(qNorm),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 sm:items-start sm:p-4 sm:pt-[8dvh]"
      onClick={close}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-sheet-title"
        className="glass-heavy flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl shadow-pop sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id="invite-sheet-title" className="font-display text-base font-semibold text-slate-100">
            Invite
          </h2>
          <button type="button" onClick={close} className="focus-ring rounded-md p-1.5 text-slate-400" aria-label="Close invite">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people and agents"
            aria-label="Search people and agents"
            className="w-full rounded-xl border border-line bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-stable-purple/60"
          />
          <section>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">People</h3>
            <ul className="flex flex-col">
              {people.slice(0, 8).map((person) => (
                <li key={person.id}>
                  <button
                    type="button"
                    disabled={memberIds.has(person.id)}
                    onClick={() => void addPerson(person.id)}
                    className="focus-ring flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left hover:bg-white/[0.04] disabled:opacity-50"
                  >
                    <Identity {...resolveIdentity(person)} presence={null} size={24} />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{person.display_name}</span>
                    <span className="text-[11px] text-slate-500">
                      {memberIds.has(person.id) ? "In the room" : "Invite"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Agents</h3>
            <ul className="flex flex-col">
              {agentRows.slice(0, 8).map((agent) => {
                const member = members.find(
                  (m) =>
                    m.participant_type === "agent" &&
                    ((m.username || "").replace(/^agent-/, "") === agent.id ||
                      m.display_name === agent.display_name),
                );
                return (
                  <li key={agent.id} className="flex items-center gap-2 px-1 py-1.5">
                    <Identity {...resolveIdentity(agent)} presence={null} size={24} />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                      {agent.display_name || agent.name}
                    </span>
                    <AgentModeChip mode={member?.agent_mode} compact />
                    {!member && (
                      <button
                        type="button"
                        onClick={() => void addAgent(agent.id)}
                        className="focus-ring text-[11px] text-stable-cyan"
                      >
                        Add
                      </button>
                    )}
                    {member && !member.agent_mode && (
                      <span className="text-[10px] text-slate-500">{agentModeLabel("when_named")}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="rounded-xl border border-line p-3">
            <h3 className="text-sm font-medium text-slate-100">Copy invite link</h3>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              For someone with a Unicorn Commander account. Default expiry is 7 days.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="text-[11px] text-slate-500">
                Expires (hours)
                <input
                  type="number"
                  min={1}
                  max={24 * 30}
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value) || 24 * 7)}
                  className="ml-2 w-20 rounded-md border border-line bg-slate-950/60 px-2 py-1 text-xs text-slate-100"
                />
              </label>
              <label className="text-[11px] text-slate-500">
                Max uses
                <input
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  placeholder="∞"
                  className="ml-2 w-16 rounded-md border border-line bg-slate-950/60 px-2 py-1 text-xs text-slate-100"
                />
              </label>
              <label className="text-[11px] text-slate-500">
                Role
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as "member" | "admin")}
                  className="ml-2 rounded-md border border-line bg-slate-950/60 px-2 py-1 text-xs text-slate-100"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              onClick={() => void copyLink()}
              disabled={busy}
              className="focus-ring mt-3 inline-flex items-center gap-1.5 rounded-lg bg-stable-purple px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              <Copy className="h-3.5 w-3.5" />
              {busy ? "Copying…" : "Copy invite link"}
            </button>
          </section>
          {onOpenGuestAccess && (
            <section className="rounded-xl border border-dashed border-line p-3">
              <h3 className="text-sm font-medium text-slate-100">Guest link</h3>
              <p className="mt-1 text-xs leading-5 text-slate-400">{guestLinkConsequence()}</p>
              <button
                type="button"
                onClick={onOpenGuestAccess}
                className="focus-ring mt-2 text-xs font-medium text-stable-cyan"
              >
                Open guest access…
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
