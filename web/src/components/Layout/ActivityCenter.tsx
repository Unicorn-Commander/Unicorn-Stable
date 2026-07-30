import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Check,
  ExternalLink,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { api, type ApiError, type PendingApproval } from "@/services/api";
import { Avatar } from "@/components/Avatar";
import { useModalA11y } from "@/hooks/useModalA11y";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";

interface ActivityCenterProps {
  onClose: () => void;
}

function errorDetail(error: unknown): string {
  const apiError = error as Partial<ApiError>;
  return (
    apiError.detail ??
    apiError.message ??
    "The decision could not be recorded. Refresh and try again."
  );
}

export function ActivityCenter({ onClose }: ActivityCenterProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const panelRef = useModalA11y(true, onClose);
  const pushToast = useAppStore((state) => state.pushToast);
  const updateMessage = useAppStore((state) => state.updateMessage);
  const activeInstanceId = useFederationStore((state) => state.activeInstanceId);
  const [deciding, setDeciding] = useState<{
    id: string;
    decision: "approved" | "rejected";
  } | null>(null);

  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["approvals", "pending", activeInstanceId],
    queryFn: () => api.getPendingApprovals(),
    refetchInterval: 15_000,
  });
  const approvals = data?.items ?? [];

  async function decide(
    approval: PendingApproval,
    decision: "approved" | "rejected",
  ) {
    if (deciding) return;
    setDeciding({ id: approval.message.id, decision });
    try {
      const updated = await api.decideAction(approval.message.id, decision);
      updateMessage(updated.room_id, updated.id, updated);
      await queryClient.invalidateQueries({
        queryKey: ["approvals", "pending"],
      });
      pushToast({
        title: decision === "approved" ? "Request approved" : "Request rejected",
        body: `${approval.message.sender_name} · ${approval.room_name}`,
      });
    } catch (error) {
      // A different owner/admin may have decided while this panel was open.
      // Refresh first so the queue immediately converges to server truth.
      await refetch();
      pushToast({
        title: "Decision not recorded",
        body: errorDetail(error),
      });
    } finally {
      setDeciding(null);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-center-title"
        initial={{ x: 36, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 36, opacity: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="glass-heavy flex h-full w-full max-w-md flex-col border-l border-line shadow-pop sm:my-3 sm:mr-3 sm:h-[calc(100%-1.5rem)] sm:rounded-2xl sm:border"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-stable-purple/15">
              <Activity className="h-4.5 w-4.5 text-stable-purple-light" />
            </span>
            <div className="min-w-0">
              <h2
                id="activity-center-title"
                className="font-display text-base font-semibold text-slate-100"
              >
                Activity Center
              </h2>
              <p className="truncate text-xs text-slate-400">
                Agent requests awaiting your approval
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close Activity Center"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <ShieldCheck className="h-4 w-4 text-emerald-300" />
          <span className="text-xs font-semibold text-slate-200">Approvals</span>
          {!isLoading && (
            <span
              className="ml-auto rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-semibold text-slate-300 tabular-nums"
              aria-label={`${approvals.length}${data?.has_more ? " or more" : ""} pending approvals`}
            >
              {approvals.length}
              {data?.has_more ? "+" : ""}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div
              className="flex h-40 items-center justify-center text-sm text-slate-400"
              role="status"
            >
              Loading approvals…
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center px-6 py-14 text-center">
              <XCircle className="mb-3 h-7 w-7 text-rose-300" />
              <h3 className="text-sm font-semibold text-slate-100">
                Approvals unavailable
              </h3>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-400">
                Stable could not load your room-scoped approval queue.
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="focus-ring mt-4 min-h-11 rounded-xl border border-line bg-white/[0.04] px-4 text-sm font-semibold text-slate-200 transition-colors hover:bg-white/[0.08]"
              >
                Try again
              </button>
            </div>
          ) : approvals.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-400/10">
                <Check className="h-6 w-6 text-emerald-300" />
              </span>
              <h3 className="font-display text-base font-semibold text-slate-100">
                You’re all caught up
              </h3>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-400">
                No canonical agent action requests need your decision.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-line" aria-label="Pending approvals">
              {approvals.map((approval) => {
                const message = approval.message;
                const busy = deciding?.id === message.id;
                return (
                  <li key={message.id} className="p-4">
                    <article className="rounded-2xl border border-line bg-white/[0.025] p-3.5">
                      <div className="flex items-start gap-3">
                        <Avatar
                          name={message.sender_name}
                          src={message.sender_avatar}
                          size="sm"
                          isAgent
                          id={message.sender_id}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-100">
                            {message.sender_name}
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            {approval.room_name} ·{" "}
                            {new Date(message.created_at).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-200">
                        {message.content}
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={deciding !== null}
                          onClick={() => void decide(approval, "rejected")}
                          className="focus-ring min-h-11 rounded-xl border border-rose-400/25 bg-rose-400/10 px-3 text-sm font-semibold text-rose-200 transition-colors hover:bg-rose-400/15 disabled:cursor-wait disabled:opacity-50"
                        >
                          {busy && deciding?.decision === "rejected"
                            ? "Rejecting…"
                            : "Reject"}
                        </button>
                        <button
                          type="button"
                          disabled={deciding !== null}
                          onClick={() => void decide(approval, "approved")}
                          className="focus-ring min-h-11 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 text-sm font-semibold text-emerald-200 transition-colors hover:bg-emerald-400/15 disabled:cursor-wait disabled:opacity-50"
                        >
                          {busy && deciding?.decision === "approved"
                            ? "Approving…"
                            : "Approve"}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          navigate(`/c/${approval.room_id}?message=${message.id}`);
                        }}
                        className="focus-ring mt-2 flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200"
                      >
                        Open in room
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {data?.has_more && (
          <p className="shrink-0 border-t border-line px-4 py-3 text-center text-xs text-slate-400">
            Showing the oldest 50 requests. Decide or reject them to reveal more.
          </p>
        )}
      </motion.section>
    </motion.div>
  );
}
