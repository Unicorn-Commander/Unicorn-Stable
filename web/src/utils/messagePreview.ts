/**
 * Flatten a message's markdown to the plain text a one-line preview can show.
 *
 * Sidebar rows and Home cards render previews into text-only slots, so markup
 * has to be RESOLVED, not displayed: `**Done**` should preview as "Done", a
 * link should keep its text (that's where the meaning lives), a code fence
 * should keep its code. Dropping the markup wholesale would eat words;
 * leaving it raw fills the sidebar with asterisks.
 *
 * Regex-based on purpose — this runs per room row on every rooms payload, and
 * a preview that imperfectly flattens exotic nesting is still strictly better
 * than raw markup. It is NOT a sanitizer and must never feed innerHTML.
 */
export function stripMarkdown(content: string): string {
  let s = content;
  // Fence lines: drop ``` and its info string, keep the code between fences.
  s = s.replace(/^```[^\n]*$/gm, "");
  // Images before links so ![alt](url) doesn't half-match the link rule.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Emphasis, strongest marker first; run twice so ***both*** fully unwraps.
  for (let pass = 0; pass < 2; pass++) {
    s = s.replace(/(\*\*\*|___|\*\*|__|~~)([^\n]+?)\1/g, "$2");
  }
  // Single-marker emphasis only when it wraps like a word, so math ("2*3*4")
  // and snake_case identifiers survive.
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1$2");
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Line-leading structure: headings, blockquotes, list markers.
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^>\s?/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  return s;
}
