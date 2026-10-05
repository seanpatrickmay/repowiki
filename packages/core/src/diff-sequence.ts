export type DiffOp<T> = { op: "equal" | "delete" | "insert"; value: T };

/**
 * Above this many cells (including the table's extra row and column) the LCS table is skipped and
 * the change shown as delete-all, insert-all.
 */
export const MAX_DIFF_CELLS = 1_000_000;

/** Longest-common-subsequence diff of two sequences, in order. */
export function diffSequence<T>(a: readonly T[], b: readonly T[]): DiffOp<T>[] {
  // An empty side needs no table, and the cell check must come before any table is allocated.
  if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    return [
      ...a.map((value): DiffOp<T> => ({ op: "delete", value })),
      ...b.map((value): DiffOp<T> => ({ op: "insert", value })),
    ];
  }
  // lcs[i * width + j] = length of the LCS of a[i..] and b[j..]
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: "equal", value: a[i] as T });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || at(i + 1, j) >= at(i, j + 1))) {
      ops.push({ op: "delete", value: a[i] as T });
      i++;
    } else {
      ops.push({ op: "insert", value: b[j] as T });
      j++;
    }
  }
  return ops;
}

/**
 * A word-level diff of one rewritten text: words and the whitespace between them, with adjacent
 * pieces of one kind merged into a run. Rendering (HTML on the site, `[-…-]{+…+}` for agents) is
 * the caller's.
 */
export function wordDiff(before: string, after: string): DiffOp<string>[] {
  const words = (text: string) => text.split(/(\s+)/).filter((token) => token !== "");
  const runs: DiffOp<string>[] = [];
  for (const { op, value } of diffSequence(words(before), words(after))) {
    const last = runs.at(-1);
    if (last?.op === op) last.value += value;
    else runs.push({ op, value });
  }
  return runs;
}

/** Sections of claims, as a feature page and the About article both store them. */
export interface ClaimSections {
  key: string;
  claims: readonly { text: string }[];
}

/**
 * One row of a claim-by-claim diff: a claim kept as it was (`context`), removed, added, or
 * rewritten (`changed`: a removed claim paired with the added one that took its place). Plain
 * stored claim text, no markup.
 */
export interface ClaimChange {
  section: string;
  kind: "context" | "removed" | "added" | "changed";
  before: string | null;
  after: string | null;
}

/**
 * Claim-by-claim diff of the stored claim text (the page's source, as Wikipedia diffs show
 * wikitext), section by section in `keys` order. Sections with no change are left out. A run of
 * removed claims followed by added ones is paired, in order, into `changed` rows; the surplus
 * stays removed or added.
 */
export function claimChanges(
  before: readonly ClaimSections[],
  after: readonly ClaimSections[],
  keys: readonly string[],
): ClaimChange[] {
  const texts = (sections: readonly ClaimSections[], key: string) =>
    sections.find((section) => section.key === key)?.claims.map((claim) => claim.text) ?? [];
  const changes: ClaimChange[] = [];
  for (const section of keys) {
    const ops = diffSequence(texts(before, section), texts(after, section));
    if (ops.every((op) => op.op === "equal")) continue;
    let removed: string[] = [];
    let added: string[] = [];
    const flush = () => {
      const paired = Math.min(removed.length, added.length);
      for (let k = 0; k < paired; k++) {
        changes.push({
          section,
          kind: "changed",
          before: removed[k] ?? "",
          after: added[k] ?? "",
        });
      }
      for (const text of removed.slice(paired))
        changes.push({ section, kind: "removed", before: text, after: null });
      for (const text of added.slice(paired))
        changes.push({ section, kind: "added", before: null, after: text });
      removed = [];
      added = [];
    };
    for (const { op, value } of ops) {
      if (op === "delete") removed.push(value);
      else if (op === "insert") added.push(value);
      else {
        flush();
        changes.push({ section, kind: "context", before: value, after: value });
      }
    }
    flush();
  }
  return changes;
}
