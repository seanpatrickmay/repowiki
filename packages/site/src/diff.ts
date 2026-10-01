import { type Revision, SectionKey } from "@repowiki/core";
import { SECTION_TITLES } from "./article.ts";
import { escapeHtml } from "./inline.ts";

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

/** Word-level diff of one rewritten claim, as HTML with <del> and <ins>; runs are merged. */
export function wordDiffHtml(before: string, after: string): string {
  const words = (text: string) => text.split(/(\s+)/).filter((token) => token !== "");
  const runs: DiffOp<string>[] = [];
  for (const { op, value } of diffSequence(words(before), words(after))) {
    const last = runs.at(-1);
    if (last?.op === op) last.value += value;
    else runs.push({ op, value });
  }
  return runs
    .map(({ op, value }) => {
      const text = escapeHtml(value);
      return op === "equal" ? text : op === "delete" ? `<del>${text}</del>` : `<ins>${text}</ins>`;
    })
    .join("");
}

export interface DiffRow {
  kind: "context" | "removed" | "added" | "changed";
  html: string;
}

export interface DiffSection {
  title: string;
  rows: DiffRow[];
}

/**
 * Claim-by-claim diff of the stored claim text (the page's source, as Wikipedia diffs show
 * wikitext). Sections with no change are omitted. A run of removed claims followed by added
 * ones is paired into "changed" rows with a word diff.
 */
export function revisionDiff(before: Revision, after: Revision): DiffSection[] {
  const texts = (revision: Revision, key: SectionKey) =>
    revision.sections.find((section) => section.key === key)?.claims.map((claim) => claim.text) ??
    [];
  const sections: DiffSection[] = [];
  for (const key of SectionKey.options) {
    const ops = diffSequence(texts(before, key), texts(after, key));
    if (ops.every((op) => op.op === "equal")) continue;
    const rows: DiffRow[] = [];
    let removed: string[] = [];
    let added: string[] = [];
    const flush = () => {
      const paired = Math.min(removed.length, added.length);
      for (let k = 0; k < paired; k++) {
        rows.push({ kind: "changed", html: wordDiffHtml(removed[k] ?? "", added[k] ?? "") });
      }
      for (const text of removed.slice(paired))
        rows.push({ kind: "removed", html: escapeHtml(text) });
      for (const text of added.slice(paired)) rows.push({ kind: "added", html: escapeHtml(text) });
      removed = [];
      added = [];
    };
    for (const { op, value } of ops) {
      if (op === "delete") removed.push(value);
      else if (op === "insert") added.push(value);
      else {
        flush();
        rows.push({ kind: "context", html: escapeHtml(value) });
      }
    }
    flush();
    sections.push({ title: key === "lead" ? "Lead" : SECTION_TITLES[key], rows });
  }
  return sections;
}
