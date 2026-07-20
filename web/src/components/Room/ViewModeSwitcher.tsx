import clsx from "clsx";
import {
  LayoutGrid,
  User,
  Pin,
  Presentation,
  Rows3,
  PanelRight,
  Captions,
  type LucideIcon,
} from "lucide-react";
import { useCallUiStore } from "@/stores/callUiStore";
import type { CallViewMode } from "@/lib/roomDataProtocol";

/**
 * ViewModeSwitcher — the human-facing "clear switcher" for the call stage.
 *
 * It presents FRIENDLY, named modes (Gallery · Speaker · Spotlight ·
 * Presentation, plus the Compact/Side-dock utility layouts) and maps them onto
 * the closed {@link CallViewMode} wire union that agents ALSO drive via the
 * `ui_command` seam — so human + agent share one source of truth. The mapping:
 *
 *   Gallery       → "grid"       (equal, paginated tiles)
 *   Speaker       → "spotlight"  + clear the pin  (auto active-speaker)
 *   Spotlight     → "spotlight"  + pin the featured participant (sticky)
 *   Presentation  → "screen"     (a screen share fills the stage)
 *   Compact       → "compact"    (audio-first bar)
 *   Side dock     → "sidebar"    (narrow co-working column)
 *
 * Speaker and Spotlight are the SAME wire mode (`spotlight`) — the only
 * difference is whether a durable pin is set, which is exactly how the big-tile
 * resolution works in VoiceVideoBar (`pinned ?? focused ?? activeSpeaker ?? …`).
 * The switcher reflects that: it lights "Spotlight" when a pin exists and
 * "Speaker" otherwise.
 *
 * Supersedes the older icon-only CallViewSwitcher (which only knew the original
 * four modes and had no pin concept).
 */

interface ViewModeSwitcherProps {
  roomId: string;
  /** Slim presentation for the compact audio bar: hide labels + toggles. */
  compact?: boolean;
  className?: string;
  /**
   * The participant currently featured on the big stage. Clicking "Spotlight"
   * with no existing pin pins THIS participant, so the choice is immediate and
   * meaningful rather than dropping the user into an unpinned spotlight.
   */
  activeParticipantId?: string | null;
  /** True when at least one screen share is live — badges the Presentation button. */
  screenShareActive?: boolean;
}

/** A friendly, user-facing mode label distinct from the wire {@link CallViewMode}. */
type FriendlyMode =
  | "gallery"
  | "speaker"
  | "spotlight"
  | "presentation"
  | "compact"
  | "sidebar";

interface ModeSpec {
  friendly: FriendlyMode;
  label: string;
  hint: string;
  icon: LucideIcon;
}

/** The four headline modes the task calls out — shown with labels on wide bars. */
const PRIMARY_MODES: ModeSpec[] = [
  {
    friendly: "gallery",
    label: "Gallery",
    hint: "Equal tiles for everyone",
    icon: LayoutGrid,
  },
  {
    friendly: "speaker",
    label: "Speaker",
    hint: "Auto-promote the active speaker",
    icon: User,
  },
  {
    friendly: "spotlight",
    label: "Spotlight",
    hint: "Pin one participant to the big tile",
    icon: Pin,
  },
  {
    friendly: "presentation",
    label: "Present",
    hint: "A screen share fills the stage",
    icon: Presentation,
  },
];

/** Utility layouts — icon-only, shown after a divider. */
const UTILITY_MODES: ModeSpec[] = [
  { friendly: "compact", label: "Compact", hint: "Audio bar", icon: Rows3 },
  { friendly: "sidebar", label: "Side dock", hint: "Narrow co-working column", icon: PanelRight },
];

export function ViewModeSwitcher({
  roomId,
  compact = false,
  className,
  activeParticipantId = null,
  screenShareActive = false,
}: ViewModeSwitcherProps) {
  const viewMode = useCallUiStore((s) => s.viewModes[roomId]) ?? "compact";
  const pinnedId = useCallUiStore((s) => s.pinnedParticipantId[roomId] ?? null);
  const setViewMode = useCallUiStore((s) => s.setViewMode);
  const setPinnedParticipant = useCallUiStore((s) => s.setPinnedParticipant);
  const showTranscript = useCallUiStore((s) => s.showTranscript);
  const toggleTranscript = useCallUiStore((s) => s.toggleTranscript);

  // Which friendly mode is active right now (from the wire mode + pin state).
  const activeFriendly: FriendlyMode = friendlyForViewMode(viewMode, pinnedId);

  function selectMode(friendly: FriendlyMode) {
    switch (friendly) {
      case "gallery":
        setViewMode(roomId, "grid");
        break;
      case "speaker":
        // Auto active-speaker: clear any durable pin, enter spotlight.
        setPinnedParticipant(roomId, null);
        setViewMode(roomId, "spotlight");
        break;
      case "spotlight":
        // Sticky pin: if nothing's pinned yet, pin whoever is currently featured
        // so the choice is immediate; otherwise just make the pin visible.
        setViewMode(roomId, "spotlight");
        if (!pinnedId && activeParticipantId) {
          setPinnedParticipant(roomId, activeParticipantId);
        }
        break;
      case "presentation":
        setViewMode(roomId, "screen");
        break;
      case "compact":
        setViewMode(roomId, "compact");
        break;
      case "sidebar":
        setViewMode(roomId, "sidebar");
        break;
    }
  }

  return (
    <div
      className={clsx("flex items-center gap-1", className)}
      role="group"
      aria-label="Call view controls"
    >
      <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-2/80 p-0.5">
        {PRIMARY_MODES.map((spec) => (
          <ModeButton
            key={spec.friendly}
            spec={spec}
            active={activeFriendly === spec.friendly}
            showLabel={!compact}
            badge={spec.friendly === "presentation" && screenShareActive}
            onSelect={() => selectMode(spec.friendly)}
          />
        ))}

        <span
          aria-hidden="true"
          className="mx-0.5 h-5 w-px shrink-0 bg-line"
        />

        {UTILITY_MODES.map((spec) => (
          <ModeButton
            key={spec.friendly}
            spec={spec}
            active={activeFriendly === spec.friendly}
            showLabel={false}
            onSelect={() => selectMode(spec.friendly)}
          />
        ))}
      </div>

      {/* Video hide/show lives in the call controls bar (VoiceVideoBar) as the
          single canonical toggle — it used to be duplicated here, which let the
          two desync. This switcher keeps only the transcript (captions) toggle. */}
      {!compact && (
        <button
          onClick={() => toggleTranscript()}
          className={clsx(
            "focus-ring flex h-7 w-7 items-center justify-center rounded-md transition-colors",
            showTranscript
              ? "bg-stable-cyan/15 text-stable-cyan"
              : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200",
          )}
          aria-label={showTranscript ? "Hide transcript" : "Show transcript"}
          aria-pressed={showTranscript}
          title={showTranscript ? "Hide live transcript" : "Show live transcript"}
        >
          <Captions className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

interface ModeButtonProps {
  spec: ModeSpec;
  active: boolean;
  showLabel: boolean;
  badge?: boolean;
  onSelect: () => void;
}

function ModeButton({ spec, active, showLabel, badge, onSelect }: ModeButtonProps) {
  const Icon = spec.icon;
  return (
    <button
      onClick={onSelect}
      className={clsx(
        "focus-ring relative flex h-7 items-center gap-1.5 rounded-md px-1.5 transition-colors",
        showLabel ? "min-w-7" : "w-7 justify-center",
        active
          ? "bg-stable-purple/25 text-stable-purple-light shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
          : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200",
      )}
      aria-label={`${spec.label} — ${spec.hint}`}
      aria-pressed={active}
      title={`${spec.label} · ${spec.hint}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {showLabel && (
        <span className="hidden text-xs font-medium lg:inline">{spec.label}</span>
      )}
      {badge && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-stable-cyan ring-2 ring-surface-2"
        />
      )}
    </button>
  );
}

/** Resolve which friendly button is lit from the raw wire mode + pin state. */
function friendlyForViewMode(
  mode: CallViewMode,
  pinnedId: string | null,
): FriendlyMode {
  switch (mode) {
    case "grid":
      return "gallery";
    case "screen":
      return "presentation";
    case "sidebar":
      return "sidebar";
    case "compact":
      return "compact";
    case "spotlight":
    case "focus":
      // Same big-stage layout; the pin distinguishes Spotlight from Speaker.
      return pinnedId ? "spotlight" : "speaker";
    default:
      return "compact";
  }
}
