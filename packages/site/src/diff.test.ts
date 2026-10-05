import { claimChanges, SectionKey } from "@repowiki/core";
import { bodyClaim, makeRevision } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { revisionDiff, wordDiffHtml } from "./diff.ts";
import { fixtureExport } from "./test-fixtures.ts";

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

  it("has one row per core claimChanges row, in the same order", () => {
    const changes = claimChanges(before.sections, after.sections, SectionKey.options);
    expect(diff.flatMap((section) => section.rows.map((row) => row.kind))).toEqual(
      changes.map((change) => change.kind),
    );
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
