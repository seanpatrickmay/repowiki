import { codeCitation, SHA_A } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { MAX_CITED_LINES, resolveReference, verifyClaim } from "./claims.ts";
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
      problem: expect.stringMatching(/names no file/),
    });
    expect(resolveReference("toString:1", ctx)).toMatchObject({
      problem: expect.stringMatching(/names no file/),
    });
  });

  it("quotes a long reference cut to 80 characters in its problem", () => {
    const resolved = resolveReference(`${"p".repeat(200)}.py:1`, testContext());
    const problem = "problem" in resolved ? resolved.problem : "";
    expect(problem).toContain(`${"p".repeat(80)}…`);
    expect(problem).not.toContain("p".repeat(81));
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
    expect(verified.claim?.citations[0]?.sha ?? SHA_A).toMatch(/^[0-9a-f]{40}$/);
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
