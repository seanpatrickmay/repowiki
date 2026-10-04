import { SHA_A, SHA_B, SHA_C } from "@repowiki/core/test-fixtures";
import { DEFAULT_MODELS } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import {
  projectStep,
  renderProjection,
  renderReplaySummary,
  type StepRecord,
  tokensOf,
} from "./replay-cli.ts";

const step = (sha: string, subject: string) => ({ sha, subject, merge: true });
const record = (overrides: Partial<StepRecord> = {}): StepRecord => ({
  step: step(SHA_B, "Merge pull request #88 from me/x"),
  stored: 1,
  carried: 4,
  staleClaims: 0,
  tokens: 12_000,
  usd: 0.006,
  problems: 0,
  failures: [],
  refused: [],
  architectureSkipped: null,
  ...overrides,
});

describe("tokensOf", () => {
  it("counts cached tokens too", () => {
    expect(tokensOf({ in: 1, out: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
  });
});

describe("projectStep and renderProjection", () => {
  const prompts = { update: "u".repeat(2500), article: "a".repeat(2500) };

  it("costs nothing for a step that touches no page, and adds the article otherwise", () => {
    const quiet = projectStep(
      { step: step(SHA_B, "Merge branch 'x'"), files: 2, pages: 0 },
      prompts,
      30_000,
      DEFAULT_MODELS.write,
      true,
    );
    expect(quiet.usd).toBe(0);
    const loud = projectStep(
      { step: step(SHA_C, "Merge pull request #9 from me/y"), files: 5, pages: 2 },
      prompts,
      30_000,
      DEFAULT_MODELS.write,
      true,
    );
    expect(loud.usd).toBeGreaterThan(0);
    const table = renderProjection([quiet, loud], 3);
    expect(table).toContain("| 2 | ccccccc | 9 | `Merge pull request #9 from me/y` | 5 | 2 |");
    expect(table).toMatch(/2 steps estimated at \$\d+\.\d{4} at most; 3 more steps after them/);
  });
});

describe("renderReplaySummary", () => {
  it("records each step's invariants against the last full build", () => {
    const summary = renderReplaySummary("repo", SHA_A, SHA_C, [record()], 2, 500_000);
    expect(summary).toContain("1 steps replayed, 2 left; the last full build used 500,000 tokens.");
    expect(summary).toContain(
      "| 1 | bbbbbbb | 88 | `Merge pull request #88 from me/x` | 1 | 4 | 0 | 12,000 | $0.0060 | 0 | yes |",
    );
    expect(summary).toContain("Invariants: hold for every step.");
    expect(summary.trimEnd().split("\n").at(-1)).toBe("Cost: $0.0060.");
  });

  it("says the invariants broke when a step left problems or outspent the build", () => {
    expect(renderReplaySummary("r", SHA_A, SHA_C, [record({ problems: 1 })], 0, null)).toContain(
      "Invariants: **broken**",
    );
    const costly = renderReplaySummary(
      "r",
      SHA_A,
      SHA_C,
      [record({ tokens: 600_000 })],
      0,
      500_000,
    );
    expect(costly).toContain("| **no** |");
    expect(costly).toContain("Invariants: **broken**");
  });

  it("lists each step's failed pages, refused rewrites and article skip reason below the table", () => {
    const summary = renderReplaySummary(
      "r",
      SHA_A,
      SHA_C,
      [
        record({
          failures: [{ featureId: "auth", failure: "no valid answer\n| x" }],
          refused: [
            { featureId: "billing", why: "kept no claims" },
            { featureId: "search", why: "nothing changed" },
          ],
          architectureSkipped: "current",
        }),
        record({
          step: step(SHA_C, "Merge pull request #9 from me/y"),
          architectureSkipped: "too few pages",
        }),
        record({ step: step(SHA_C, "Merge pull request #10 from me/z") }),
      ],
      0,
      null,
    );
    expect(summary).toContain("## Step notes");
    expect(summary).toContain(
      "- Step 1 (bbbbbbb): 1 whole page could not be written: `auth` (`no valid answer | x`); not updated: `billing` (`kept no claims`), `search` (`unchanged`); About article: already current; no call.",
    );
    expect(summary).toContain("- Step 2 (ccccccc): About article: skipped: fewer than two pages.");
    expect(summary).not.toContain("Step 3 (");
    expect(renderReplaySummary("r", SHA_A, SHA_C, [record()], 0, null)).not.toContain("Step notes");
  });

  it("keeps a hostile subject on one row", () => {
    const hostile = record({ step: step(SHA_B, "a | b\n| c `d`") });
    const row = renderReplaySummary("r", SHA_A, SHA_C, [hostile], 0, null)
      .split("\n")
      .find((line) => line.startsWith("| 1 |"));
    expect(row?.split(" | ")).toHaveLength(11);
  });
});
