import { describe, expect, it } from "vitest";
import { createTestRepo, diffCommits, type Hunk } from "../index/index.ts";
import { remapRange } from "./remap.ts";

/** A seeded pseudo-random generator (mulberry32): the same seed gives the same cases. */
function random(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}

interface Edit {
  /** Replace `count` old lines from `start` (count 0: insert after line `start`). */
  start: number;
  count: number;
  lines: string[];
}

/**
 * A file of unique lines and up to five edits that never touch or abut each other: insertions
 * above, below and inside the range, deletions, and replacements of every size.
 */
function scenario(next: (below: number) => number) {
  const old = Array.from({ length: 1 + next(40) }, (_, i) => `old ${i + 1}`);
  const edits: Edit[] = [];
  let line = 0;
  let fresh = 0;
  for (let k = next(6); k > 0 && line < old.length; k--) {
    const start = line + next(Math.max(1, old.length - line));
    const count = Math.min(next(4), old.length - start);
    const inserted = Array.from({ length: next(4) }, () => `new ${++fresh}`);
    if (count === 0 && inserted.length === 0) continue;
    // An insertion goes after line `start`; a replacement starts at line `start + 1`.
    edits.push(
      count === 0
        ? { start, count, lines: inserted }
        : { start: start + 1, count, lines: inserted },
    );
    line = start + count + 1;
  }
  const result: string[] = [];
  const hunks: Hunk[] = [];
  let cursor = 0;
  for (const edit of edits) {
    const firstOld = edit.count === 0 ? edit.start + 1 : edit.start;
    result.push(...old.slice(cursor, firstOld - 1));
    const newStart = result.length + (edit.lines.length === 0 ? 0 : 1);
    result.push(...edit.lines);
    hunks.push({
      oldStart: edit.start,
      oldCount: edit.count,
      newStart,
      newCount: edit.lines.length,
    });
    cursor = firstOld - 1 + edit.count;
  }
  result.push(...old.slice(cursor));
  const a = 1 + next(old.length);
  const b = 1 + next(old.length);
  const range = { start: Math.min(a, b), end: Math.max(a, b) };
  const touched = edits.some((e) =>
    e.count > 0
      ? e.start <= range.end && e.start + e.count - 1 >= range.start
      : e.start >= range.start && e.start < range.end,
  );
  return { old, result, hunks, range, touched };
}

describe("remapRange", () => {
  it("shifts a range below an insertion and keeps one above a deletion", () => {
    const insertTwoAtTop = { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 };
    const deleteLine30 = { oldStart: 30, oldCount: 1, newStart: 31, newCount: 0 };
    expect(remapRange({ start: 10, end: 24 }, [insertTwoAtTop, deleteLine30])).toEqual({
      start: 12,
      end: 26,
    });
  });

  it("treats an insertion right after the range's last line as below it", () => {
    expect(
      remapRange({ start: 10, end: 24 }, [
        { oldStart: 24, oldCount: 0, newStart: 25, newCount: 3 },
      ]),
    ).toEqual({
      start: 10,
      end: 24,
    });
    expect(
      remapRange({ start: 10, end: 24 }, [
        { oldStart: 23, oldCount: 0, newStart: 24, newCount: 1 },
      ]),
    ).toBeNull();
  });

  it.each([
    ["the first line changed", { oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 }],
    ["the last line deleted", { oldStart: 24, oldCount: 1, newStart: 23, newCount: 0 }],
    ["a hunk across the start", { oldStart: 8, oldCount: 3, newStart: 8, newCount: 1 }],
  ])("is null when %s", (_name, hunk) => {
    expect(remapRange({ start: 10, end: 24 }, [hunk])).toBeNull();
  });

  it("matches the edits that made the new file, over 2,000 seeded cases", () => {
    const next = random(20261003);
    for (let n = 0; n < 2000; n++) {
      const { old, result, hunks, range, touched } = scenario(next);
      const mapped = remapRange(range, hunks);
      if (touched) {
        expect(mapped, `case ${n}`).toBeNull();
      } else {
        expect(mapped, `case ${n}`).not.toBeNull();
        const { start, end } = mapped as { start: number; end: number };
        expect(result.slice(start - 1, end), `case ${n}`).toEqual(
          old.slice(range.start - 1, range.end),
        );
      }
    }
  });

  it("agrees with git's own hunks over 15 seeded edits", { timeout: 30_000 }, () => {
    const next = random(7);
    const repo = createTestRepo();
    try {
      for (let n = 0; n < 15; n++) {
        const { old, result, range, touched } = scenario(next);
        repo.write("a.txt", `${old.join("\n")}\n`);
        const from = repo.commit(`old ${n}`);
        repo.write("a.txt", `${result.join("\n")}\n`);
        const to = repo.commit(`new ${n}`);
        const hunks = diffCommits(repo.dir, from, to)[0]?.hunks ?? [];
        const mapped = remapRange(range, hunks);
        if (touched) expect(mapped, `case ${n}`).toBeNull();
        else {
          expect(mapped, `case ${n}`).not.toBeNull();
          const { start, end } = mapped as { start: number; end: number };
          expect(result.slice(start - 1, end), `case ${n}`).toEqual(
            old.slice(range.start - 1, range.end),
          );
        }
      }
    } finally {
      repo.remove();
    }
  });
});
