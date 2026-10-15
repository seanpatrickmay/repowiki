import { z } from "zod";

/**
 * The most output a proxied request may ask for: the engine's largest call (the manifest and the
 * architecture page, 16,000). It bounds how far in-flight requests can pass a job's cap (S11).
 */
export const MAX_PROXY_OUTPUT_TOKENS = 16_000;
/** The most requests one batch may carry; with two batches in flight it bounds a job's overshoot. */
export const MAX_BATCH_REQUESTS = 1000;

/**
 * `anthropic-beta` values the proxy passes through: the engine sets none (packages/llm), so none.
 * A beta can change billing or add server tools, which the cap does not price.
 */
export const BETA_ALLOWLIST: ReadonlySet<string> = new Set<string>();

/** A 5-minute cache breakpoint; a `ttl` (the 1-hour cache, billed at twice the input) is refused. */
const CacheControl = z.strictObject({ type: z.literal("ephemeral") });
const TextBlock = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  cache_control: CacheControl.optional(),
});
const Text = z.union([z.string(), z.array(TextBlock).min(1)]);

/**
 * Exactly what the engine sends (packages/llm `claude.ts`): text only, structured output, an
 * optional cache breakpoint. Streams, tools, server tools, images, documents, containers and
 * service tiers are refused, so nothing the reservation does not price can be bought (M14c A1).
 */
export const MessageParams = z.strictObject({
  model: z.string().min(1).max(128),
  max_tokens: z.int().min(1).max(MAX_PROXY_OUTPUT_TOKENS),
  system: Text.optional(),
  messages: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: Text })).min(1),
  output_config: z
    .strictObject({
      format: z.strictObject({
        type: z.literal("json_schema"),
        schema: z.record(z.string(), z.unknown()),
      }),
    })
    .optional(),
  temperature: z.number().min(0).max(1).optional(),
  metadata: z.strictObject({ user_id: z.string().max(256).optional() }).optional(),
});
export type MessageParams = z.infer<typeof MessageParams>;

export const BatchCreate = z.strictObject({
  requests: z
    .array(
      z.strictObject({
        custom_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        params: MessageParams,
      }),
    )
    .min(1)
    .max(MAX_BATCH_REQUESTS),
});
export type BatchCreate = z.infer<typeof BatchCreate>;

/** Null when every `anthropic-beta` value is allowed, else the first that is not. */
export function refusedBeta(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const values = [header]
    .flat()
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return values.find((v) => !BETA_ALLOWLIST.has(v)) ?? null;
}
