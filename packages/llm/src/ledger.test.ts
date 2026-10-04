import { makeLedgerEntry, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { createLedger, runTotals } from "./ledger.ts";
import { callCostUsd, priceFor } from "./pricing.ts";
import { DEFAULT_MODELS, resolveModels } from "./provider.ts";

const million = { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 };

describe("pricing", () => {
  it("knows Haiku 4.5 by alias and by dated id", () => {
    expect(priceFor("claude-haiku-4-5")).toEqual({
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    });
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("claude-unknown-1")).toBeNull();
  });

  it.each([
    ["input", million, false, 1],
    ["output", { ...million, in: 0, out: 1_000_000 }, false, 5],
    ["cache writes", { ...million, in: 0, cacheWrite: 1_000_000 }, false, 1.25],
    ["cache reads", { ...million, in: 0, cacheRead: 1_000_000 }, false, 0.1],
    ["batched output", { ...million, in: 0, out: 1_000_000 }, true, 2.5],
    ["batched cache reads", { ...million, in: 0, cacheRead: 1_000_000 }, true, 0.05],
  ])("prices a million tokens of %s", (_name, tokens, batch, usd) => {
    expect(callCostUsd("claude-haiku-4-5-20251001", tokens, batch)).toBeCloseTo(usd, 10);
  });
});

describe("createLedger", () => {
  it("totals tokens and dollars, and forwards each entry to the sink", () => {
    const sunk: unknown[] = [];
    const ledger = createLedger((entry) => sunk.push(entry));
    ledger.record(makeLedgerEntry({ tokens: { in: 2000, out: 400, cacheRead: 0, cacheWrite: 0 } }));
    ledger.record(
      makeLedgerEntry({
        batch: true,
        tokens: { in: 0, out: 1000, cacheRead: 10_000, cacheWrite: 0 },
      }),
    );
    ledger.record(makeLedgerEntry({ model: "mystery-model" }));
    expect(ledger.totals()).toEqual({
      calls: 3,
      batchCalls: 1,
      tokens: { in: 3000, out: 1600, cacheRead: 10_000, cacheWrite: 0 },
      usd: expect.closeTo(0.002 + 0.002 + (0.005 + 0.001) / 2, 10),
      unpricedCalls: 1,
    });
    expect(sunk).toEqual(ledger.entries());
  });

  it("rejects an invalid entry without recording it", () => {
    const ledger = createLedger();
    expect(() => ledger.record(makeLedgerEntry({ runId: "" }))).toThrow();
    expect(ledger.entries()).toEqual([]);
  });
});

describe("resolveModels", () => {
  it("defaults every role to Haiku 4.5 and applies per-role overrides", () => {
    expect(Object.values(DEFAULT_MODELS)).toEqual(Array(5).fill("claude-haiku-4-5"));
    expect(resolveModels({ models: { write: "claude-sonnet-5-5" } })).toEqual({
      ...DEFAULT_MODELS,
      write: "claude-sonnet-5-5",
    });
  });

  it("rejects an invalid config file", () => {
    expect(() => resolveModels({ models: { summarize: "x" } })).toThrow();
  });
});

describe("runTotals (spec §6.4)", () => {
  it("sums calls and tokens per run kind and sha, in the order runs first appear", () => {
    const at = (runKind: "build" | "update" | undefined, sha: string | undefined, n: number) =>
      makeLedgerEntry({
        tokens: { in: n, out: 1, cacheRead: 2, cacheWrite: 3 },
        ...(runKind === undefined ? {} : { runKind }),
        ...(sha === undefined ? {} : { sha }),
      });
    const entries = [
      at("build", SHA_A, 10),
      at("update", SHA_B, 5),
      at("build", SHA_A, 20),
      at(undefined, undefined, 99),
    ];
    expect(runTotals(entries)).toEqual([
      {
        kind: "build",
        sha: SHA_A,
        calls: 2,
        tokens: { in: 30, out: 2, cacheRead: 4, cacheWrite: 6 },
      },
      {
        kind: "update",
        sha: SHA_B,
        calls: 1,
        tokens: { in: 5, out: 1, cacheRead: 2, cacheWrite: 3 },
      },
    ]);
  });
});
