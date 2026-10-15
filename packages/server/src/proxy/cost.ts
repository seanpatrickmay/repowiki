import { BATCH_PRICE_FACTOR, priceFor } from "@repowiki/llm";
import { z } from "zod";

/** Anthropic's `usage` block, as messages and batch results report it. */
export const AnthropicUsage = z.object({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  cache_read_input_tokens: z.int().nonnegative().nullish(),
  cache_creation_input_tokens: z.int().nonnegative().nullish(),
});
export type AnthropicUsage = z.infer<typeof AnthropicUsage>;

/**
 * The share of `max_tokens` a request reserves (spec 2 S11, M14c A2): the knob between refusing
 * requests that would fit and letting in-flight requests pass the cap by their unreserved output.
 */
export const OUTPUT_RESERVE_SHARE = 0.25;

/** Prices are USD per million tokens, which is micro-dollars per token. Rounded up, never down. */
const micros = (perToken: number, batch: boolean) =>
  Math.ceil(perToken * (batch ? BATCH_PRICE_FACTOR : 1) - 1e-6);

/**
 * What a request reserves before it is forwarded: its counted input tokens at the cache-write rate
 * (the dearest input rate) plus OUTPUT_RESERVE_SHARE of `maxTokens` at the output rate, halved for
 * a batch. Null for a model with no price.
 */
export function reserveMicros(
  model: string,
  inputTokens: number,
  maxTokens: number,
  batch: boolean,
): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const input = inputTokens * Math.max(price.input, price.cacheWrite);
  return micros(input + maxTokens * OUTPUT_RESERVE_SHARE * price.output, batch);
}

/** What a call actually cost, in micro-dollars rounded up; null for a model with no price. */
export function actualMicros(model: string, usage: AnthropicUsage, batch: boolean): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  return micros(
    usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite,
    batch,
  );
}
