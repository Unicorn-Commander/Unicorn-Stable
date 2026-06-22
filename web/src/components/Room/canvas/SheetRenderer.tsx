/**
 * Simple read-only sheet renderer (v1). Parses the artifact content as either
 * JSON (an array of objects, or an array of arrays) or CSV, and renders a table.
 * Editing / formulas are deferred (a later track); this is a clean viewer.
 */

interface Parsed {
  headers: string[];
  rows: string[][];
}

/** Minimal RFC-4180-ish CSV parser: quotes, escaped quotes, embedded newlines. */
function parseCsv(text: string): Parsed {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // Treat \r\n as one break; swallow a following \n after \r.
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Flush trailing field/row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  const headers = nonEmpty[0] ?? [];
  return { headers, rows: nonEmpty.slice(1) };
}

function parseJson(text: string): Parsed | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;

  // Array of arrays → first row is the header.
  if (Array.isArray(data[0])) {
    const arr = data as unknown[][];
    const headers = (arr[0] ?? []).map((c) => String(c));
    const rows = arr.slice(1).map((r) => r.map((c) => String(c ?? "")));
    return { headers, rows };
  }

  // Array of objects → union of keys is the header.
  if (typeof data[0] === "object" && data[0] !== null) {
    const objs = data as Array<Record<string, unknown>>;
    const headerSet = new Set<string>();
    objs.forEach((o) => Object.keys(o).forEach((k) => headerSet.add(k)));
    const headers = Array.from(headerSet);
    const rows = objs.map((o) =>
      headers.map((h) => {
        const v = o[h];
        return v === null || v === undefined
          ? ""
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
      }),
    );
    return { headers, rows };
  }
  return null;
}

export default function SheetRenderer({ content }: { content: string }) {
  const trimmed = content.trim();
  const parsed =
    (trimmed.startsWith("[") ? parseJson(trimmed) : null) ?? parseCsv(content);

  if (parsed.headers.length === 0 && parsed.rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-500">
        Empty sheet.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0">
          <tr>
            <th className="border border-slate-700 bg-slate-800/80 px-2 py-1 text-right font-mono text-[10px] text-slate-500">
              #
            </th>
            {parsed.headers.map((h, i) => (
              <th
                key={i}
                className="border border-slate-700 bg-slate-800/80 px-2 py-1 text-left font-semibold text-slate-200"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {parsed.rows.map((row, ri) => (
            <tr key={ri} className="odd:bg-slate-900/40">
              <td className="border border-slate-700/60 px-2 py-1 text-right font-mono text-[10px] text-slate-600">
                {ri + 1}
              </td>
              {parsed.headers.map((_h, ci) => (
                <td
                  key={ci}
                  className="border border-slate-700/60 px-2 py-1 text-slate-300"
                >
                  {row[ci] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
