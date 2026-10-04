import { LlmConfigFile, type LlmRole, type TokenUsage } from "@repowiki/core";
import type { z } from "zod";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest<T> {
  purpose: LlmRole;
  featureId?: string | null;
  /**
   * The stable prefix: instructions plus any shared context. With a cacheKey it is prompt-cached,
   * so it must be byte-identical across calls that share the key.
   */
  system: string;
  /** The varying part of the prompt, after the cached prefix. */
  messages: readonly LlmMessage[];
  /** The output must be a JSON object matching this schema. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Names the cached prefix. Calls sharing a key must send the same system text and model. */
  cacheKey?: string;
  /** Route through the Message Batches API (50% price, answer within 24h). */
  batch?: boolean;
}

export interface GenerateResult<T> {
  output: T;
  usage: TokenUsage;
  /** The model id the API reported. */
  model: string;
}

export interface Provider {
  generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The model answered, but not with valid output. Its tokens are already in the ledger. */
export class LlmOutputError extends LlmError {
  /** The raw text the model returned, for a retry prompt. */
  readonly text: string;

  constructor(message: string, text: string) {
    super(message);
    this.text = text;
  }
}

export type ModelConfig = Readonly<Record<LlmRole, string>>;

/** Every role defaults to the cheapest current model (spec §4). */
export const DEFAULT_MODELS: ModelConfig = {
  manifest: "claude-haiku-4-5",
  write: "claude-haiku-4-5",
  tieBreak: "claude-haiku-4-5",
  evalAgent: "claude-haiku-4-5",
  evalJudge: "claude-haiku-4-5",
};

/** Merges a parsed config file over the defaults; throws a ZodError on an invalid file. */
export function resolveModels(configFile: unknown = {}): ModelConfig {
  return { ...DEFAULT_MODELS, ...LlmConfigFile.parse(configFile).models };
}
