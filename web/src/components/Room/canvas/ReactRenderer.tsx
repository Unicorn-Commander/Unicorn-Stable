import { useState } from "react";
import { Code2, Eye } from "lucide-react";
import CodeRenderer from "./CodeRenderer";

/**
 * React component artifact renderer.
 *
 * v1 approach: render the component inside the SAME hardened sandbox the HTML
 * renderer uses (`sandbox="allow-scripts"`, never `allow-same-origin`), with
 * React + Babel-standalone loaded from a CDN INSIDE the frame and the source
 * transpiled there. Because the frame is a unique opaque origin it can run
 * scripts but cannot reach this origin's cookies/token/DOM.
 *
 * The artifact's source is expected to either export default a component or
 * define a component named `App` (the harness renders whichever it finds). If
 * the CDN is unreachable or the code throws, the in-frame harness shows the
 * error; a toggle also lets the user flip to the read-only source (CodeMirror).
 *
 * NOTE (deferred): this is a best-effort preview, not a full bundler — no npm
 * imports, no multi-file. Those are a later track; the source view is always
 * available as the reliable fallback.
 */
function buildReactDoc(source: string): string {
  // The user source is injected into a <script type="text/babel">. We do not
  // string-escape it (Babel parses raw JSX); the sandbox is the containment.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html,body{margin:0;background:#fff;font-family:ui-sans-serif,system-ui,sans-serif;color:#111;}
  #root{padding:12px;}
  #err{white-space:pre-wrap;color:#b91c1c;font:12px/1.5 ui-monospace,monospace;padding:12px;}
</style>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
<div id="root"></div>
<div id="err"></div>
<script>
  window.addEventListener('error', function (e) {
    document.getElementById('err').textContent = 'Error: ' + (e.message || e.error);
  });
</script>
<script type="text/babel" data-presets="react">
  try {
    ${source}
    const __Comp =
      (typeof App !== 'undefined' && App) ||
      (typeof Component !== 'undefined' && Component) ||
      (typeof exports !== 'undefined' && exports.default) ||
      null;
    if (!__Comp) {
      document.getElementById('err').textContent =
        'No component found. Define a component named "App" (or "Component").';
    } else {
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(__Comp));
    }
  } catch (err) {
    document.getElementById('err').textContent = 'Error: ' + (err && err.message ? err.message : err);
  }
</script>
</body>
</html>`;
}

export default function ReactRenderer({
  content,
  language,
}: {
  content: string;
  language: string | null;
}) {
  const [showSource, setShowSource] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-700/50 bg-slate-900/60 px-3 py-1.5">
        <span className="text-[11px] text-slate-500">
          {showSource
            ? "Source (read-only)"
            : "Live preview — sandboxed (allow-scripts only)"}
        </span>
        <button
          onClick={() => setShowSource((v) => !v)}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          {showSource ? (
            <>
              <Eye className="h-3 w-3" /> Preview
            </>
          ) : (
            <>
              <Code2 className="h-3 w-3" /> Source
            </>
          )}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {showSource ? (
          <CodeRenderer
            content={content}
            language={language ?? "jsx"}
            readOnly
          />
        ) : (
          <iframe
            // SECURITY: allow-scripts ONLY (unique opaque origin). The CDN React
            // + Babel load fine cross-origin; the frame can't reach our origin.
            sandbox="allow-scripts"
            srcDoc={buildReactDoc(content)}
            title="React component preview"
            className="h-full w-full border-0 bg-white"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  );
}
