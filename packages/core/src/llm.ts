import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { IsoDateTime } from "./primitives.ts";
import { TokenUsage } from "./revision.ts";

/** What an LLM call is for. Each role has its own model id in config (spec §4). */
export const LlmRole = z.enum(["manifest", "write", "tieBreak", "evalAgent", "evalJudge"]);
export type LlmRole = z.infer<typeof LlmRole>;

/** One provider call, as recorded in the TokenLedger and stored by the store. */
export const LedgerEntry = z.object({
  /** Groups the calls of one CLI run (build, update, manifest:build). */
  runId: z.string().min(1),
  at: IsoDateTime,
  purpose: LlmRole,
  /** The model id the API reported, e.g. "claude-haiku-4-5-20251001". */
  model: z.string().min(1),
  featureId: FeatureId.nullable(),
  /** True when the call went through the Message Batches API (billed at 50%). */
  batch: z.boolean(),
  cacheKey: z.string().min(1).nullable(),
  tokens: TokenUsage,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** A config file's LLM section: per-role model id overrides; unnamed roles keep the default. */
export const LlmConfigFile = z.strictObject({
  models: z.partialRecord(LlmRole, z.string().min(1)).default({}),
});
export type LlmConfigFile = z.infer<typeof LlmConfigFile>;
