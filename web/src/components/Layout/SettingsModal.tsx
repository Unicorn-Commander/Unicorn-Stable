import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Bell,
  BellRing,
  BookOpen,
  Captions,
  Check,
  LogOut,
  Mail,
  Palette,
  UserCircle,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useAppStore } from "@/stores/appStore";
import { Avatar } from "@/components/Avatar";
import { identityFor } from "@/lib/identity";
import { logout } from "@/services/auth";
import { api } from "@/services/api";
import { ensurePushSubscription } from "@/lib/webpush";
import { useModalA11y } from "@/hooks/useModalA11y";
import { Tooltip } from "@/components/ui";
import { AppearanceSection } from "@/components/Settings/AppearanceSection";
import { HelpCenter } from "@/components/Help";
import {
  loadMeetingOpsPrefs,
  saveMeetingOpsPrefs,
  type MeetingOpsTranscriptPrefs,
} from "@/lib/meetingOpsPrefs";

/**
 * Settings — one modal, four panes.
 *
 * It used to be a single scroll of unrelated sections. Panes exist because the
 * things in here answer different questions ("who am I", "what does it look
 * like", "when does it interrupt me", "how does this work") and a person
 * arriving with one of those questions should not have to read the other three.
 *
 * Appearance is NOT reimplemented here — `Settings/AppearanceSection` owns
 * theme mode, palette and their persistence, and this file only gives it a
 * pane. Help is likewise `components/Help`, embedded rather than duplicated, so
 * the guides have a home even before the app shell gets its own Help entry.
 */

interface SettingsModalProps {
  onClose: () => void;
  /** Open straight to a pane, e.g. a "Help" affordance elsewhere in the app. */
  initialPane?: PaneId;
}

const PREFS_KEY = "stable.notification.prefs.v1";

interface NotificationPrefs {
  inAppToasts: boolean;
  soundCues: boolean;
  emailOnInvite: boolean;
  emailOnMention: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = {
  inAppToasts: true,
  soundCues: true,
  emailOnInvite: true,
  emailOnMention: false,
};

export function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<NotificationPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: NotificationPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

const KEYCLOAK_BASE =
  import.meta.env.VITE_KEYCLOAK_URL || "https://auth.unicorncommander.ai";
const KEYCLOAK_REALM = import.meta.env.VITE_KEYCLOAK_REALM || "uchub";
const ACCOUNT_URL = `${KEYCLOAK_BASE.replace(/\/+$/, "")}/realms/${KEYCLOAK_REALM}/account/`;

export type PaneId = "account" | "appearance" | "notifications" | "help";

const PANES: { id: PaneId; label: string; icon: React.ReactNode }[] = [
  { id: "account", label: "Account", icon: <UserCircle className="h-4 w-4" /> },
  { id: "appearance", label: "Appearance", icon: <Palette className="h-4 w-4" /> },
  { id: "notifications", label: "Notifications", icon: <Bell className="h-4 w-4" /> },
  { id: "help", label: "Help", icon: <BookOpen className="h-4 w-4" /> },
];

export function SettingsModal({ onClose, initialPane = "account" }: SettingsModalProps) {
  const [pane, setPane] = useState<PaneId>(initialPane);
  const panelRef = useModalA11y(true, onClose);

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
        aria-labelledby="settings-title"
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="glass-heavy flex h-[85dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
          <h2
            id="settings-title"
            className="font-display text-base font-semibold text-slate-100"
          >
            Settings
          </h2>
          <button
            onClick={onClose}
            className="focus-ring -m-1 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Pane switcher — a scrollable strip on phones, a rail on desktop.
              Real buttons either way; nothing here depends on hover. */}
          <nav
            aria-label="Settings sections"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 sm:w-44 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r"
          >
            {PANES.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-current={pane === p.id ? "page" : undefined}
                onClick={() => setPane(p.id)}
                className={clsx(
                  "focus-ring flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors sm:w-full",
                  pane === p.id
                    ? "bg-stable-purple/15 font-medium text-slate-100"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                )}
              >
                {p.icon}
                {p.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1">
            {pane === "account" && <AccountPane onClose={onClose} />}
            {pane === "appearance" && (
              <div className="h-full overflow-y-auto p-5">
                <AppearanceSection />
              </div>
            )}
            {pane === "notifications" && <NotificationsPane />}
            {/* Help fills the pane and brings its own header/tabs/search. */}
            {pane === "help" && <HelpCenter />}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AccountPane({ onClose }: { onClose: () => void }) {
  const currentUser = useAppStore((s) => s.currentUser);
  const userIdent = identityFor(currentUser?.id, currentUser?.displayName);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      {currentUser && (
        <div className="mb-5 flex items-center gap-3.5 rounded-xl border border-line bg-surface-2/60 p-3.5">
          <span
            className="inline-flex shrink-0 rounded-full"
            style={{ boxShadow: `0 0 0 2px ${userIdent.ring}` }}
          >
            <Avatar
              name={currentUser.displayName}
              src={currentUser.avatarUrl}
              size="lg"
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-100">
              {currentUser.displayName}
            </p>
            <p className="truncate text-xs text-slate-400">{currentUser.email}</p>
            <p className="mt-1 text-[11px] text-slate-500">
              Your name, email and photo come from your account, not from Stable.
              Edit them at{" "}
              <a
                href={ACCOUNT_URL}
                target="_blank"
                rel="noreferrer"
                className="focus-ring rounded text-stable-purple-light hover:underline"
              >
                UC-1 Hub Account
              </a>
              .
            </p>
          </div>
        </div>
      )}

      <button
        onClick={() => {
          onClose();
          logout();
        }}
        className="focus-ring mt-auto flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 py-2.5 text-sm font-medium text-rose-300 transition hover:border-rose-500/40 hover:bg-rose-500/15 active:scale-[0.98]"
      >
        <LogOut className="h-4 w-4" /> Sign out
      </button>
    </div>
  );
}

function NotificationsPane() {
  // Prefs live in local state so a toggle re-renders in place (the modal stays
  // open); persistence is synchronous to localStorage on every change, which is
  // all consumers read (useGlobalNotifications calls loadPrefs per event).
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs);
  const [showSaved, setShowSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  function set<K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    savePrefs(next);
    // Unobtrusive confirmation — persistence is instant, so no toast, no close.
    setShowSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setShowSaved(false), 1500);
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <section className="mb-5">
        <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          <Bell className="h-3 w-3" /> In Stable
          {showSaved && (
            <span className="animate-fade-in ml-auto flex items-center gap-1 normal-case tracking-normal text-stable-mint">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
        </h3>
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-1/60">
          <Toggle
            label="In-app toast notifications"
            hint="Show a corner pop-up when someone messages or invites you."
            checked={prefs.inAppToasts}
            onChange={(v) => set("inAppToasts", v)}
          />
          <Toggle
            label="Sound cues"
            hint="Soft audio cues for call join/leave and mentions."
            checked={prefs.soundCues}
            onChange={(v) => set("soundCues", v)}
          />
        </div>
        <p className="mt-2 px-1 text-[11px] leading-4 text-slate-500">
          To silence one room without changing anything here, use the bell in
          that room's header. Per-room mute is yours alone and doesn't affect
          anyone else in the room.
        </p>
      </section>

      <BrowserNotificationsSection />

      <MeetingOpsTranscriptSection />

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          <Mail className="h-3 w-3" /> Email
        </h3>
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-1/60">
          <Toggle
            label="Email me when invited to a channel"
            hint="A heads-up email so you don't miss new channels."
            checked={prefs.emailOnInvite}
            onChange={(v) => set("emailOnInvite", v)}
          />
          <Toggle
            label="Email me when @mentioned"
            hint="Not wired up yet — the backend hook doesn't exist, so this is left switched off rather than pretending to work."
            checked={prefs.emailOnMention}
            onChange={(v) => set("emailOnMention", v)}
            disabled
          />
        </div>
      </section>
    </div>
  );
}

/**
 * Default for the per-call "Send to Meeting-Ops" toggle. Session toggle lives
 * on the live transcript panel; this is only the always-by-default seed.
 */
function MeetingOpsTranscriptSection() {
  const [moPrefs, setMoPrefs] = useState<MeetingOpsTranscriptPrefs>(
    loadMeetingOpsPrefs,
  );
  const [moConfigured, setMoConfigured] = useState<boolean | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getMeetingOpsStatus()
      .then((s) => {
        if (live) setMoConfigured(Boolean(s.configured));
      })
      .catch(() => {
        if (live) setMoConfigured(null);
      });
    return () => {
      live = false;
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  function setSendByDefault(value: boolean) {
    const next = { ...moPrefs, sendByDefault: value };
    setMoPrefs(next);
    saveMeetingOpsPrefs(next);
    setShowSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setShowSaved(false), 1500);
  }

  return (
    <section className="mb-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <Captions className="h-3 w-3" /> Call transcripts
        {showSaved && (
          <span className="animate-fade-in ml-auto flex items-center gap-1 normal-case tracking-normal text-stable-mint">
            <Check className="h-3 w-3" /> Saved
          </span>
        )}
      </h3>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-1/60">
        <Toggle
          label="Send call transcripts to Meeting-Ops by default"
          hint={
            moConfigured === false
              ? "On by default for new calls. Meeting-Ops is not fully configured, so exports remain safely blocked in Stable until URL, PAT, and organization are wired."
              : moConfigured === true
                ? "New calls start with “Send to Meeting-Ops” on. You can still flip it per call in the live transcript panel."
                : "New calls start with “Send to Meeting-Ops” on. You can still flip it per call in the live transcript panel."
          }
          checked={moPrefs.sendByDefault}
          onChange={setSendByDefault}
        />
      </div>
    </section>
  );
}

/**
 * Browser (push) notifications.
 *
 * `lib/webpush.ensurePushSubscription` has always existed but nothing ever
 * called it, so no browser was ever registered and web push was silently dead.
 * This is its entry point.
 *
 * Every state below is a fact we can actually check — browser support, the
 * permission the browser reports, and whether the SERVER has a VAPID key. None
 * of them is inferred from another, because "you turned it on" and "it will
 * actually arrive" are different claims and this control used to be the kind
 * that conflates them.
 */
type PushState =
  | "unsupported" // no ServiceWorker / PushManager in this browser
  | "unconfigured" // server has no VAPID key — nothing to subscribe to
  | "denied" // the browser blocked it; only the user can undo that
  | "off" // supported, configured, not yet granted
  | "on" // granted and registered with the backend
  | "checking"
  | "working";

function BrowserNotificationsSection() {
  const [state, setState] = useState<PushState>("checking");
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined";

  // Resolve the true starting state. If permission was already granted we also
  // (idempotently) re-register, which repairs a browser that granted permission
  // back when nothing was listening.
  useEffect(() => {
    let live = true;
    if (!supported) {
      setState("unsupported");
      return;
    }
    (async () => {
      try {
        const key = await api.getVapidPublicKey();
        if (!live) return;
        if (!key) {
          setState("unconfigured");
          return;
        }
        if (Notification.permission === "denied") {
          setState("denied");
          return;
        }
        if (Notification.permission === "granted") {
          await ensurePushSubscription();
          if (live) setState("on");
          return;
        }
        setState("off");
      } catch {
        // Could not ask the server. Offer the control rather than hiding it —
        // an over-eager "unavailable" is its own lie.
        if (live) setState("off");
      }
    })();
    return () => {
      live = false;
    };
  }, [supported]);

  const enable = useCallback(async () => {
    setError(null);
    setState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setState("denied");
        return;
      }
      if (permission !== "granted") {
        setState("off");
        return;
      }
      await ensurePushSubscription();
      setState("on");
    } catch {
      setState("off");
      setError("Couldn't register this browser. Try again.");
    }
  }, []);

  const body: Record<PushState, { text: string; action?: React.ReactNode }> = {
    checking: { text: "Checking…" },
    unsupported: {
      text: "This browser can't receive push notifications.",
    },
    unconfigured: {
      text: "Push isn't configured on this server, so there's nothing to turn on.",
    },
    denied: {
      text: "Blocked. Your browser is refusing notifications for this site — only you can change that, in your browser's site settings.",
    },
    off: {
      text: "Get notified when Stable isn't the tab you're looking at.",
      action: (
        <button
          type="button"
          onClick={() => void enable()}
          className="focus-ring shrink-0 rounded-lg bg-stable-purple/20 px-3 py-1.5 text-xs font-medium text-stable-purple-light transition hover:bg-stable-purple/30"
        >
          Enable
        </button>
      ),
    },
    working: { text: "Waiting for your browser…" },
    on: {
      text: "This browser is registered. Turn it off from your browser's site settings.",
    },
  };

  const current = body[state];

  return (
    <section className="mb-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <BellRing className="h-3 w-3" /> Browser notifications
        {state === "on" && (
          <Tooltip
            content="Granted by your browser and registered with this server."
            placement="top"
          >
            {/* Focusable so the tooltip is not mouse-only — see Tooltip. */}
            <span
              tabIndex={0}
              className="focus-ring ml-auto flex cursor-help items-center gap-1 rounded normal-case tracking-normal text-stable-mint"
            >
              <Check className="h-3 w-3" /> On
            </span>
          </Tooltip>
        )}
      </h3>
      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-1/60 px-3.5 py-3">
        <p className="min-w-0 flex-1 text-xs leading-5 text-slate-400">
          {current.text}
          {error && <span className="mt-1 block text-amber-400/90">{error}</span>}
        </p>
        {current.action}
      </div>
    </section>
  );
}

interface ToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  icon?: React.ReactNode;
  disabled?: boolean;
}

function Toggle({ label, hint, checked, onChange, icon, disabled }: ToggleProps) {
  return (
    <label
      className={clsx(
        "flex items-start gap-3 px-3.5 py-3 transition-colors",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-white/[0.03]",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled}
        className="focus-ring mt-1 h-4 w-4 cursor-pointer rounded accent-stable-purple"
      />
      <div className="flex-1">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-sm text-slate-200">{label}</span>
        </div>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
    </label>
  );
}
