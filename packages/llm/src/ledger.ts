import { LedgerEntry, type RunTotal, type TokenUsage } from "@repowiki/core";
import { callCostUsd } from "./pricing.ts";

export interface LedgerTotals {
  calls: number;
  batchCalls: number;
  tokens: TokenUsage;
  /** Sum over priced calls. */
  usd: number;
  /** Calls whose model has no known price; their tokens are counted but not their cost. */
  unpricedCalls: number;
}

/** Records every provider call (spec §4, F25). */
export interface TokenLedger {
  record(entry: LedgerEntry): void;
  entries(): LedgerEntry[];
  totals(): LedgerTotals;
}

/** An in-memory ledger; `sink` also receives each validated entry (e.g. store.appendLedger). */
export function createLedger(sink?: (entry: LedgerEntry) => void): TokenLedger {
  const recorded: LedgerEntry[] = [];
  return {
    record(entry) {
      const parsed = LedgerEntry.parse(entry);
      sink?.(parsed);
      recorded.push(parsed);
    },
    entries: () => [...recorded],
    totals: () => totalsOf(recorded),
  };
}

export function totalsOf(entries: readonly LedgerEntry[]): LedgerTotals {
  const totals: LedgerTotals = {
    calls: 0,
    batchCalls: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    usd: 0,
    unpricedCalls: 0,
  };
  for (const entry of entries) {
    totals.calls++;
    if (entry.batch) totals.batchCalls++;
    totals.tokens.in += entry.tokens.in;
    totals.tokens.out += entry.tokens.out;
    totals.tokens.cacheRead += entry.tokens.cacheRead;
    totals.tokens.cacheWrite += entry.tokens.cacheWrite;
    const usd = callCostUsd(entry.model, entry.tokens, entry.batch);
    if (usd === null) totals.unpricedCalls++;
    else totals.usd += usd;
  }
  return totals;
}

/**
 * Calls and tokens per run (spec §6.4), keyed by the run kind and sha the rows carry, in the order
 * each run first appears. Rows without a run kind or sha (written before M4) are left out.
 */
export function runTotals(entries: readonly LedgerEntry[]): RunTotal[] {
  const runs = new Map<string, RunTotal>();
  for (const entry of entries) {
    if (entry.runKind === undefined || entry.sha === undefined) continue;
    const key = `${entry.runKind}\0${entry.sha}`;
    const run = runs.get(key) ?? {
      kind: entry.runKind,
      sha: entry.sha,
      calls: 0,
      tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    };
    run.calls++;
    run.tokens.in += entry.tokens.in;
    run.tokens.out += entry.tokens.out;
    run.tokens.cacheRead += entry.tokens.cacheRead;
    run.tokens.cacheWrite += entry.tokens.cacheWrite;
    runs.set(key, run);
  }
  return [...runs.values()];
}
