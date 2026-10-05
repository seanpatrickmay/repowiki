import { z } from "zod";
import { FeatureId } from "./feature.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { TokenUsage } from "./revision.ts";

/**
 * What an LLM call is for. Each role has its own model id in config (spec §4). `ask` is the Ask
 * sidebar's (spec v2 #4 R13): its calls are ledgered in memory per serve session, never stored.
 */
export const LlmRole = z.enum(["manifest", "write", "tieBreak", "evalAgent", "evalJudge", "ask"]);
export type LlmRole = z.infer<typeof LlmRole>;

/**
 * What a run did: a full build (manifest and pages) or an update (spec §6.4 compares the two).
 * Ledger rows written before M4 have no run kind.
 */
export const RunKind = z.enum(["build", "update"]);
export type RunKind = z.infer<typeof RunKind>;

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
  /** The kind of run that made the call; absent on rows written before M4. */
  runKind: RunKind.optional(),
  /** The commit the run built or updated to; absent on rows written before M4. */
  sha: GitSha.optional(),
  /**
   * A batched call's request key (the batch journal's): a later run that collects the same answer
   * through the journal records the same key. Absent on unbatched calls and older rows.
   */
  requestKey: z.string().min(1).optional(),
  /** True when the answer was collected from an earlier run's batch: that run paid for it. */
  collected: z.boolean().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** A config file's LLM section: per-role model id overrides; unnamed roles keep the default. */
export const LlmConfigFile = z.strictObject({
  models: z.partialRecord(LlmRole, z.string().min(1)).default({}),
});
export type LlmConfigFile = z.infer<typeof LlmConfigFile>;
