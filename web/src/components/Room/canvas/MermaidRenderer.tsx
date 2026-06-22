import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";
import DOMPurify from "dompurify";

/**
 * Mermaid diagram artifact renderer.
 *
 * SECURITY: AI-generated diagram source is untrusted, and Mermaid has a history
 * of XSS via labels/links (several CVEs). We therefore:
 *   1. initialize with `securityLevel: 'strict'` — Mermaid strips HTML in
 *      labels and disables click→script/href interactions, and
 *   2. run the SVG string Mermaid produces through DOMPurify before it ever
 *      touches the DOM (belt-and-braces; never `securityLevel: 'loose'`).
 *
 * Lazy-loaded by CanvasRenderer (mermaid is large). A parse error renders the
 * source as a fallback rather than throwing.
 */
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark",
});

export default function MermaidRenderer({ content }: { content: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reactId = useId();
  // mermaid.render needs a DOM-id-safe string (no colons from useId).
  const renderId = useRef(`mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`);

  useEffect(() => {
    let active = true;
    setError(null);
    setSvg(null);
    const src = content.trim();
    if (!src) {
      setError("Empty diagram");
      return;
    }
    mermaid
      .render(renderId.current, src)
      .then(({ svg: out }) => {
        if (!active) return;
        // DOMPurify the produced SVG. Allow SVG/MathML profiles so the diagram
        // survives, but strip any scriptable surface.
        const clean = DOMPurify.sanitize(out, {
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
          ADD_TAGS: ["foreignObject"],
        });
        setSvg(clean);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Failed to render diagram");
      });
    return () => {
      active = false;
    };
  }, [content]);

  if (error) {
    return (
      <div className="px-4 py-3">
        <p className="mb-2 text-xs text-amber-300">
          Couldn't render diagram: {error}. Showing source.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-950/80 p-3 text-xs text-slate-300">
          {content}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-500">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 items-center justify-center overflow-auto p-4 [&_svg]:max-w-full"
      // svg is DOMPurify-sanitized above.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
