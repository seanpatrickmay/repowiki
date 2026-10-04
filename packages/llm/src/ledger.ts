import { LedgerEntry, type TokenUsage } from "@repowiki/core";
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
