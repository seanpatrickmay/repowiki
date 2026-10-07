import type { WikiExport } from "@repowiki/core";
import {
  makeGitHubSnapshot,
  makeInFlight,
  makeInFlightPull,
  makeLedgerEntry,
} from "@repowiki/core/test-fixtures";
import { callCostUsd, totalsOf } from "@repowiki/llm";
import { ABOUT_PAGE_ID, pageSearchIndex, WikiView } from "@repowiki/query";
import { extendedWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFLIGHT_USD,
  fetchLine,
  INFLIGHT_USAGE,
  inflightEstimateLine,
  inflightLeftOutLine,
  parseInflightArgs,
  readLine,
  renderInflightTable,
  spendLine,
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
    expect(parseInflightArgs(["repo", "--max-usd", "100"]).maxUsd).toBe(100);
    expect(parseInflightArgs(["repo", "--offline", "--no-llm"])).toMatchObject({
      offline: true,
      noLlm: true,
    });
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
    [["repo", "--clear", "--no-batch"], "--clear takes only --out and --verbose, not --no-batch"],
    [
      ["repo", "--clear", "--max-usd", "1"],
      "--clear takes only --out and --verbose, not --max-usd",
    ],
    [["repo", "--max-usd="], "--max-usd must not be empty"],
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

  it("totals the run's ledger rows for its spend, failed calls included", () => {
    expect(spendLine(0, totalsOf([]))).toBe("0 new summaries, $0.0000");
    // Two calls: one became a summary, one verified to nothing; both were paid for.
    const rows = [
      makeLedgerEntry({ purpose: "inflight", batch: true }),
      makeLedgerEntry({
        purpose: "inflight",
        batch: true,
        tokens: { in: 3000, out: 900, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const usd = rows.reduce((n, r) => n + (callCostUsd(r.model, r.tokens, r.batch) ?? 0), 0);
    expect(spendLine(1, totalsOf(rows))).toBe(`1 new summary, $${usd.toFixed(4)} for 2 calls`);
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
    // Never a negative count, whatever the estimate says.
    expect(inflightEstimateLine({ ...estimate, cached: 4 }, { maxUsd: 1, batch: false })).toMatch(
      /^3 pull-request summaries \(4 cached, 0 to request\)/,
    );
  });

  it("says when work in flight is left out of a rebuilt export", () => {
    const wiki = { inflight: null } as Pick<WikiExport, "inflight">;
    expect(inflightLeftOutLine(makeInFlight(), wiki)).toBe(
      "work in flight left out: rebuilt at a new revision; run wiki:inflight --offline",
    );
    expect(inflightLeftOutLine(null, wiki)).toBeNull();
    expect(inflightLeftOutLine(makeInFlight(), { inflight: makeInFlight() })).toBeNull();
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

  it("says under the table why the wiki is behind a pull request, one line for its one reason (R27)", () => {
    const pull = makeInFlightPull();
    const behind = makeInFlightPull({
      number: 14,
      closes: [],
      baseSha: "a".repeat(40),
      behind: "wiki-behind",
      merge: "unknown",
      effects: pull.effects.map((e) => ({ ...e, certain: false })),
    });
    const stacked = makeInFlightPull({
      ...behind,
      number: 16,
      baseRef: "m10/parent",
      behind: "stacked",
    });
    const unread = makeInFlightPull({
      ...behind,
      number: 15,
      baseSha: null,
      mergeBase: null,
      files: [],
      summary: null,
      effects: [],
      behind: "base-unread",
    });
    const lines = renderInflightTable(
      makeInFlight({ pulls: [behind, stacked, unread], issues: [] }),
      new Map(),
      new Map(),
    ).split("\n");
    expect(lines.slice(2)).toEqual([
      "| `#14 Page through long chunks` | `signals` | 0 (+2 may change) | none |",
      "| `#16 Page through long chunks` | `signals` | 0 (+2 may change) | none |",
      "| `#15 Page through long chunks` | `signals` | 0 | none |",
      "#14: the wiki is behind this pull request's base (aaaaaaa); run pnpm wiki:update for exact predictions",
      "#16: targets `m10/parent`, which the wiki does not describe; its predictions are may-change until `m10/parent` merges",
      "#15: its base could not be read this run; run pnpm wiki:inflight again",
    ]);
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

  it("leaves out the About article even when it is the best match", () => {
    const sample = sampleWiki();
    try {
      const wiki = extendedWiki(sample);
      const query = "demo is built from signals and deliverables";
      // The search itself finds the About article, so the filter is what keeps it out.
      const ranked = pageSearchIndex(new WikiView(wiki)).ranked(query, 3);
      expect(ranked.map((m) => m.id)).toContain(ABOUT_PAGE_ID);
      const found = suggestFor(wiki)(query);
      expect(found.length).toBeGreaterThan(0);
      expect(found.map((m) => m.featureId)).not.toContain(ABOUT_PAGE_ID);
    } finally {
      sample.repo.remove();
    }
  });
});
