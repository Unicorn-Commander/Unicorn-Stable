import { Suspense, lazy } from "react";
import type { ArtifactKind } from "@/types/artifact";

/**
 * Renderer dispatcher: picks a renderer by artifact `kind`. The heavy ones
 * (markdown stack, CodeMirror, mermaid, the React preview) are React.lazy'd so
 * they stay out of the main bundle and only load when an artifact of that kind
 * is opened.
 */
const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));
const CodeRenderer = lazy(() => import("./CodeRenderer"));
const HtmlRenderer = lazy(() => import("./HtmlRenderer"));
const MermaidRenderer = lazy(() => import("./MermaidRenderer"));
const ReactRenderer = lazy(() => import("./ReactRenderer"));
const SheetRenderer = lazy(() => import("./SheetRenderer"));

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-slate-500">
      Loading…
    </div>
  );
}

interface CanvasRendererProps {
  kind: ArtifactKind;
  content: string;
  language: string | null;
  /** Read-only when viewing a historic version (or when no save handler given). */
  readOnly?: boolean;
  /** Persist a whole-buffer rewrite (code/markdown editors). */
  onSave?: (content: string) => Promise<void>;
}

export function CanvasRenderer({
  kind,
  content,
  language,
  readOnly,
  onSave,
}: CanvasRendererProps) {
  return (
    <Suspense fallback={<Loading />}>
      {kind === "markdown" && <MarkdownRenderer content={content} />}
      {kind === "code" && (
        <CodeRenderer
          content={content}
          language={language}
          readOnly={readOnly}
          onSave={onSave}
        />
      )}
      {kind === "html" && <HtmlRenderer content={content} mode="html" />}
      {kind === "svg" && <HtmlRenderer content={content} mode="svg" />}
      {kind === "mermaid" && <MermaidRenderer content={content} />}
      {kind === "react" && (
        <ReactRenderer content={content} language={language} />
      )}
      {kind === "sheet" && <SheetRenderer content={content} />}
    </Suspense>
  );
}
