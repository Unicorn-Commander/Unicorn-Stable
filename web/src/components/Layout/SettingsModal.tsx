import { useEffect } from "react";
import { motion } from "framer-motion";
import { Bell, LogOut, Mail, X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { Avatar } from "@/components/Avatar";
import { logout } from "@/services/auth";

interface SettingsModalProps {
  onClose: () => void;
}

const PREFS_KEY = "stable.notification.prefs.v1";

interface NotificationPrefs {
  inAppToasts: boolean;
  emailOnInvite: boolean;
  emailOnMention: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = {
  inAppToasts: true,
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
  const prefs = loadPrefs();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set<K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) {
    savePrefs({ ...prefs, [key]: value });
    // Force re-render via state shake — settings only saved to localStorage
    onClose();
    setTimeout(() => useAppStore.getState().pushToast({ title: "Settings saved" }), 50);
  }

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
        className="w-full max-w-lg rounded-xl border border-slate-700/50 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-base font-semibold text-slate-100">Settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Profile */}
        {currentUser && (
          <div className="mb-5 flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
            <Avatar
              name={currentUser.displayName}
              src={currentUser.avatarUrl}
              size="lg"
            />
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
                  className="text-stable-purple hover:underline"
                >
                  UC-1 Hub Account
                </a>
                .
              </p>
            </div>
          </div>
        )}

        {/* Notifications */}
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Bell className="h-3 w-3" /> Notifications
          </h3>
          <div className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            <Toggle
              label="In-app toast notifications"
              hint="Show a corner pop-up when someone messages or invites you."
              checked={prefs.inAppToasts}
              onChange={(v) => set("inAppToasts", v)}
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
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800/50 py-2 text-sm text-slate-300 hover:bg-slate-800"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
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
      className={`flex items-start gap-3 px-3 py-2.5 ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled}
        className="mt-1 h-4 w-4 cursor-pointer accent-stable-purple"
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
