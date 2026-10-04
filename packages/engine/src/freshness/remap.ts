import type { Hunk } from "../index/index.ts";

/** A 1-based, inclusive range of lines. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * Where a cited range's lines are after a diff (spec §6.1 step 2), or null when one of them was
 * changed or deleted, or a line was inserted between two of them. Every hunk above the range
 * shifts it by the lines that hunk added less the lines it removed; a hunk below leaves it
 * alone. `hunks` are git's zero-context hunks of one file, in order.
 */
export function remapRange(range: LineRange, hunks: readonly Hunk[]): LineRange | null {
  let shift = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount > 0) {
      const last = hunk.oldStart + hunk.oldCount - 1;
      if (last < range.start) {
        shift += hunk.newCount - hunk.oldCount;
        continue;
      }
      if (hunk.oldStart > range.end) break;
      return null;
    }
    // A pure insertion, after old line oldStart: above the range, inside it, or below it.
    if (hunk.oldStart < range.start) {
      shift += hunk.newCount;
      continue;
    }
    if (hunk.oldStart >= range.end) break;
    return null;
  }
  return { start: range.start + shift, end: range.end + shift };
}
