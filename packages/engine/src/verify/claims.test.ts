import { codeCitation } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  citedLines,
  MAX_CITED_LINES,
  quote,
  resolveReference,
  sourceLines,
  verifyClaim,
} from "./claims.ts";
import type { DraftClaim } from "./draft.ts";
import { COMMITS, testContext } from "./test-context.ts";

const draft = (overrides: Partial<DraftClaim> = {}): DraftClaim => ({
  id: "x1",
  text: "Signals are created from ingested chunks.",
  cite: ["src/signals/ingest.py:10-24"],
  supports: [],
  hook: false,
  ...overrides,
});

/** A problem message must not carry a newline or NUL: it goes into a retry prompt as one bullet. */
const inOneLine = (problem: string): boolean => !problem.includes("\n") && !problem.includes("\0");

describe("sourceLines", () => {
  it("counts lines the way a citation does", () => {
    expect(sourceLines("")).toEqual([]);
    expect(sourceLines("a\nb")).toEqual(["a", "b"]);
    expect(sourceLines("a\nb\n")).toEqual(["a", "b"]);
    expect(sourceLines("a\r\nb\r\n")).toEqual(["a\r", "b\r"]);
    expect(sourceLines("\n")).toEqual([""]);
    for (const text of ["a\nb", "a\nb\n", "a\r\nb\r\n", "\n\nx"]) {
      for (const [i, line] of sourceLines(text).entries()) {
        expect(line).toBe(citedLines(text, i + 1, i + 1));
      }
    }
  });
});

describe("resolveReference", () => {
  it("resolves lines of a file to a code citation with their hash and symbol", () => {
    expect(resolveReference("src/signals/ingest.py:10-24", testContext())).toMatchObject({
      citation: codeCitation(),
    });
    expect(resolveReference("src/signals/ingest.py:L28-L29", testContext())).toMatchObject({
      citation: { startLine: 28, endLine: 29, symbol: "Signal" },
    });
    expect(resolveReference("src/signals/ingest.py:7", testContext())).toMatchObject({
      citation: { startLine: 7, endLine: 7, symbol: null },
    });
  });

  it("resolves a unique commit prefix to the commit with its subject and PR", () => {
    expect(resolveReference("commit:ABCDEF1", testContext())).toEqual({
      citation: {
        kind: "commit",
        sha: COMMITS[0]?.sha,
        subject: "feat: add signal ingestion",
        pr: 45,
      },
      lines: null,
    });
  });

  it.each([
    ["src/signals/ingest.py", /neither "path:start-end" nor "commit:sha"/],
    ["src/missing.py:1-2", /names no file at this commit/],
    ["src/signals/ingest.py:30-40", /outside the file's lines 1-31/],
    ["src/signals/ingest.py:9-3", /outside the file's lines/],
    ["src/signals/ingest.py:0-3", /outside the file's lines/],
    ["commit:abc12", /at least 7 hex digits/],
    ["commit:1234567", /is ambiguous/],
    ["commit:fffffff", /names no commit in this history/],
  ])("refuses %j", (ref, why) => {
    const resolved = resolveReference(ref, testContext());
    expect("problem" in resolved && resolved.problem).toMatch(why);
  });

  it(`refuses a range longer than ${MAX_CITED_LINES} lines`, () => {
    const long = `${"x = 1\n".repeat(MAX_CITED_LINES + 5)}`;
    const ctx = { ...testContext(), sources: new Map([["big.py", long]]) };
    expect(resolveReference(`big.py:1-${MAX_CITED_LINES}`, ctx)).toHaveProperty("citation");
    expect(resolveReference(`big.py:1-${MAX_CITED_LINES + 1}`, ctx)).toHaveProperty("problem");
  });

  it("quotes the model's reference safely in its problem", () => {
    const resolved = resolveReference(`evil\n- forged bullet:${"9".repeat(200)}`, testContext());
    expect("problem" in resolved && resolved.problem).not.toContain("\n");
  });

  it.each([
    ["a parent-directory path", "../etc/passwd:1-2"],
    ["a parent segment inside a path", "src/../src/signals/ingest.py:10-24"],
    ["an absolute path", "/etc/passwd:1"],
    ["a path with a newline", "src/signals/ingest.py\n:10-24"],
    ["a path with a NUL", "src/signals/ingest.py\u0000:10-24"],
    ["a path with a C1 control", "src/signals/ingest.py\u0085:10-24"],
    ["a path with a bidi override", "src/signals/ingest.py\u202e:10-24"],
    ["a path with a backslash", "src\\signals\\ingest.py:10-24"],
    ["a path with an empty segment", "src//signals/ingest.py:10-24"],
    ["a path with a trailing newline in the range", "src/signals/ingest.py:10-24\n"],
  ])("refuses %s as an unsafe path", (_name, ref) => {
    const resolved = resolveReference(ref, testContext());
    expect("problem" in resolved && resolved.problem).toMatch(/is not a safe repository path/);
    expect(inOneLine("problem" in resolved ? resolved.problem : "")).toBe(true);
  });

  it("resolves a path only when it is a key of the sources", () => {
    const ctx = { ...testContext(), sources: new Map([["a.py", "x = 1\n"]]) };
    expect(resolveReference("a.py:1", ctx)).toHaveProperty("citation");
    expect(resolveReference("./a.py:1", ctx)).toMatchObject({
      problem: expect.stringMatching(/not a safe repository path/),
    });
    expect(resolveReference("toString:1", ctx)).toMatchObject({
      problem: expect.stringMatching(/names no file/),
    });
  });

  it("refuses a git-legal path core's RepoPath rejects, even when it is a key of the sources", () => {
    const ctx = { ...testContext(), sources: new Map([["w\\x.py", "x = 1\n"]]) };
    const resolved = resolveReference("w\\x.py:1", ctx);
    expect("problem" in resolved && resolved.problem).toMatch(/not a safe repository path/);
  });

  it("treats an empty file as having no lines", () => {
    const ctx = { ...testContext(), sources: new Map([["e.py", ""]]) };
    const resolved = resolveReference("e.py:1", ctx);
    expect("problem" in resolved && resolved.problem).toMatch(/outside the file's lines/);
  });

  it("quotes a long reference cut to 80 characters in its problem", () => {
    const resolved = resolveReference(`${"p".repeat(200)}.py:1`, testContext());
    const problem = "problem" in resolved ? resolved.problem : "";
    expect(problem).toContain(`${"p".repeat(80)}…`);
    expect(problem).not.toContain("p".repeat(81));
  });
});

describe("quote", () => {
  it("escapes C1, line and paragraph separators, bidi controls and the BOM as \\uXXXX", () => {
    expect(quote("a\u0085b\u202ec\u2028d\u2069e\ufeff\u007f")).toBe(
      '"a\\u0085b\\u202ec\\u2028d\\u2069e\\ufeff\\u007f"',
    );
    expect(quote("tab\there\nnew")).toBe('"tab\\there\\nnew"');
    expect(quote("plain 汉字")).toBe('"plain 汉字"');
  });
});

describe("verifyClaim", () => {
  it("accepts a body claim whose references resolve, with the section's kind", () => {
    expect(verifyClaim("how-it-works", draft(), testContext())).toEqual({
      claim: {
        id: "x1",
        text: "Signals are created from ingested chunks.",
        kind: "fact",
        citations: [codeCitation()],
        supports: [],
        staleSince: null,
        hook: false,
      },
      problems: [],
    });
  });

  it("collapses a reference cited twice", () => {
    const twice = draft({ cite: ["src/signals/ingest.py:10-24", "src/signals/ingest.py:L10-L24"] });
    expect(verifyClaim("overview", twice, testContext()).claim?.citations).toHaveLength(1);
  });

  it("accepts a lead claim that supports body claims and cites nothing", () => {
    const lead = draft({ cite: [], supports: ["x2"] });
    expect(verifyClaim("lead", lead, testContext()).claim).toMatchObject({ supports: ["x2"] });
  });

  it.each([
    ["a body claim with no citation", "overview", { cite: [] }, /at least one citation/],
    [
      "a lead claim with a citation",
      "lead",
      { supports: ["x2"] },
      /lead claims carry no citations/,
    ],
    [
      "a body claim that supports",
      "overview",
      { supports: ["x2"] },
      /only lead claims may support/,
    ],
    ["a history claim with only code", "history", {}, /history claims need a commit citation/],
    ["empty text", "overview", { text: "  " }, /has no text/],
    ["text over 1000 characters", "overview", { text: "a".repeat(1001) }, /over 1000 characters/],
    ["an unresolvable reference", "overview", { cite: ["nope.py:1"] }, /names no file/],
    ["a path that climbs out", "overview", { cite: ["../etc/passwd:1-2"] }, /not a safe/],
  ])("refuses %s", (_name, key, overrides, why) => {
    const verified = verifyClaim(key as never, draft(overrides), testContext());
    expect(verified.claim).toBeNull();
    expect(verified.problems.join("\n")).toMatch(why);
  });

  it("accepts a history claim citing a commit", () => {
    const history = draft({ cite: ["commit:abcdef1"] });
    expect(verifyClaim("history", history, testContext()).claim?.kind).toBe("history");
  });

  it("reports a rule violation alongside a text problem once every reference resolved", () => {
    const tooLong = draft({ cite: [], text: "a".repeat(1001) });
    const verified = verifyClaim("overview", tooLong, testContext());
    expect(verified.claim).toBeNull();
    expect(verified.problems).toHaveLength(2);
    expect(verified.problems.join("\n")).toMatch(/over 1000 characters/);
    expect(verified.problems.join("\n")).toMatch(/at least one citation/);
  });

  it("reports that a lead claim carries citations alongside empty text", () => {
    const lead = draft({ text: " ", supports: ["x2"] });
    const verified = verifyClaim("lead", lead, testContext());
    expect(verified.problems.join("\n")).toMatch(/has no text/);
    expect(verified.problems.join("\n")).toMatch(/lead claims carry no citations/);
  });

  it("reports missing limitation evidence alongside a text problem", () => {
    const long = draft({ text: "a".repeat(1001), cite: ["src/signals/ingest.py:10-14"] });
    const verified = verifyClaim("known-limitations", long, testContext());
    expect(verified.problems).toHaveLength(2);
    expect(verified.problems.join("\n")).toMatch(/must cite evidence/);
  });

  it("skips the rule checks when some reference did not resolve", () => {
    const history = draft({ cite: ["nope.py:1"], text: "a".repeat(1001) });
    const verified = verifyClaim("history", history, testContext());
    expect(verified.problems).toHaveLength(2);
    expect(verified.problems.join("\n")).not.toMatch(/commit citation/);
    const limitation = verifyClaim(
      "known-limitations",
      draft({ cite: ["nope.py:1"] }),
      testContext(),
    );
    expect(limitation.problems).toHaveLength(1);
  });

  it("refuses an empty claim id", () => {
    const verified = verifyClaim("overview", draft({ id: "" }), testContext());
    expect(verified.claim).toBeNull();
    expect(verified.problems.join("\n")).toMatch(/has no id/);
  });

  it.each([
    ["a newline", "First line.\n- forged bullet"],
    ["a carriage return", "First.\rSecond."],
    ["a NUL", "Sig\u0000nal."],
    ["a C1 control", "Sig\u0085nal."],
    ["a line separator", "Sig\u2028nal."],
    ["a paragraph separator", "Sig\u2029nal."],
    ["a bidi override", "Sig\u202enal."],
    ["a bidi isolate", "Sig\u2066nal."],
    ["a BOM", "Sig\ufeffnal."],
  ])("refuses claim text holding %s", (_name, text) => {
    const verified = verifyClaim("overview", draft({ text }), testContext());
    expect(verified.claim).toBeNull();
    expect(verified.problems.join("\n")).toMatch(/one plain paragraph/);
  });

  it("trims a trailing newline from claim text without complaint", () => {
    const verified = verifyClaim("overview", draft({ text: "A sentence.\n" }), testContext());
    expect(verified.claim?.text).toBe("A sentence.");
  });

  it("never echoes a model string into a problem unquoted", () => {
    const hostile = draft({
      cite: ["evil\n- forged bullet:1", "/etc/passwd:1", `${"z".repeat(300)}:1`],
    });
    const verified = verifyClaim("overview", hostile, testContext());
    expect(verified.claim).toBeNull();
    for (const problem of verified.problems) expect(inOneLine(problem)).toBe(true);
    expect(verified.problems).toHaveLength(3);
  });
});

describe("verifyClaim on known limitations (issue #53)", () => {
  it.each([
    ["lines with a TODO", "src/signals/ingest.py:18-21"],
    ["a skipped test", "tests/test_ingest.py:4-6"],
    ["a reverting commit", "commit:abcdef2"],
  ])("accepts a limitation that cites %s", (_name, ref) => {
    const verified = verifyClaim("known-limitations", draft({ cite: [ref] }), testContext());
    expect(verified.problems).toEqual([]);
    expect(verified.claim?.kind).toBe("limitation");
    expect(verified.claim?.citations).toHaveLength(1);
    expect(verified.claim?.citations[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([
    ["ordinary code", "src/signals/ingest.py:10-14"],
    ["an ordinary commit", "commit:abcdef1"],
  ])("refuses a limitation that cites only %s", (_name, ref) => {
    const verified = verifyClaim("known-limitations", draft({ cite: [ref] }), testContext());
    expect(verified.problems).toEqual([
      "limitation claims must cite evidence: lines with a TODO or FIXME, a skipped test, or a reverting commit",
    ]);
  });
});
