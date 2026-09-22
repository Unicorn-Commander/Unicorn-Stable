/**
 * Tasks column. The project-task list arrives with the conversation model;
 * this surface is the panel the layout can dock, float, or pop out today.
 */
export function TasksPanel({ roomId }: { roomId: string }) {
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-surface-0"
      aria-label="Tasks"
      data-room={roomId}
    >
      <header className="flex h-12 shrink-0 items-center border-b border-line px-3 text-sm font-semibold text-slate-100">
        Tasks
      </header>
      <p className="px-3 py-3 text-xs leading-5 text-slate-400">
        No open tasks are attached to this room yet.
      </p>
    </section>
  );
}

/** Thread list for the room. Reply threads still open from a message. */
export function ThreadsPanel({ roomId }: { roomId: string }) {
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-surface-0"
      aria-label="Threads"
      data-room={roomId}
    >
      <header className="flex h-12 shrink-0 items-center border-b border-line px-3 text-sm font-semibold text-slate-100">
        Threads
      </header>
      <p className="px-3 py-3 text-xs leading-5 text-slate-400">
        Threads in this room will list here.
      </p>
    </section>
  );
}
