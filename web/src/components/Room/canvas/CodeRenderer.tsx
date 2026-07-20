import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { Save, RotateCcw, AlertTriangle } from "lucide-react";
import { languageExtension } from "./codeLanguage";

/**
 * Editable code artifact renderer (CodeMirror 6 via @uiw/react-codemirror).
 *
 * Whole-buffer editing: edits stay local until the user hits Save, which calls
 * the parent's onSave (→ POST /artifacts/{id}/rewrite). The `language` from the
 * artifact selects the grammar (lazy-loaded). Read-only when viewing a historic
 * version (the version toolbar) or when the parent says so.
 *
 * ## Never clobber unsaved typing
 *
 * `content` is not a static prop — it is HEAD, and HEAD now moves underneath us
 * live: another member or an agent rewriting this artifact reaches the canvas
 * store over the room socket, which re-fetches and pushes new `content` down.
 * The naive `useEffect(() => setValue(content), [content])` would silently
 * destroy whatever the user had typed but not saved.
 *
 * So the buffer tracks the revision it was FORKED FROM (`base`):
 *   - buffer clean (`value === base`)  → adopt the incoming content silently.
 *   - buffer already equals the incoming content (the usual post-Save refresh)
 *     → nothing to show, just re-baseline.
 *   - buffer dirty and incoming differs → keep the user's text, raise a
 *     non-destructive banner and let THEM choose.
 *
 * Lazy-loaded by CanvasRenderer so CodeMirror stays out of the main bundle.
 */
interface CodeRendererProps {
  content: string;
  language: string | null;
  /** When true the editor is read-only (e.g. viewing a past version). */
  readOnly?: boolean;
  /** Persist the buffer (rewrite). Throws on failure; we surface the message. */
  onSave?: (content: string) => Promise<void>;
}

export default function CodeRenderer({
  content,
  language,
  readOnly,
  onSave,
}: CodeRendererProps) {
  const [value, setValue] = useState(content);
  /**
   * The revision this buffer was forked from. `value !== base` ⇒ unsaved local
   * edits. Distinct from `content`, which is live HEAD and can move remotely.
   */
  const [base, setBase] = useState(content);
  /**
   * A remote revision that arrived while the buffer was dirty. Held aside
   * (never applied automatically) and offered to the user in the banner.
   */
  const [incoming, setIncoming] = useState<string | null>(null);
  const [langExt, setLangExt] = useState<Extension>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reconcile the buffer with the source content (new version loaded, artifact
  // switched, version-preview toggled, OR a remote edit landing live).
  // Adopting is only safe when there is nothing of the user's to lose.
  useEffect(() => {
    // Nothing new relative to what we forked from.
    if (content === base) return;
    if (value === base || value === content) {
      // Clean buffer, or the buffer already matches what came back (the
      // post-Save refresh) — adopt and re-baseline.
      setValue(content);
      setBase(content);
      setIncoming(null);
      setError(null);
      return;
    }
    // Dirty buffer + a genuinely different revision: keep the user's work.
    setIncoming(content);
  }, [content, base, value]);

  /** Discard local edits and take the revision that landed. */
  function acceptIncoming() {
    if (incoming === null) return;
    setValue(incoming);
    setBase(incoming);
    setIncoming(null);
    setError(null);
  }

  /**
   * Keep editing on top of the remote revision. Re-baselining means Save will
   * write the user's buffer over it — nothing is lost either way, since the
   * remote revision is already its own entry in the version history.
   */
  function dismissIncoming() {
    if (incoming === null) return;
    setBase(incoming);
    setIncoming(null);
  }

  // Resolve the language grammar (async import) when the language changes.
  useEffect(() => {
    let active = true;
    languageExtension(language)
      .then((ext) => {
        if (active) setLangExt(ext);
      })
      .catch(() => {
        if (active) setLangExt([]);
      });
    return () => {
      active = false;
    };
  }, [language]);

  // Dirty relative to the revision we forked from — NOT to live HEAD, which a
  // remote edit can move without the user having touched anything.
  const dirty = value !== base;

  async function handleSave() {
    if (!onSave || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
    } catch (e) {
      const apiErr = e as { detail?: string | null; message?: string };
      setError(
        apiErr?.detail ||
          apiErr?.message ||
          (e instanceof Error ? e.message : "Save failed"),
      );
    } finally {
      setSaving(false);
    }
  }

  const extensions: Extension[] = [
    langExt,
    EditorView.lineWrapping,
    EditorView.theme({
      "&": { fontSize: "13px", backgroundColor: "transparent" },
      ".cm-gutters": { backgroundColor: "transparent", border: "none" },
    }),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Remote revision landed while this buffer had unsaved edits. We show it
          instead of applying it — the user decides. */}
      {incoming !== null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            This artifact was updated elsewhere. Your unsaved edits were kept.
          </span>
          <button
            onClick={acceptIncoming}
            className="rounded px-2 py-0.5 font-medium text-amber-100 hover:bg-amber-500/20"
          >
            Load update (discard mine)
          </button>
          <button
            onClick={dismissIncoming}
            className="rounded px-2 py-0.5 text-amber-200/80 hover:bg-amber-500/20"
          >
            Keep mine
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          value={value}
          onChange={(v) => setValue(v)}
          theme={oneDark}
          extensions={extensions}
          editable={!readOnly}
          readOnly={!!readOnly}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: !readOnly,
            foldGutter: true,
          }}
          height="100%"
          style={{ height: "100%" }}
        />
      </div>

      {/* Save bar — only when this surface is editable (HEAD + onSave provided). */}
      {!readOnly && onSave && (
        <div className="flex shrink-0 items-center gap-2 border-t border-slate-700/50 bg-slate-900/80 px-3 py-1.5">
          {error && (
            <span className="truncate text-xs text-rose-300" title={error}>
              {error}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {dirty && (
              <button
                onClick={() => {
                  // Back to the revision we forked from. If a remote update is
                  // pending, the reconcile effect then adopts it (the buffer is
                  // clean again), which is exactly what "revert" should mean.
                  setValue(base);
                  setError(null);
                }}
                disabled={saving}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" />
                Revert
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="flex items-center gap-1 rounded bg-stable-purple px-2.5 py-1 text-xs font-medium text-white hover:bg-stable-purple-light disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              {saving ? "Saving…" : dirty ? "Save version" : "Saved"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
