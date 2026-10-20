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
    // Only the table's own ids: a prototype key is no model.
    for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty-20251001"])
      expect(priceFor(id), id).toBeNull();
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

  it("prices Haiku 5.5 at its short-prompt rate up to 100,000 prompt tokens and its long rate past it", () => {
    const short = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 };
    const long = { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 };
    expect(priceFor("claude-haiku-5-5")).toEqual(short);
    expect(priceFor("claude-haiku-5-5", 100_000)).toEqual(short);
    expect(priceFor("claude-haiku-5-5", 100_001)).toEqual(long);
    // Haiku 4.5 has one rate whatever the prompt.
    expect(priceFor("claude-haiku-4-5", 500_000)).toEqual(priceFor("claude-haiku-4-5"));
    // The prompt is every input token, cached or not.
    const cached = { in: 10_000, out: 1_000_000, cacheRead: 60_000, cacheWrite: 40_000 };
    expect(callCostUsd("claude-haiku-5-5", cached, false)).toBeCloseTo(
      (10_000 * 0.5 + 1_000_000 * 2.5 + 60_000 * 0.05 + 40_000 * 0.625) / 1e6,
      10,
    );
    const small = { in: 50_000, out: 1000, cacheRead: 0, cacheWrite: 0 };
    expect(callCostUsd("claude-haiku-5-5", small, true)).toBeCloseTo(
      ((50_000 * 0.1 + 1000 * 0.5) / 1e6) * 0.5,
      10,
    );
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
  it("defaults every role but the eval agent to Haiku 5.5 and applies per-role overrides", () => {
    const { evalAgent, ...rest } = DEFAULT_MODELS;
    expect(Object.values(rest)).toEqual(Array(7).fill("claude-haiku-5-5"));
    expect(evalAgent).toBe("claude-haiku-4-5");
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
    // The kind is part of the key: an update to a sha a build was at is a run of its own.
    const both = runTotals([...entries, at("update", SHA_A, 7)]);
    expect(both.map((r) => [r.kind, r.sha, r.tokens.in])).toEqual([
      ["build", SHA_A, 30],
      ["update", SHA_B, 5],
      ["update", SHA_A, 7],
    ]);
    // A row with only one of the two run fields is left out too.
    expect(runTotals([at("build", undefined, 1), at(undefined, SHA_A, 1)])).toEqual([]);
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

  it("counts an answer a resumed run collected through the journal once, with the run that paid", () => {
    const row = (runId: string, requestKey: string, n: number, collected = false) =>
      makeLedgerEntry({
        runId,
        batch: true,
        runKind: "update",
        sha: SHA_B,
        requestKey,
        ...(collected ? { collected: true } : {}),
        tokens: { in: n, out: 0, cacheRead: 0, cacheWrite: 0 },
      });
    const entries = [
      // The killed run read its tie-break and round-1 answers, then stopped before storing.
      row("update-1", "tie-break", 10),
      row("update-1", "signals", 100),
      // The resumed run collects both from the journal, then pays for its retry.
      row("update-2", "tie-break", 10, true),
      row("update-2", "signals", 100, true),
      row("update-2", "signals-retry", 50),
    ];
    expect(runTotals(entries)).toEqual([
      {
        kind: "update",
        sha: SHA_B,
        calls: 3,
        tokens: { in: 160, out: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("counts a collected answer no earlier row paid for: its run was killed before reading it", () => {
    const entries = [
      makeLedgerEntry({
        runId: "update-2",
        batch: true,
        runKind: "update",
        sha: SHA_B,
        requestKey: "signals",
        collected: true,
        tokens: { in: 100, out: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    expect(runTotals(entries).map((r) => r.calls)).toEqual([1]);
  });
});
