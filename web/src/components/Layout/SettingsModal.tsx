import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Bell, Check, LogOut, Mail, Monitor, Moon, Sun, X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { Avatar } from "@/components/Avatar";
import { identityFor } from "@/lib/identity";
import { logout } from "@/services/auth";
import { useModalA11y } from "@/hooks/useModalA11y";
import { applyTheme, getStoredTheme, type ThemeChoice } from "@/lib/theme";

interface SettingsModalProps {
  onClose: () => void;
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

export function SettingsModal({ onClose }: SettingsModalProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  // Identity hue for the signed-in resident — rings the profile avatar.
  const userIdent = identityFor(currentUser?.id, currentUser?.displayName);
  // Prefs live in local state so a toggle re-renders in place (the modal stays
  // open); persistence is synchronous to localStorage on every change, which
  // is all consumers read (useGlobalNotifications calls loadPrefs per event).
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs);
  // Theme choice — applyTheme() persists to localStorage + stamps
  // document.documentElement.dataset.theme (and the system listener lives
  // in lib/theme, started from main.tsx).
  const [theme, setThemeState] = useState<ThemeChoice>(getStoredTheme);
  const [showSaved, setShowSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Esc-to-close, focus trap + restore — shared modal a11y (the panel-scoped
  // Esc also keeps a stacked QuickSwitcher's Esc from closing settings too).
  const panelRef = useModalA11y(true, onClose);

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
        className="glass-heavy w-full max-w-lg overflow-hidden rounded-2xl shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
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

        <div className="p-5">
        {/* Profile */}
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
              <p className="truncate text-xs text-slate-400">
                {currentUser.email}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Edit your profile + photo at{" "}
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

        {/* Appearance */}
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            <Sun className="h-3 w-3" /> Appearance
          </h3>
          <div className="rounded-xl border border-line bg-surface-1/60 p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-slate-200">Theme</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Light, dark, or match your system.
                </p>
              </div>
              <ThemeSegment
                value={theme}
                onChange={(v) => {
                  setThemeState(v);
                  applyTheme(v);
                }}
              />
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            <Bell className="h-3 w-3" /> Notifications
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
            <Toggle
              label="Email me when invited to a channel"
              hint="A heads-up email so you don't miss new channels."
              checked={prefs.emailOnInvite}
              onChange={(v) => set("emailOnInvite", v)}
              icon={<Mail className="h-3.5 w-3.5 text-slate-500" />}
            />
            <Toggle
              label="Email me when @mentioned"
              hint="Coming soon — backend hook pending."
              checked={prefs.emailOnMention}
              onChange={(v) => set("emailOnMention", v)}
              icon={<Mail className="h-3.5 w-3.5 text-slate-500" />}
              disabled
            />
          </div>
        </section>

        {/* Sign out */}
        <button
          onClick={() => {
            onClose();
            logout();
          }}
          className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 py-2.5 text-sm font-medium text-rose-300 transition hover:border-rose-500/40 hover:bg-rose-500/15 active:scale-[0.98]"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
        </div>
      </motion.div>
    </motion.div>
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
      className={`flex items-start gap-3 px-3.5 py-3 transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-white/[0.03]"
      }`}
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

interface ThemeSegmentProps {
  value: ThemeChoice;
  onChange: (v: ThemeChoice) => void;
}

function ThemeSegment({ value, onChange }: ThemeSegmentProps) {
  const opts: { key: ThemeChoice; label: string; icon: React.ReactNode }[] = [
    { key: "light", label: "Light", icon: <Sun className="h-3.5 w-3.5" /> },
    { key: "dark", label: "Dark", icon: <Moon className="h-3.5 w-3.5" /> },
    { key: "system", label: "System", icon: <Monitor className="h-3.5 w-3.5" /> },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex shrink-0 rounded-lg border border-line bg-surface-2/60 p-0.5"
    >
      {opts.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => onChange(o.key)}
            className={`focus-ring flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-stable-purple/20 text-stable-purple-light"
                : "text-slate-400 hover:text-slate-100"
            }`}
          >
            {o.icon}
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
