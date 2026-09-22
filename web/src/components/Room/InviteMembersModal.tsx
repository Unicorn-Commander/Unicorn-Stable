import { useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Search, UserPlus, X } from "lucide-react";
import clsx from "clsx";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useModalA11y } from "@/hooks/useModalA11y";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";

interface InviteMembersModalProps {
  roomId: string;
  roomName: string;
  /**
   * Open the guest-access console instead. Passed only for a room OWNER —
   * minting a guest link is owner-only server-side, so a member must not be
   * offered a door that answers 403. Absent = the entry is not rendered.
   */
  onOpenGuestAccess?: () => void;
  onClose: () => void;
}

export function InviteMembersModal({
  roomId,
  roomName,
  onOpenGuestAccess,
  onClose,
}: InviteMembersModalProps) {
  const [query, setQuery] = useState("");
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  const [copiedLink, setCopiedLink] = useState(false);
  const queryClient = useQueryClient();
  const panelRef = useModalA11y(true, onClose);

  const { data: users = [] } = useQuery({
    queryKey: ["users-search", query],
    queryFn: () => api.searchUsers(query),
  });

  const { data: currentMembers = [] } = useQuery({
    queryKey: ["room-members", roomId],
    queryFn: () => api.getRoomMembers(roomId),
  });

  const existingIds = new Set(
    currentMembers.map((m) => m.participant_id || m.user_id || "").filter(Boolean),
  );

  async function invite(u: {
    id: string | null;
    keycloak_sub: string;
    display_name?: string | null;
    username?: string | null;
  }) {
    const key = u.id || u.keycloak_sub;
    try {
      await api.inviteUserToRoom(
        roomId,
        u.id
          ? { participant_id: u.id }
          : { keycloak_sub: u.keycloak_sub },
      );
      setInvitedIds((prev) => new Set(prev).add(key));
      await queryClient.invalidateQueries({ queryKey: ["room-members", roomId] });
    } catch (e) {
      console.error("invite failed", e);
      const err = e as { detail?: unknown; message?: string };
      useAppStore.getState().pushToast({
        title: `Couldn't invite ${u.display_name || u.username || "that person"}`,
        body: (typeof err.detail === "string" && err.detail) || err.message || "Try again in a moment.",
      });
    }
  }

  const signupLink = `${window.location.origin}/`;

  async function copyLink() {
    await navigator.clipboard.writeText(signupLink);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Invite people"
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="glass-heavy w-full max-w-md rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-100">
              Invite to {roomName}
            </h2>
            <p className="text-xs text-slate-400">
              Add existing members or share the link below for new signups.
            </p>
          </div>
          <button
            onClick={onClose}
            className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-5 pt-4">
        {/* Search */}
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            autoFocus
            type="text"
            placeholder="Search by name or username…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-xl border border-line bg-slate-950/60 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
          />
        </div>

        {/* Results */}
        <div className="mb-4 max-h-64 overflow-y-auto">
          {users.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-slate-500">
              {query ? "No matching users." : "Start typing to search."}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {users.map((u) => {
                const key = u.id || u.keycloak_sub;
                const alreadyIn = u.id ? existingIds.has(u.id) : false;
                const justInvited = invitedIds.has(key);
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-3 py-2 transition-colors hover:bg-white/[0.02]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Identity
                        {...resolveIdentity({
                          id: u.id,
                          username: u.username,
                          display_name: u.display_name || u.username,
                          avatar_url: u.avatar_url,
                          participant_type: "human",
                        })}
                        size={28}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-200">
                          {u.display_name || u.username}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          @{u.username}
                          {!u.signed_in && (
                            <span className="ml-2 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-400">
                              hasn't signed in yet
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => invite(u)}
                      disabled={alreadyIn || justInvited}
                      className={clsx(
                        "focus-ring flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        alreadyIn
                          ? "cursor-not-allowed bg-white/[0.04] text-slate-500"
                          : justInvited
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-stable-purple/20 text-stable-purple-light hover:bg-stable-purple/30",
                      )}
                    >
                      {alreadyIn ? (
                        "In room"
                      ) : justInvited ? (
                        <>
                          <Check className="h-3 w-3" /> Added
                        </>
                      ) : (
                        <>
                          <UserPlus className="h-3 w-3" /> Add
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Share link for new users */}
        <div className="rounded-xl border border-line bg-slate-950/50 p-3">
          <p className="mb-2 text-xs text-slate-400">
            New to Stable? Share this link — they can register from the
            sign-in page, then you can add them here.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-white/[0.06] px-2 py-1 text-xs text-slate-300">
              {signupLink}
            </code>
            <button
              onClick={copyLink}
              className="focus-ring flex items-center gap-1 rounded-md bg-stable-purple/20 px-2 py-1 text-xs font-medium text-stable-purple-light transition-colors hover:bg-stable-purple/30"
            >
              {copiedLink ? (
                <>
                  <Check className="h-3 w-3" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" /> Copy
                </>
              )}
            </button>
          </div>
        </div>

        {/* The other kind of invite. Everything above adds someone WITH an
            account (or asks them to make one); this hands a link to someone who
            never will — an outside guest for a show. Same intent, different
            door, so it belongs next to the first one rather than only in a
            menu. Owner-only: see `onOpenGuestAccess`. */}
        {onOpenGuestAccess && (
          <button
            onClick={onOpenGuestAccess}
            className="focus-ring mt-3 flex w-full items-start gap-2 rounded-xl border border-line bg-slate-950/50 p-3 text-left transition-colors hover:border-stable-purple/40 hover:bg-stable-purple/10"
          >
            <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-stable-purple-light" />
            <span>
              <span className="block text-sm text-slate-200">
                Guest access — someone with no account
              </span>
              <span className="block text-xs text-slate-500">
                A link that lets an outsider into this room for a while, with no
                sign-up. Treat it like a password.
              </span>
            </span>
          </button>
        )}
        </div>
      </motion.div>
    </motion.div>
  );
}
