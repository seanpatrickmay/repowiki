import type { ContextPack } from "@repowiki/engine";
import { describe, expect, it } from "vitest";
import { CliError } from "./manifest-cli.ts";
import {
  ASSUMED_PAGE_OUTPUT_TOKENS,
  estimateBuild,
  parseWikiArgs,
  renderBuildSummary,
} from "./wiki-cli.ts";

describe("parseWikiArgs", () => {
  it("reads the repo, rev and flags in any order, with defaults", () => {
    expect(parseWikiArgs(["--dry-run", "../repo", "7247d28", "--budget", "20000"])).toEqual({
      repo: "../repo",
      rev: "7247d28",
      out: null,
      config: null,
      batch: true,
      dryRun: true,
      budgetTokens: 20_000,
      deadlineMinutes: null,
    });
    expect(
      parseWikiArgs(["../repo", "--no-batch", "--deadline", "90", "--out", "/tmp/w"]),
    ).toMatchObject({
      rev: "HEAD",
      batch: false,
      deadlineMinutes: 90,
      out: "/tmp/w",
    });
  });

  it.each([
    [[]],
    [["a", "b", "c"]],
    [["a", "--budget", "0"]],
    [["a", "--deadline", "soon"]],
    [["a", "--unknown"]],
  ])("refuses %j with a CliError", (argv) => {
    expect(() => parseWikiArgs(argv)).toThrow(CliError);
  });

  it("takes a deadline of a positive number of minutes up to 24 hours", () => {
    expect(parseWikiArgs(["a", "--deadline", "1440"]).deadlineMinutes).toBe(1440);
    expect(parseWikiArgs(["a", "--deadline", "0.5"]).deadlineMinutes).toBe(0.5);
    for (const bad of ["0", "-5", "1441", "Infinity", "NaN", "", "1e9"])
      expect(() => parseWikiArgs(["a", "--deadline", bad])).toThrow(CliError);
  });

  it("takes a budget of a positive integer only", () => {
    expect(parseWikiArgs(["a"]).budgetTokens).toBe(30_000);
    for (const bad of ["1.5", "-1", "NaN", "", "9".repeat(20)])
      expect(() => parseWikiArgs(["a", "--budget", bad])).toThrow(CliError);
  });

  it.each([
    [["a", "--budget", "hunter2"], "--budget"],
    [["a", "--deadline", "hunter2"], "--deadline"],
    [["a", "--unknown=hunter2"], "--unknown"],
    [["a", "--out"], "--out"],
    [["a", "--no-batch=hunter2"], "--no-batch"],
  ])("answers %j with one line that names only the flag", (argv, flag) => {
    let message = "";
    try {
      parseWikiArgs(argv);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      message = (err as CliError).message;
    }
    expect(message).toContain(flag);
    expect(message).not.toContain("hunter2");
    expect(message).not.toMatch(/[\r\n]/);
  });
});

const pack = (tokens: number) => ({ tokens }) as ContextPack;

describe("estimateBuild", () => {
  it("prices every page's prefix, pack and assumed answer at Haiku 4.5 rates", () => {
    const system = "x".repeat(10_000); // 4,000 estimated tokens
    const estimate = estimateBuild([pack(20_000), pack(26_000)], system, "claude-haiku-4-5", false);
    expect(estimate).toEqual({
      pages: 2,
      inputTokens: 54_000,
      outputTokens: 2 * ASSUMED_PAGE_OUTPUT_TOKENS,
      usd: (54_000 * 1 + 8_000 * 5) / 1_000_000,
    });
    expect(
      estimateBuild([pack(20_000), pack(26_000)], system, "claude-haiku-4-5", true).usd,
    ).toBeCloseTo(estimate.usd / 2, 12);
  });
});

const totals = {
  calls: 3,
  batchCalls: 3,
  tokens: { in: 1000, out: 200, cacheRead: 4000, cacheWrite: 0 },
  usd: 0.0123,
  unpricedCalls: 0,
};
const estimate = { pages: 1, inputTokens: 1, outputTokens: 1, usd: 0.02 };
const failed = (featureId: string, failure: string) => ({
  featureId,
  revision: null,
  failure,
  dropped: [],
  calls: 2,
  tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
});

describe("renderBuildSummary", () => {
  it("lists every page with its claims, drops and calls, and the cost against the estimate", () => {
    const summary = renderBuildSummary(
      "repo",
      "a".repeat(40),
      [failed("a", "the write call failed: x|y")],
      estimate,
      totals,
    );
    expect(summary).toContain("0 of 1 pages written, 0 claims dropped.");
    expect(summary).toContain("| `a` | 0 | 0 | 2 | the write call failed: x y |");
    expect(summary).toContain(
      "3 calls (3 batched): 1,000 input, 200 output, 4,000 cache-read, 0 cache-write tokens.",
    );
    expect(summary).toContain("Cost: $0.0123 (estimated up front: $0.0200 for the first round).");
  });

  it("says the estimate runs high because it assumes no cache hits", () => {
    const summary = renderBuildSummary("repo", "a".repeat(40), [], estimate, totals);
    expect(summary).toMatch(/upper-side estimate.*no cache hits/);
    expect(renderBuildSummary("repo", "a".repeat(40), [], null, totals)).not.toContain("estimate");
  });

  it("keeps a repo name, feature id and failure from injecting Markdown", () => {
    const hostile = "t\n# Injected `x` | [x](javascript:alert(1))";
    const summary = renderBuildSummary(
      `repo\n# Injected ${hostile}`,
      "a".repeat(40),
      [failed(hostile, `boom\r\n# Injected\u2028## Again ${hostile}`)],
      estimate,
      totals,
    );
    expect(summary.split("\n").filter((l) => l.startsWith("#"))).toEqual([
      expect.stringMatching(/^# Build: repo # Injected /),
      "## LLM cost",
    ]);
    const row = summary.split("\n").find((l) => l.startsWith("| ``"));
    const cells = (row ?? "").slice(1, -1).split(/(?<!\\)\|/);
    // the feature id's pipe is escaped inside its span, and the failure's cannot split a cell
    expect(cells).toHaveLength(5);
    expect(cells[0]).toBe(" ``t # Injected `x` \\| [x](javascript:alert(1))`` ");
    for (const unsafe of ["](", "`", "<", "\u2028"]) expect(cells[4]).not.toContain(unsafe);
  });
});
