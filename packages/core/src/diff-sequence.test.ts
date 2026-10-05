import { describe, expect, it, vi } from "vitest";
import { claimChanges, diffSequence, MAX_DIFF_CELLS, wordDiff } from "./diff-sequence.ts";

describe("diffSequence", () => {
  it("keeps common items and lists deletions before insertions", () => {
    expect(diffSequence(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { op: "equal", value: "a" },
      { op: "delete", value: "b" },
      { op: "insert", value: "x" },
      { op: "equal", value: "c" },
      { op: "insert", value: "d" },
    ]);
  });

  it("handles empty sides", () => {
    expect(diffSequence([], ["a"])).toEqual([{ op: "insert", value: "a" }]);
    expect(diffSequence(["a"], [])).toEqual([{ op: "delete", value: "a" }]);
  });

  it("falls back to delete-all, insert-all for inputs too large to table", () => {
    const size = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1;
    const same = Array.from({ length: size }, (_, i) => String(i));
    const ops = diffSequence(same, same);
    expect(ops.filter((op) => op.op === "equal")).toEqual([]);
    expect(ops).toHaveLength(size * 2);
  });

  it("checks the cell budget before allocating the table", () => {
    // 4000 x 4000 would be 16M cells; the check must return before anything that size exists.
    const big = Array.from({ length: 4_000 }, (_, i) => String(i));
    const ops = diffSequence(big, big);
    expect(ops).toHaveLength(8_000);
    expect(ops.slice(0, 4_000).every((op) => op.op === "delete")).toBe(true);
    expect(ops.slice(4_000).every((op) => op.op === "insert")).toBe(true);
  });

  it("budgets the product of the lengths, not either length alone", () => {
    const many = Array.from({ length: 3_000 }, (_, i) => String(i));
    const ops = diffSequence(many, many);
    expect(ops.filter((op) => op.op === "equal")).toEqual([]);
    expect(ops).toHaveLength(6_000);
  });

  it("tables (n + 1) x (m + 1) cells: 999 x 999 is exactly MAX_DIFF_CELLS and is still diffed", () => {
    const same = Array.from({ length: 999 }, (_, i) => String(i));
    expect((same.length + 1) * (same.length + 1)).toBe(MAX_DIFF_CELLS);
    expect(diffSequence(same, same).every((op) => op.op === "equal")).toBe(true);
  });

  it("falls back as soon as the table would pass MAX_DIFF_CELLS: 1000 x 1000 is 1,002,001 cells", () => {
    const same = Array.from({ length: 1000 }, (_, i) => String(i));
    const ops = diffSequence(same, same);
    expect(ops.filter((op) => op.op === "equal")).toEqual([]);
    expect(ops).toHaveLength(2000);
  });

  it("counts the extra row and column on each side: 2 x 500,001 cells is the last that is diffed", () => {
    const hasEqual = (ops: { op: string }[]) => ops.some((op) => op.op === "equal");
    const side = (length: number) => Array.from({ length }, (_, i) => String(i));
    // (1 + 1) * (499_999 + 1) = 1_000_000: diffed. (1 + 1) * (500_000 + 1) = 1_000_002: falls back.
    expect(hasEqual(diffSequence(["0"], side(499_999)))).toBe(true);
    expect(hasEqual(diffSequence(side(499_999), ["0"]))).toBe(true);
    expect(hasEqual(diffSequence(["0"], side(500_000)))).toBe(false);
    expect(hasEqual(diffSequence(side(500_000), ["0"]))).toBe(false);
    expect(diffSequence(["0"], side(500_000))).toHaveLength(500_001);
  });

  describe("allocation", () => {
    // Records every typed-array and Array.from allocation made while fn runs.
    const allocations = (fn: () => void): number[] => {
      const sizes: number[] = [];
      const RealUint32Array = Uint32Array;
      vi.stubGlobal(
        "Uint32Array",
        class extends RealUint32Array {
          constructor(length: number) {
            super(length);
            sizes.push(length);
          }
        },
      );
      const from = vi.spyOn(Array, "from");
      try {
        fn();
        sizes.push(...from.mock.calls.map(() => -1));
      } finally {
        from.mockRestore();
        vi.unstubAllGlobals();
      }
      return sizes;
    };

    it("builds no table when one side is empty, even one a table could hold", () => {
      // (500_000 + 1) * (0 + 1) is under MAX_DIFF_CELLS, so only the empty-side check avoids a table.
      const long = Array.from({ length: 500_000 }, (_, i) => String(i));
      let del: ReturnType<typeof diffSequence<string>> = [];
      let ins: ReturnType<typeof diffSequence<string>> = [];
      expect(
        allocations(() => {
          del = diffSequence(long, []);
          ins = diffSequence([], long);
        }),
      ).toEqual([]);
      expect(del).toHaveLength(long.length);
      expect(del.every((op, i) => op.op === "delete" && op.value === long[i])).toBe(true);
      expect(ins).toHaveLength(long.length);
      expect(ins.every((op, i) => op.op === "insert" && op.value === long[i])).toBe(true);
    });

    it("builds no table for a huge empty-sided input either", () => {
      const huge = Array.from({ length: MAX_DIFF_CELLS + 5 }, (_, i) => String(i));
      const results: ReturnType<typeof diffSequence<string>>[] = [];
      expect(allocations(() => results.push(diffSequence(huge, [])))).toEqual([]);
      expect(results[0]).toHaveLength(huge.length);
      expect(results[0]?.every((op) => op.op === "delete")).toBe(true);
    });

    it("builds no table for an oversized input", () => {
      const big = Array.from({ length: 5_000 }, (_, i) => String(i));
      expect(allocations(() => diffSequence(big, big))).toEqual([]);
    });

    it("builds one flat table of (n + 1) x (m + 1) cells", () => {
      expect(allocations(() => diffSequence(["a", "b"], ["a", "c", "d"]))).toEqual([12]);
    });
  });

  it("lists every deletion of a replaced run before its insertions", () => {
    expect(diffSequence(["a", "b"], ["x", "y"]).map((op) => op.op)).toEqual([
      "delete",
      "delete",
      "insert",
      "insert",
    ]);
  });
});

describe("wordDiff", () => {
  it("merges adjacent changed words and the whitespace between them into one run", () => {
    expect(wordDiff("a b c d", "a x d")).toEqual([
      { op: "equal", value: "a " },
      { op: "delete", value: "b c" },
      { op: "insert", value: "x" },
      { op: "equal", value: " d" },
    ]);
  });

  it("never splits a surrogate pair, and is empty for two empty texts", () => {
    expect(wordDiff("x \u{1F600}", "x \u{1F601}")).toEqual([
      { op: "equal", value: "x " },
      { op: "delete", value: "\u{1F600}" },
      { op: "insert", value: "\u{1F601}" },
    ]);
    expect(wordDiff("", "")).toEqual([]);
  });
});

describe("claimChanges", () => {
  const page = (overview: string[], history: string[] = []) => [
    { key: "lead", claims: [{ text: "same lead" }] },
    { key: "overview", claims: overview.map((text) => ({ text })) },
    { key: "history", claims: history.map((text) => ({ text })) },
  ];
  const KEYS = ["lead", "overview", "how-it-works", "history"];

  it("lists context, removed, added and paired changed claims, section by section in key order", () => {
    expect(
      claimChanges(
        page(["keep", "old one", "tail"], ["h1"]),
        page(["keep", "new one", "tail", "extra"], []),
        KEYS,
      ),
    ).toEqual([
      { section: "overview", kind: "context", before: "keep", after: "keep" },
      { section: "overview", kind: "changed", before: "old one", after: "new one" },
      { section: "overview", kind: "context", before: "tail", after: "tail" },
      { section: "overview", kind: "added", before: null, after: "extra" },
      { section: "history", kind: "removed", before: "h1", after: null },
    ]);
  });

  it("pairs removed with added claims in order and leaves the surplus unpaired", () => {
    expect(claimChanges(page(["one a", "two a", "three a"]), page(["one b"]), KEYS)).toEqual([
      { section: "overview", kind: "changed", before: "one a", after: "one b" },
      { section: "overview", kind: "removed", before: "two a", after: null },
      { section: "overview", kind: "removed", before: "three a", after: null },
    ]);
  });

  it("is empty for equal sections, and skips keys neither side has", () => {
    expect(claimChanges(page(["a"]), page(["a"]), KEYS)).toEqual([]);
    expect(claimChanges([], [{ key: "layers", claims: [{ text: "x" }] }], ["layers"])).toEqual([
      { section: "layers", kind: "added", before: null, after: "x" },
    ]);
  });
});
