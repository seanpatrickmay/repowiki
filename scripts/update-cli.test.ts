import { makeManifest, makeRevision, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import type { WikiUpdate } from "@repowiki/engine";
import { DEFAULT_MODELS } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { CliError } from "./manifest-cli.ts";
import {
  ASSUMED_UPDATE_OUTPUT_TOKENS,
  estimateUpdate,
  parseReplayArgs,
  parseUpdateArgs,
  renderUpdateSummary,
  UPDATE_USAGE,
} from "./update-cli.ts";

describe("parseUpdateArgs and parseReplayArgs", () => {
  it("read their positionals and wiki:build's flags in any order", () => {
    expect(parseUpdateArgs(["--dry-run", "../repo", "abc1234"])).toMatchObject({
      repo: "../repo",
      rev: "abc1234",
      dryRun: true,
      batch: true,
      budgetTokens: 30_000,
      verbose: false,
    });
    expect(parseReplayArgs(["../repo", "a1", "b2", "--limit", "3", "--verbose"])).toMatchObject({
      repo: "../repo",
      from: "a1",
      to: "b2",
      limit: 3,
      verbose: true,
    });
    expect(parseReplayArgs(["../repo", "a1", "b2"]).limit).toBeNull();
  });

  it("refuses a missing or empty positional, and --limit outside replay", () => {
    expect(() => parseUpdateArgs(["../repo"])).toThrow(new CliError(UPDATE_USAGE));
    expect(() => parseUpdateArgs(["../repo", ""])).toThrow("<rev> must not be empty");
    expect(() => parseUpdateArgs(["../repo", "x", "--limit", "2"])).toThrow("bad option --limit");
    expect(() => parseReplayArgs(["r", "a", "b", "--limit", "0"])).toThrow(
      "--limit must be a positive integer",
    );
  });
});

describe("estimateUpdate", () => {
  it("prices every call's prefix and pack with assumed answers, halved when batched", () => {
    const input = {
      rewrites: [{ tokens: 3000 }, { tokens: 2000 }],
      updateSystem: "u".repeat(2500),
      whole: [],
      writeSystem: "w".repeat(2500),
      disputed: false,
      drifted: true,
      article: null,
    };
    const batched = estimateUpdate(input, DEFAULT_MODELS, true);
    expect(batched).toMatchObject({
      rewrites: 2,
      whole: 0,
      small: 1,
      inputTokens: 3000 + 1000 + 2000 + 1000 + 8000,
      outputTokens: 2 * ASSUMED_UPDATE_OUTPUT_TOKENS + 1000,
      articleUsd: null,
    });
    const direct = estimateUpdate(input, DEFAULT_MODELS, false);
    expect(direct.usd).toBeCloseTo(batched.usd * 2, 10);
    const withArticle = estimateUpdate(
      { ...input, article: { system: "a", budgetTokens: 30_000 } },
      DEFAULT_MODELS,
      true,
    );
    expect(withArticle.articleUsd).toBeGreaterThan(0);
  });
});

describe("estimateUpdate by role", () => {
  const input = {
    rewrites: [{ tokens: 3000 }],
    updateSystem: "u",
    whole: [],
    writeSystem: "w",
    disputed: false,
    drifted: false,
    article: null,
  };
  const unpriced = "claude-unpriced";

  it("prices the tie-break call at the tieBreak model and the drift call at the manifest model", () => {
    const models = { ...DEFAULT_MODELS, tieBreak: unpriced, manifest: unpriced };
    // Neither call is made, so neither model is asked for a price.
    expect(estimateUpdate(input, models, true).usd).toBeGreaterThan(0);
    expect(() => estimateUpdate({ ...input, disputed: true }, models, true)).toThrow(
      `no price for model ${unpriced}`,
    );
    expect(() => estimateUpdate({ ...input, drifted: true }, models, true)).toThrow(
      `no price for model ${unpriced}`,
    );
    const onlyManifest = { ...DEFAULT_MODELS, manifest: unpriced };
    expect(estimateUpdate({ ...input, disputed: true }, onlyManifest, true).small).toBe(1);
  });

  it("prices the update, whole-page and article calls at the write model", () => {
    const models = { ...DEFAULT_MODELS, write: unpriced };
    expect(() => estimateUpdate(input, models, true)).toThrow(`no price for model ${unpriced}`);
    expect(() =>
      estimateUpdate({ ...input, rewrites: [], whole: [{ tokens: 1 }] }, models, true),
    ).toThrow(`no price for model ${unpriced}`);
    expect(() =>
      estimateUpdate(
        { ...input, rewrites: [], article: { system: "a", budgetTokens: 1 } },
        models,
        true,
      ),
    ).toThrow(`no price for model ${unpriced}`);
    // Only small calls, priced at their own roles: the write model is never asked.
    expect(
      estimateUpdate({ ...input, rewrites: [], disputed: true, drifted: true }, models, true).usd,
    ).toBeGreaterThan(0);
  });
});

describe("renderUpdateSummary", () => {
  const stored = makeRevision({ id: "signals-2", sha: SHA_B, reason: "update", parentId: "r" });
  const update = {
    from: SHA_A,
    to: SHA_B,
    pr: 12,
    commits: 3,
    changes: 4,
    manifest: makeManifest(),
    revised: false,
    tieBreak: { placed: new Map([["src/x.py", "signals"]]), calls: 1, fallback: 0 },
    drift: null,
    rewrites: [],
    written: null,
    stored: [stored],
    carried: ["deliverables"],
    staleClaims: 1,
    failures: [],
    refused: [],
    articleDue: null,
    architectureSkipped: "current",
    architecture: null,
  } as unknown as WikiUpdate;
  const totals = {
    calls: 2,
    batchCalls: 2,
    tokens: { in: 9000, out: 800, cacheRead: 0, cacheWrite: 0 },
    usd: 0.0061,
    unpricedCalls: 0,
  };

  it("names the move, the PR, each stored page and the cost", () => {
    const summary = renderUpdateSummary("repo", update, null, totals);
    expect(summary.split("\n")[0]).toBe("# Update: `repo` aaaaaaa → bbbbbbb");
    expect(summary).toContain(
      "PR #12; 3 new commits, 4 files changed; no feature drifted; 1 new files settled by the tie-break.",
    );
    expect(summary).toContain("1 pages stored, 1 carried forward, 1 claims marked out of date.");
    expect(summary).toContain("| `signals` | update | 2 | 0 | stored |");
    expect(summary).toContain("| About article | 0 | 0 | 0 | already current; no call |");
    expect(summary.trimEnd().split("\n").at(-1)).toBe("Cost: $0.0061.");
  });

  it("gives every failed whole page a row with its failure as a code span", () => {
    const failed = {
      ...update,
      failures: [
        { featureId: "billing", failure: "the answer | had no `claims`" },
        { featureId: "invoices", failure: "the call was refused" },
      ],
    } as unknown as WikiUpdate;
    const summary = renderUpdateSummary("repo", failed, null, totals);
    expect(summary).toContain("2 whole pages could not be written and are not stored.");
    expect(summary).toContain(
      "| `billing` | whole | 0 | 0 | `` the answer \\| had no `claims` `` |",
    );
    expect(summary).toContain("| `invoices` | whole | 0 | 0 | `the call was refused` |");
    expect(renderUpdateSummary("repo", update, null, totals)).not.toContain("could not be written");
  });

  it("gives a failed About article its row, and the page rows stay", () => {
    const failed = {
      ...update,
      architecture: {
        architecture: null,
        failure: "no lead or no body claim survived verification",
        dropped: [],
        calls: 2,
        tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
      },
    } as unknown as WikiUpdate;
    const summary = renderUpdateSummary("repo", failed, null, totals);
    expect(summary).toContain(
      "| About article | 0 | 0 | 2 | `no lead or no body claim survived verification` |",
    );
    expect(summary).not.toContain("already current");
    expect(summary).toContain("| `signals` | update | 2 | 0 | stored |");
  });

  it("says a one-page wiki has too few pages for an article, not that it is current", () => {
    const small = { ...update, architectureSkipped: "too few pages" } as unknown as WikiUpdate;
    const summary = renderUpdateSummary("repo", small, null, totals);
    expect(summary).toContain("| About article | 0 | 0 | 0 | skipped: fewer than two pages |");
    expect(summary).not.toContain("already current");
  });

  it("shows why the assembler refused a rewrite, and the claims it kept stale", () => {
    const refused = {
      ...update,
      rewrites: [
        { featureId: "billing", keptStale: ["c1", "c2"], failure: null },
        { featureId: "invoices", keptStale: [], failure: null },
        { featureId: "signals", keptStale: [], failure: null },
      ],
      refused: [
        { featureId: "billing", why: "links to nowhere: [[ghost]] | here" },
        { featureId: "invoices", why: "nothing changed" },
      ],
    } as unknown as WikiUpdate;
    const summary = renderUpdateSummary("repo", refused, null, totals);
    expect(summary).toContain(
      "| `billing` | update | 0 | 2 | `links to nowhere: [[ghost]] \\| here` |",
    );
    expect(summary).toContain("| `invoices` | update | 0 | 0 | `unchanged` |");
    // A stored rewrite is not a refused one.
    expect(summary).toContain("| `signals` | update | 2 | 0 | stored |");
    expect(summary).not.toContain("| `signals` | update | 0 | 0 |");
  });
});
