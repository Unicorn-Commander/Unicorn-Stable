/**
 * Sandboxed HTML / SVG artifact renderer.
 *
 * AI-/user-authored HTML is fully untrusted, so it renders inside an iframe with
 * `sandbox="allow-scripts"` and NOTHING ELSE. Critically we never add
 * `allow-same-origin`: combining `allow-scripts` + `allow-same-origin` would let
 * the framed document reach back into THIS origin (cookies, the auth token in
 * localStorage, the parent DOM) and defeats the sandbox. With allow-scripts
 * alone the frame is a unique opaque origin — scripts run but can't touch us.
 *
 * `srcDoc` carries the content so nothing hits the network/an origin. SVG is
 * rendered the same way (it can contain scripts too), wrapped in a minimal HTML
 * shell so it lays out sensibly.
 */
interface HtmlRendererProps {
  content: string;
  /** "svg" wraps the markup in an HTML shell; "html" uses it as the document. */
  mode: "html" | "svg";
}

const SVG_SHELL = (svg: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#fff;display:flex;align-items:center;justify-content:center;}
  svg{max-width:100%;max-height:100%;}
</style></head><body>${svg}</body></html>`;

export default function HtmlRenderer({ content, mode }: HtmlRendererProps) {
  const srcDoc = mode === "svg" ? SVG_SHELL(content) : content;
  return (
    <div className="h-full min-h-0 bg-white">
      <iframe
        // SECURITY: allow-scripts ONLY. Never add allow-same-origin here.
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title="Artifact preview"
        className="h-full w-full border-0 bg-white"
        // referrerpolicy + no allow-popups: keep the frame inert beyond rendering.
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
