import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { Save, RotateCcw } from "lucide-react";
import { languageExtension } from "./codeLanguage";

/**
 * Editable code artifact renderer (CodeMirror 6 via @uiw/react-codemirror).
 *
 * Whole-buffer editing: edits stay local until the user hits Save, which calls
 * the parent's onSave (→ POST /artifacts/{id}/rewrite). The `language` from the
 * artifact selects the grammar (lazy-loaded). Read-only when viewing a historic
 * version (the version toolbar) or when the parent says so.
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
  const [langExt, setLangExt] = useState<Extension>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the buffer whenever the source content changes (new version loaded,
  // artifact switched, or version-preview toggled).
  useEffect(() => {
    setValue(content);
    setError(null);
  }, [content]);

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

  const dirty = value !== content;

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
                  setValue(content);
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
