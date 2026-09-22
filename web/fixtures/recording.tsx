import { createRoot } from "react-dom/client";
import { RecPill } from "../src/components/Call/RecPill";
import { RecordingPolicyForm } from "../src/components/Room/RecordingPolicyForm";
import { RecordingsList } from "../src/components/Meetings/RecordingsList";
import { formatRecPill } from "../src/lib/recording";
import "../src/styles/globals.css";

const NOW = Date.parse("2026-09-21T18:12:04Z");
const STARTED = new Date(NOW - (12 * 60 + 4) * 1000).toISOString();

function Surface() {
  const label = formatRecPill({ startedAt: STARTED }, "Aaron", NOW);
  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-100">
      <section className="mb-6" data-testid="recording-call">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Recording call
        </h2>
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-slate-900 p-2">
          <RecPill label={label} />
          <button
            type="button"
            className="flex h-10 items-center gap-1 rounded-xl border border-rose-500/40 bg-rose-500/15 px-2.5 text-xs font-semibold text-rose-200"
          >
            <span aria-hidden="true">●</span>
            Stop
          </button>
        </div>
      </section>
      <section className="mb-6 max-w-md">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Room setting
        </h2>
        <RecordingPolicyForm value="on_request" saving={null} onChange={() => {}} />
      </section>
      <section className="max-w-md">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Recordings
        </h2>
        <RecordingsList
          rows={[
            {
              id: "rec-1",
              kind: "audio",
              status: "complete",
              started_by: "p-aaron",
              started_by_name: "Aaron",
              started_at: STARTED,
              duration_seconds: 724,
              storage_url: "https://storage.example/rec-1.ogg",
              session_url: "https://meetingops.example/sessions/mo-1",
              mo_session_id: "mo-1",
            },
          ]}
          members={[]}
          myRole="owner"
          myParticipantId="p-owner"
        />
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Surface />);
