import { makeGitHubSnapshot, makeInFlight, makeInFlightPull } from "@repowiki/core/test-fixtures";
import { sampleWiki } from "@repowiki/query/test-wiki";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFLIGHT_USD,
  fetchLine,
  INFLIGHT_USAGE,
  inflightEstimateLine,
  parseInflightArgs,
  readLine,
  renderInflightTable,
  suggestFor,
} from "./inflight-cli.ts";
import { CliError } from "./manifest-cli.ts";

describe("parseInflightArgs (spec v2 #9 §6.1)", () => {
  it("takes the repository and every flag in any order, with the defaults", () => {
    expect(parseInflightArgs(["repo"])).toEqual({
      repo: "repo",
      out: null,
      github: null,
      offline: false,
      noLlm: false,
      maxUsd: DEFAULT_INFLIGHT_USD,
      dryRun: false,
      batch: true,
      deadlineMinutes: null,
      config: null,
      clear: false,
      verbose: false,
    });
    expect(
      parseInflightArgs([
        "--no-llm",
        "repo",
        "--out=o",
        "--github",
        "acme/demo",
        "--max-usd",
        "0.25",
        "--dry-run",
        "--no-batch",
        "--deadline",
        "30",
        "--config",
        "c.json",
        "--verbose",
      ]),
    ).toMatchObject({
      repo: "repo",
      out: "o",
      github: "acme/demo",
      noLlm: true,
      maxUsd: 0.25,
      dryRun: true,
      batch: false,
      deadlineMinutes: 30,
      config: "c.json",
      verbose: true,
    });
    expect(parseInflightArgs(["repo", "--offline"]).offline).toBe(true);
    expect(parseInflightArgs(["repo", "--clear", "--out", "o", "--verbose"]).clear).toBe(true);
  });

  it.each([
    [[], INFLIGHT_USAGE],
    [["a", "b"], INFLIGHT_USAGE],
    [[""], "<repo-path> must not be empty"],
    [["repo", "--out", "a", "--out", "b"], "--out was given more than once"],
    [["repo", "--github="], "--github must not be empty"],
    [["repo", "--max-usd", "0"], "--max-usd must be a number of dollars above 0 and up to 100"],
    [["repo", "--max-usd", "101"], "--max-usd must be a number"],
    [["repo", "--max-usd", "1e1"], "--max-usd must be a number"],
    [["repo", "--deadline", "0"], "--deadline must be a number of minutes"],
    [["repo", "--budget", "9"], "bad option --budget"],
    [["repo", "--offline", "--github", "a/b"], "--offline reads no GitHub"],
    [["repo", "--clear", "--offline"], "--clear takes only --out and --verbose, not --offline"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseInflightArgs(argv)).toThrow(CliError);
    expect(() => parseInflightArgs(argv)).toThrow(message);
  });

  it("never echoes a flag's value", () => {
    expect(() => parseInflightArgs(["repo", "--token=ghp_secret"])).toThrow(
      /^bad option --token; usage/,
    );
  });
});

describe("the lines it prints", () => {
  it("says what was read, with the caps and the malformed entries", () => {
    expect(readLine(makeGitHubSnapshot())).toBe("acme/demo: 1 open pull request, 1 open issue");
    expect(
      readLine(makeGitHubSnapshot({ pulls: [], omitted: { pulls: 3, issues: 0 }, dropped: 2 })),
    ).toBe(
      "acme/demo: 0 open pull requests, 1 open issue; 3 more pull requests and 0 more issues not read (the caps); 2 malformed entries dropped",
    );
    expect(readLine(makeGitHubSnapshot({ droppedPaths: 1 }))).toBe(
      "acme/demo: 1 open pull request, 1 open issue; 1 unsafe file path dropped",
    );
  });

  it("counts the heads, and gives the fetch's first line redacted", () => {
    const heads = new Map([
      [1, "fetched" as const],
      [2, "missing" as const],
      [3, "fetched" as const],
    ]);
    expect(fetchLine(heads, null)).toBe(
      "pull-request heads: 2 fetched, 1 missing, 0 moved since GitHub was read",
    );
    const token = ["ghp", "abc123"].join("_");
    expect(fetchLine(heads, `fatal: auth ${token}\u001b[31m`)).toBe(
      "pull-request heads: 2 fetched, 1 missing, 0 moved since GitHub was read; the fetch said: fatal: auth [redacted]?[31m",
    );
  });

  it("states the estimate before any call (spec v2 #9 §7.3)", () => {
    const estimate = { requests: 3, cached: 1, typicalUsd: 0.0123, ceilingUsd: 0.02 };
    expect(inflightEstimateLine(estimate, { maxUsd: 1, batch: true })).toBe(
      "3 pull-request summaries (1 cached, 2 to request): about $0.0123 (batched) assuming 700 output tokens each and no cache hits, at most $0.0200 if every answer takes 1,500; no summary is requested beyond $1.0000 (--max-usd)",
    );
  });

  it("tables every pull request through cell(), certain effects first, and lists failures", () => {
    const inflight = makeInFlight({
      pulls: [
        makeInFlightPull({ title: "Use `|` pipes" }),
        makeInFlightPull({
          number: 13,
          head: "missing",
          headSha: "d".repeat(40),
          mergeBase: null,
          merge: "unknown",
          files: [],
          features: [],
          effects: [],
          summary: null,
          closes: [],
        }),
      ],
      issues: [],
    });
    const table = renderInflightTable(
      inflight,
      new Map([
        [12, "new"],
        [13, "failed"],
      ]),
      new Map([[13, "no claim verified\n(2 dropped)"]]),
    );
    expect(table.split("\n")).toEqual([
      "| Pull request | Features touched | Claims it would make stale | Summary |",
      "|---|---|---|---|",
      "| ``#12 Use `\\|` pipes`` | `signals` | 2 | new |",
      "| `#13 Page through long chunks` | none | not computed (head missing) | failed |",
      "#13: no summary this run: no claim verified (2 dropped)",
    ]);
    expect(renderInflightTable(makeInFlight({ pulls: [], issues: [] }), new Map(), new Map())).toBe(
      "No open pull requests.",
    );
  });
});

describe("suggestFor (C3)", () => {
  it("ranks the export's pages for an issue's text, with scores and without the About article", () => {
    const sample = sampleWiki();
    try {
      const found = suggestFor(sample.wiki)("Deliverables crud is slow");
      expect(found[0]?.featureId).toBe("deliverables");
      expect(found[0]?.score).toBeGreaterThan(0);
      expect(found.every((m) => m.featureId !== "special:about")).toBe(true);
      expect(suggestFor(sample.wiki)("kubernetes")).toEqual([]);
    } finally {
      sample.repo.remove();
    }
  });
});
