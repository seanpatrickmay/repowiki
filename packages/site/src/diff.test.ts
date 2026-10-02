import { bodyClaim, makeRevision } from "@repowiki/core/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { diffSequence, MAX_DIFF_CELLS, revisionDiff, wordDiffHtml } from "./diff.ts";
import { fixtureExport } from "./test-fixtures.ts";

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

describe("wordDiffHtml", () => {
  it("marks changed words and escapes everything", () => {
    expect(wordDiffHtml("a b <c>", "a x <c>")).toBe("a <del>b</del><ins>x</ins> &lt;c&gt;");
  });

  it("escapes changed words inside <del> and <ins>", () => {
    expect(wordDiffHtml("<img/onerror=1>", `"q"&'p'`)).toBe(
      "<del>&lt;img/onerror=1&gt;</del><ins>&quot;q&quot;&amp;&#39;p&#39;</ins>",
    );
  });

  it("escapes text that already looks like an entity instead of splitting or trusting it", () => {
    expect(wordDiffHtml("a &amp; b", "a &amp; c")).toBe("a &amp;amp; <del>b</del><ins>c</ins>");
    expect(wordDiffHtml("&lt;x", "&lt;y")).toBe("<del>&amp;lt;x</del><ins>&amp;lt;y</ins>");
  });

  it("never splits a surrogate pair", () => {
    const html = wordDiffHtml("keep \u{1F600}a end", "keep \u{1F600}b end");
    expect(html).toBe("keep <del>\u{1F600}a</del><ins>\u{1F600}b</ins> end");
    expect(html.isWellFormed()).toBe(true);
    const swapped = wordDiffHtml("x \u{1F600}", "x \u{1F601}");
    expect(swapped).toBe("x <del>\u{1F600}</del><ins>\u{1F601}</ins>");
    expect(swapped.isWellFormed()).toBe(true);
  });

  it("merges adjacent changed words and the whitespace between them into one run", () => {
    expect(wordDiffHtml("a b c d", "a x d")).toBe("a <del>b c</del><ins>x</ins> d");
  });

  it("returns an empty string for two empty claims", () => {
    expect(wordDiffHtml("", "")).toBe("");
  });
});

describe("revisionDiff", () => {
  const [before, after] = fixtureExport().history.signals ?? [];
  if (before === undefined || after === undefined) throw new Error("fixture needs two revisions");
  const diff = revisionDiff(before, after);

  it("lists every changed section in stored order", () => {
    expect(diff.map((section) => section.title)).toEqual([
      "Lead",
      "Overview",
      "How it works",
      "Data flow",
      "History",
      "Known limitations",
    ]);
  });

  it("pairs a rewritten claim into a word diff and shows new claims as added", () => {
    expect(diff[1]?.rows).toEqual([
      {
        kind: "changed",
        html: "Signals are <del>built</del><ins>created</ins> from <del>chunks.</del><ins>ingested chunks by `ingest_chunk`.</ins>",
      },
      { kind: "added", html: "Each signal stores its source chunk and a *confidence* score." },
    ]);
  });

  it("is empty when nothing changed", () => {
    expect(revisionDiff(after, after)).toEqual([]);
  });
});

describe("revisionDiff on synthetic revisions", () => {
  const sections = (overviewTexts: string[], extra: Parameters<typeof makeRevision>[0] = {}) =>
    makeRevision({
      sections: [
        {
          key: "overview",
          claims: overviewTexts.map((text, i) => bodyClaim({ id: `c-${i}`, text })),
        },
      ],
      ...extra,
    });

  it("shows context, removed and added rows, each escaped", () => {
    const before = sections(["keep <i>", "gone <b>", "tail"]);
    const after = sections(["keep <i>", "tail", "new & <u>"]);
    expect(revisionDiff(before, after)).toEqual([
      {
        title: "Overview",
        rows: [
          { kind: "context", html: "keep &lt;i&gt;" },
          { kind: "removed", html: "gone &lt;b&gt;" },
          { kind: "context", html: "tail" },
          { kind: "added", html: "new &amp; &lt;u&gt;" },
        ],
      },
    ]);
  });

  it("pairs removed with added claims in order and leaves the surplus unpaired", () => {
    const before = sections(["one a", "two a", "three a"]);
    const after = sections(["one b"]);
    expect(revisionDiff(before, after)[0]?.rows).toEqual([
      { kind: "changed", html: "one <del>a</del><ins>b</ins>" },
      { kind: "removed", html: "two a" },
      { kind: "removed", html: "three a" },
    ]);
  });

  it("treats a section missing on one side as all added or all removed", () => {
    const empty = makeRevision({ sections: [] });
    const full = sections(["hello"]);
    expect(revisionDiff(empty, full)).toEqual([
      { title: "Overview", rows: [{ kind: "added", html: "hello" }] },
    ]);
    expect(revisionDiff(full, empty)).toEqual([
      { title: "Overview", rows: [{ kind: "removed", html: "hello" }] },
    ]);
  });

  it("omits sections whose claims are identical even when others changed", () => {
    const keep = { key: "lead" as const, claims: [bodyClaim({ id: "l", text: "same" })] };
    const before = makeRevision({
      sections: [keep, { key: "overview", claims: [bodyClaim({ text: "old" })] }],
    });
    const after = makeRevision({
      sections: [keep, { key: "overview", claims: [bodyClaim({ text: "new" })] }],
    });
    expect(revisionDiff(before, after).map((section) => section.title)).toEqual(["Overview"]);
  });
});
