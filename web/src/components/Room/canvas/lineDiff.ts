/**
 * Tiny self-contained line diff (LCS), so the version diff view needs no extra
 * dependency. Produces a list of {type, text} rows: "same" | "add" | "del".
 * Good enough for the canvas's prev-vs-current preview; not a word-level diff.
 */

export type DiffRowType = "same" | "add" | "del";
export interface DiffRow {
  type: DiffRowType;
  text: string;
}

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i]!;
      const next = dp[i + 1]!;
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  // Walk the table to emit rows.
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ type: "del", text: a[i] ?? "" });
      i++;
    } else {
      out.push({ type: "add", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] ?? "" });
    i++;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] ?? "" });
    j++;
  }
  return out;
}
