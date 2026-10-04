import type { TokenUsage } from "@repowiki/core";

/** USD per million tokens. Cache writes are the 5-minute TTL rate, the only TTL RepoWiki uses. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** From https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-01). */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** The Message Batches API bills every token class at half price; it stacks with caching. */
export const BATCH_PRICE_FACTOR = 0.5;

/** Price for a model id, accepting dated ids ("claude-haiku-4-5-20251001"); null if unknown. */
export function priceFor(model: string): ModelPrice | null {
  return MODEL_PRICES[model] ?? MODEL_PRICES[model.replace(/-\d{8}$/, "")] ?? null;
}

/** Dollar cost of one call, or null when the model has no known price. */
export function callCostUsd(model: string, tokens: TokenUsage, batch: boolean): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const perMillion =
    tokens.in * price.input +
    tokens.out * price.output +
    tokens.cacheWrite * price.cacheWrite +
    tokens.cacheRead * price.cacheRead;
  return (perMillion / 1_000_000) * (batch ? BATCH_PRICE_FACTOR : 1);
}
