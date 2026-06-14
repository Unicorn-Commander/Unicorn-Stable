import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Search, UserPlus, X } from "lucide-react";
import clsx from "clsx";
import { api } from "@/services/api";
import { Avatar } from "@/components/Avatar";

interface InviteMembersModalProps {
  roomId: string;
  roomName: string;
  onClose: () => void;
}

export function InviteMembersModal({
  roomId,
  roomName,
  onClose,
}: InviteMembersModalProps) {
  const [query, setQuery] = useState("");
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  const [copiedLink, setCopiedLink] = useState(false);
  const queryClient = useQueryClient();

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
    }
  }

  const signupLink = `${window.location.origin}/`;

  async function copyLink() {
    await navigator.clipboard.writeText(signupLink);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="w-full max-w-md rounded-xl border border-slate-700/50 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Invite to {roomName}
            </h2>
            <p className="text-xs text-slate-400">
              Add existing members or share the link below for new signups.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            autoFocus
            type="text"
            placeholder="Search by name or username…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 py-2 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 focus:border-stable-purple focus:outline-none"
          />
        </div>

        {/* Results */}
        <div className="mb-4 max-h-64 overflow-y-auto">
          {users.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-slate-500">
              {query ? "No matching users." : "Start typing to search."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {users.map((u) => {
                const key = u.id || u.keycloak_sub;
                const alreadyIn = u.id ? existingIds.has(u.id) : false;
                const justInvited = invitedIds.has(key);
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar
                        name={u.display_name || u.username}
                        src={u.avatar_url}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-200">
                          {u.display_name || u.username}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          @{u.username}
                          {!u.signed_in && (
                            <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
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
                        "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs",
                        alreadyIn
                          ? "cursor-not-allowed bg-slate-800 text-slate-500"
                          : justInvited
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-stable-purple/20 text-stable-purple hover:bg-stable-purple/30",
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
        <div className="rounded-md border border-slate-800 bg-slate-950 p-3">
          <p className="mb-2 text-xs text-slate-400">
            New to Stable? Share this link — they can register from the sign-in
            page, then you can add them here.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-slate-800 px-2 py-1 text-xs text-slate-300">
              {signupLink}
            </code>
            <button
              onClick={copyLink}
              className="flex items-center gap-1 rounded bg-stable-purple/20 px-2 py-1 text-xs text-stable-purple hover:bg-stable-purple/30"
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
      </motion.div>
    </motion.div>
  );
}
