/**
 * Appearance settings — light/dark mode AND palette, the two theme axes.
 *
 * Rendered by Layout/SettingsModal.tsx, which it replaced the inline
 * "Appearance" section of. Mode is applied through lib/theme (data-theme);
 * palette through stores/themeStore (data-palette).
 *
 * This component does NOT own palette boot-up. Binding the store to the
 * signed-in user happens in AppShell, because a preference that only loads
 * when you open the settings modal has not actually been restored.
 *
 * It also renders AvatarSection ("Your picture") ahead of the appearance
 * controls. That is a wiring compromise, not a claim that a profile picture is
 * an appearance setting: SettingsModal owns the section list and was being
 * edited concurrently, and a settings pane the user cannot reach is not a
 * shipped feature. Moving `<AvatarSection />` up into SettingsModal (likely as
 * its own "Profile" block above Appearance) is a two-line change and should
 * happen — see the handoff notes.
 */
import { useState } from "react";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { applyTheme, getStoredTheme, resolveTheme, type ThemeChoice } from "@/lib/theme";
import { PALETTES, useThemeStore, type PaletteId } from "@/stores/themeStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { AvatarSection } from "@/components/Settings/AvatarSection";

export function AppearanceSection() {
  const [mode, setMode] = useState<ThemeChoice>(getStoredTheme);
  const palette = useThemeStore((s) => s.palette);
  const setPalette = useThemeStore((s) => s.setPalette);

  // Which swatch row to preview depends on the *resolved* mode, so "System"
  // shows what the OS will actually give you.
  const resolved = resolveTheme(mode);

  return (
    <>
    <AvatarSection />
    <section className="mb-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <Sun className="h-3 w-3" /> Appearance
      </h3>

      <div className="rounded-xl border border-line bg-surface-1/60 p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-slate-200">Mode</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Light, dark, or match your system.
            </p>
          </div>
          <ModeSegment
            value={mode}
            onChange={(v) => {
              setMode(v);
              applyTheme(v);
            }}
          />
        </div>
      </div>

      <div className="mt-2.5 rounded-xl border border-line bg-surface-1/60 p-3.5">
        <div className="mb-3 min-w-0">
          <p className="flex items-center gap-1.5 text-sm text-slate-200">
            <Palette className="h-3.5 w-3.5 text-slate-500" /> Palette
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Each palette gives sections and item types their own colour, so
            channels, DMs, agents and calls stay easy to tell apart. Every
            palette works in both light and dark.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Colour palette"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {PALETTES.map((p) => (
            <PaletteCard
              key={p.id}
              id={p.id}
              name={p.name}
              blurb={p.blurb}
              swatches={resolved === "light" ? p.preview.light : p.preview.dark}
              active={palette === p.id}
              onSelect={setPalette}
            />
          ))}
        </div>
      </div>

      <div className="mt-2.5 rounded-xl border border-line bg-surface-1/60 p-3.5">
        <p className="text-sm text-slate-200">Section preview</p>
        <p className="mt-0.5 mb-3 text-xs text-slate-500">
          How the palette separates each region of the app.
        </p>
        <SectionPreview />
      </div>

      {/* Legend — doubles as a live preview of the item-type colours in the
          selected palette, and as the reference for what each hue means. */}
      <div className="mt-2.5 rounded-xl border border-line bg-surface-1/60 p-3.5">
        <p className="text-sm text-slate-200">What the colours mean</p>
        <p className="mt-0.5 mb-3 text-xs text-slate-500">
          These update live with the palette above.
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          <LegendItem className="text-item-channel" label="Channel" />
          <LegendItem className="text-item-dm" label="Direct message" />
          <LegendItem className="text-item-group" label="Group" />
          <LegendItem className="text-item-agent" label="Agent" />
          <LegendItem className="text-item-mention" label="Mention" />
          <LegendItem className="text-item-unread" label="Unread" />
          <LegendItem className="text-item-system" label="System" />
        </ul>
      </div>
    </section>
    </>
  );
}

/**
 * Miniature of the app shell, built from the real `section-*` / `edge-*`
 * utilities and the live palette tokens — so it is a true preview, not a
 * hand-painted mock that can drift from the theme.
 *
 * Decorative: the whole figure is aria-hidden and the meanings are given as
 * text in the legend below, so nothing here is information conveyed by colour
 * alone.
 */
function SectionPreview() {
  return (
    <div
      aria-hidden="true"
      className="flex h-24 overflow-hidden rounded-lg border border-line bg-surface-0 text-[9px] font-medium"
    >
      <div className="section-nav edge-nav flex w-12 shrink-0 flex-col gap-1 p-1.5 text-slate-400">
        <span className="text-item-channel">#general</span>
        <span className="text-item-dm">@ana</span>
        <span className="text-item-agent">agent</span>
      </div>

      <div className="section-conv flex min-w-0 flex-1 flex-col">
        <div className="section-call edge-call shrink-0 px-2 py-1 text-slate-400">
          call
        </div>
        <div className="flex-1 px-2 py-1 text-slate-500">conversation</div>
        <div className="section-composer edge-composer shrink-0 px-2 py-1 text-slate-400">
          composer
        </div>
      </div>

      <div className="section-canvas w-10 shrink-0 border-l border-line p-1.5 text-slate-400">
        canvas
      </div>
      <div className="section-agents edge-agents w-12 shrink-0 p-1.5 text-slate-400">
        agents
      </div>
    </div>
  );
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5 text-xs text-slate-400">
      <span
        aria-hidden="true"
        className={`h-2.5 w-2.5 shrink-0 rounded-full bg-current ${className}`}
      />
      {label}
    </li>
  );
}

interface PaletteCardProps {
  id: PaletteId;
  name: string;
  blurb: string;
  swatches: string[];
  active: boolean;
  onSelect: (id: PaletteId) => void;
}

function PaletteCard({
  id,
  name,
  blurb,
  swatches,
  active,
  onSelect,
}: PaletteCardProps) {
  return (
    <Tooltip content={blurb} placement="top">
      <button
        role="radio"
        aria-checked={active}
        onClick={() => onSelect(id)}
        className={`focus-ring flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors ${
          active
            ? "border-stable-purple/60 bg-stable-purple/10"
            : "border-line bg-surface-2/50 hover:border-line-strong"
        }`}
      >
        {/* Swatch strip is decorative — the name is the accessible label, and
            the meaning of each colour is in the legend below, so this carries
            no information that is only available as colour. */}
        <span aria-hidden="true" className="flex shrink-0 gap-0.5">
          {swatches.map((c, i) => (
            <span
              key={i}
              className="h-6 w-2.5 rounded-[3px] border border-line"
              style={{ backgroundColor: c }}
            />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-slate-100">
            {name}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-slate-500">
            {blurb}
          </span>
        </span>
        {active && (
          <Check
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-stable-purple-light"
          />
        )}
      </button>
    </Tooltip>
  );
}

interface ModeSegmentProps {
  value: ThemeChoice;
  onChange: (v: ThemeChoice) => void;
}

function ModeSegment({ value, onChange }: ModeSegmentProps) {
  const opts: {
    key: ThemeChoice;
    label: string;
    hint: string;
    icon: React.ReactNode;
  }[] = [
    {
      key: "light",
      label: "Light",
      hint: "Always light",
      icon: <Sun className="h-3.5 w-3.5" />,
    },
    {
      key: "dark",
      label: "Dark",
      hint: "Always dark",
      icon: <Moon className="h-3.5 w-3.5" />,
    },
    {
      key: "system",
      label: "System",
      hint: "Follow your OS setting",
      icon: <Monitor className="h-3.5 w-3.5" />,
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className="inline-flex shrink-0 rounded-lg border border-line bg-surface-2/60 p-0.5"
    >
      {opts.map((o) => {
        const active = value === o.key;
        return (
          <Tooltip key={o.key} content={o.hint} placement="top">
            <button
              role="radio"
              aria-checked={active}
              aria-label={o.label}
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
          </Tooltip>
        );
      })}
    </div>
  );
}

export default AppearanceSection;
