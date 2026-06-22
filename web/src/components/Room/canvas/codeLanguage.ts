import type { Extension } from "@codemirror/state";

/**
 * Map an artifact's `language` string to a CodeMirror 6 language extension.
 * Returns `[]` (no language) for unknown / absent languages so the editor still
 * renders as plain text. Each lang module is imported lazily inside this async
 * function so a code artifact only pulls the one grammar it needs.
 */
export async function languageExtension(
  language: string | null | undefined,
): Promise<Extension> {
  const lang = (language ?? "").toLowerCase().trim();
  switch (lang) {
    case "js":
    case "javascript":
    case "mjs":
    case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
      });
    case "ts":
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
      });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: true,
      });
    case "py":
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "html":
    case "htm":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "md":
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "rs":
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "c":
    case "cpp":
    case "c++":
    case "h":
    case "hpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "yaml":
    case "yml":
      return (await import("@codemirror/lang-yaml")).yaml();
    default:
      return [];
  }
}
