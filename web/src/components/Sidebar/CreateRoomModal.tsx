import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { X, Hash, MessageSquare, Users, Bot, Check } from "lucide-react";
import clsx from "clsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { CreateRoomRequest, Room } from "@/services/api";
import { identityFor } from "@/lib/identity";
import { useAppStore } from "@/stores/appStore";

type RoomType = "channel" | "group_dm" | "dm";

export function CreateRoomModal() {
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const navigate = useNavigate();
  const agents = useAppStore((s) => s.agents);
  const queryClient = useQueryClient();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [roomType, setRoomType] = useState<RoomType>("channel");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setCreateRoomModalOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setCreateRoomModalOpen]);

  const createMutation = useMutation({
    mutationFn: (data: CreateRoomRequest) => api.createRoom(data),
    onSuccess: (room: Room) => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      setCreateRoomModalOpen(false);
      navigate(`/c/${room.id}`);
    },
  });

  function toggleAgent(agentId: string) {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    createMutation.mutate({
      name: name.trim(),
      description: description.trim(),
      type: roomType,
      member_ids: [],
      agent_ids: Array.from(selectedAgentIds),
    });
  }

  // `hue` is purely presentational — each room type gets its own accent so the
  // three tiles read at a glance.
  const typeOptions: Array<{
    value: RoomType;
    label: string;
    icon: typeof Hash;
    desc: string;
    hue: string;
  }> = [
    {
      value: "channel",
      label: "Channel",
      icon: Hash,
      desc: "Open to all members",
      hue: "text-stable-cyan",
    },
    {
      value: "group_dm",
      label: "Group",
      icon: Users,
      desc: "Private group conversation",
      hue: "text-stable-mint",
    },
    {
      value: "dm",
      label: "Direct",
      icon: MessageSquare,
      desc: "One-to-one conversation",
      hue: "text-stable-purple-light",
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setCreateRoomModalOpen(false);
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Create a room"
      data-testid="create-room-modal"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="glass-heavy w-full max-w-lg overflow-hidden rounded-2xl shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="font-display text-lg font-semibold text-slate-50">
            Create a room
          </h2>
          <button
            onClick={() => setCreateRoomModalOpen(false)}
            className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5 px-6 py-5">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="room-name"
              className="text-xs font-medium text-slate-400"
            >
              Room name
            </label>
            <input
              ref={nameInputRef}
              id="room-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. general, project-alpha"
              maxLength={80}
              required
              className="rounded-xl border border-line bg-slate-950/60 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="room-desc"
              className="text-xs font-medium text-slate-400"
            >
              Description
              <span className="ml-1 text-slate-600">(optional)</span>
            </label>
            <input
              id="room-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this room about?"
              maxLength={200}
              className="rounded-xl border border-line bg-slate-950/60 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-slate-400">Type</span>
            <div className="grid grid-cols-3 gap-2">
              {typeOptions.map((opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRoomType(opt.value)}
                    className={clsx(
                      "card card-hover focus-ring flex flex-col items-center gap-1.5 px-3 py-3",
                      roomType === opt.value
                        ? "border-stable-purple/60 bg-stable-purple/10 text-slate-100 hover:border-stable-purple/60"
                        : "text-slate-400 hover:text-slate-300",
                    )}
                  >
                    <Icon
                      className={clsx(
                        "h-5 w-5",
                        opt.hue,
                        roomType === opt.value ? "opacity-100" : "opacity-75",
                      )}
                    />
                    <span className="text-xs font-medium">{opt.label}</span>
                    <span className="text-[10px] opacity-60">{opt.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {agents.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
                <Bot className="h-3.5 w-3.5 text-stable-purple-light" />
                Add AI agents
              </span>
              <div className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-slate-950/40 p-1.5">
                {agents.map((agent) => {
                  const ident = identityFor(
                    agent.id,
                    agent.display_name || agent.name,
                  );
                  const selected = selectedAgentIds.has(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleAgent(agent.id)}
                      className={clsx(
                        "focus-ring flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                        selected
                          ? "text-slate-100"
                          : "text-slate-300 hover:bg-white/[0.04]",
                      )}
                      style={selected ? { background: ident.faint } : undefined}
                    >
                      <div
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
                        style={{
                          background: ident.soft,
                          borderColor: ident.border,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: ident.color }}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p
                          className="truncate text-sm font-medium"
                          style={{ color: ident.text }}
                        >
                          {agent.display_name}
                        </p>
                        <p className="truncate text-[11px] text-slate-500">
                          {agent.description}
                        </p>
                      </div>
                      {selected && (
                        <Check
                          className="h-4 w-4 shrink-0"
                          style={{ color: ident.text }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {createMutation.isError && (
            <p className="text-xs text-rose-400">
              Failed to create room. Please try again.
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => setCreateRoomModalOpen(false)}
              className="focus-ring rounded-xl px-4 py-2 text-sm text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || createMutation.isPending}
              className="focus-ring gradient-bg shadow-glow-iris rounded-xl px-4 py-2 text-sm font-semibold text-white transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createMutation.isPending ? "Creating…" : "Create room"}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
