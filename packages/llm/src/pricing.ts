import type { TokenUsage } from "@repowiki/core";

/** USD per million tokens. Cache writes are the 5-minute TTL rate, the only TTL RepoWiki uses. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** A model's prices, and the dearer ones it charges for a prompt past `aboveTokens`, if any. */
export interface ModelPricing extends ModelPrice {
  longPrompt?: { aboveTokens: number; price: ModelPrice };
}

/** From https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-20). */
export const MODEL_PRICES: Readonly<Record<string, ModelPricing>> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    longPrompt: {
      aboveTokens: 100_000,
      price: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
    },
  },
};

/** The Message Batches API bills every token class at half price; it stacks with caching. */
export const BATCH_PRICE_FACTOR = 0.5;

/** The table's own entry for `id`: never an Object.prototype key such as "constructor". */
const ownPrice = (id: string): ModelPricing | undefined =>
  Object.hasOwn(MODEL_PRICES, id) ? MODEL_PRICES[id] : undefined;

/**
 * Price for a model id, accepting dated ids ("claude-haiku-4-5-20251001"), for a prompt of
 * `promptTokens` input tokens, cached or not; null if unknown.
 */
export function priceFor(model: string, promptTokens = 0): ModelPrice | null {
  const pricing = ownPrice(model) ?? ownPrice(model.replace(/-\d{8}$/, ""));
  if (pricing === undefined) return null;
  const { longPrompt, ...price } = pricing;
  return longPrompt !== undefined && promptTokens > longPrompt.aboveTokens
    ? longPrompt.price
    : price;
}

/** Dollar cost of one call, or null when the model has no known price. */
export function callCostUsd(model: string, tokens: TokenUsage, batch: boolean): number | null {
  const price = priceFor(model, tokens.in + tokens.cacheRead + tokens.cacheWrite);
  if (price === null) return null;
  const perMillion =
    tokens.in * price.input +
    tokens.out * price.output +
    tokens.cacheWrite * price.cacheWrite +
    tokens.cacheRead * price.cacheRead;
  return (perMillion / 1_000_000) * (batch ? BATCH_PRICE_FACTOR : 1);
}
