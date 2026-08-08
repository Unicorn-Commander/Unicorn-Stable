/**
 * Parse a search query string with operator support into structured query + operators.
 *
 * Supported operators (client-side parsing, passed to backend as params):
 *   from:@name     — messages from a specific sender
 *   in:#channel     — messages in a specific channel
 *   has:file/image/link — messages with attachments
 *   before:YYYY-MM-DD — messages before date
 *   after:YYYY-MM-DD  — messages after date
 *
 * Operators are stripped from the free-text query that the backend receives.
 */

export interface ParsedSearchQuery {
  query: string;
  operators: {
    from?: string;
    in?: string;
    has?: string;
    before?: string;
    after?: string;
  };
}

const OPERATOR_RE = /\b(from|in|has|before|after):(@?[^\s]+)/gi;

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const operators: ParsedSearchQuery["operators"] = {};
  const query = raw
    .replace(OPERATOR_RE, (_match, op: string, val: string) => {
      const key = op.toLowerCase();
      if (key === "from") operators.from = val;
      else if (key === "in") operators.in = val;
      else if (key === "has") operators.has = val;
      else if (key === "before") operators.before = val;
      else if (key === "after") operators.after = val;
      return "";
    })
    // Collapse the hole an extracted operator leaves behind, so
    // "hello from:alice world" searches for "hello world", not "hello  world".
    .replace(/\s+/g, " ")
    .trim();

  return { query, operators };
}

/**
 * Remove one `key:value` operator token from a raw query string (chip “x”).
 * Values are regex-escaped — `from:j.doe` must not eat `from:jXdoe` — and the
 * token is matched only at whitespace boundaries so free text stays intact.
 */
export function removeOperatorToken(
  raw: string,
  key: string,
  value: string,
): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw
    .replace(new RegExp(`(^|\\s)${esc(key)}:${esc(value)}(?=\\s|$)`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}
