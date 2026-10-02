import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { RunKind, TokenUsage } from "@repowiki/core";
import { type BatchJournal, type BatchProgress, canonicalJson, createBatcher } from "./batcher.ts";
import type { FetchLike } from "./cassette.ts";
import type { TokenLedger } from "./ledger.ts";
import {
  type GenerateRequest,
  LlmError,
  LlmOutputError,
  type ModelConfig,
  type Provider,
} from "./provider.ts";

export interface ClaudeProviderOptions {
  models: ModelConfig;
  ledger: TokenLedger;
  runId: string;
  /** Stamped on every ledger entry, so §6.4 can total a build's or an update's tokens by sha. */
  run?: { kind: RunKind; sha: string };
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Replaces global fetch, e.g. with a cassette in tests. */
  fetch?: FetchLike;
  /** Wait between batch status polls. Default 30 seconds. */
  pollIntervalMs?: number;
  onBatchProgress?: (progress: BatchProgress) => void;
  /** Called with each Message Batch's id as soon as it is created, e.g. to log it. */
  onBatchCreated?: (batch: { id: string; requests: number }) => void;
  /** Cancel a batch still running this long after its creation. Default: no deadline. */
  batchDeadlineMs?: number;
  /** Records which batch holds each request, so a rerun collects answers it already paid for. */
  batchJournal?: BatchJournal;
  now?: () => Date;
}

function usageOf(message: Message): TokenUsage {
  return {
    in: message.usage.input_tokens,
    out: message.usage.output_tokens,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
  };
}

/** Schema issues listed in an LlmOutputError (and so in a retry prompt); the rest are counted. */
export const MAX_REPORTED_ISSUES = 10;
const MAX_ISSUE_LENGTH = 200;

/** At most MAX_REPORTED_ISSUES issues, each cut to 200 characters, then "and N more". */
function schemaIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const text = `${issue.path.map(String).join(".")}: ${issue.message}`;
    return text.length <= MAX_ISSUE_LENGTH ? text : `${text.slice(0, MAX_ISSUE_LENGTH)}…`;
  });
  const more = issues.length - shown.length;
  return [...shown, ...(more > 0 ? [`and ${more} more issues`] : [])].join("; ");
}

/**
 * The Claude API provider. Output is structured JSON (output_config.format, which Haiku 4.5
 * supports); no thinking is requested. A cacheKey puts a cache breakpoint on the system prompt.
 */
export function createClaudeProvider(options: ClaudeProviderOptions): Provider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LlmError("ANTHROPIC_API_KEY is not set; run with node --env-file=.env");
  }
  // The SDK retries 429, 5xx, and network errors with backoff: 1 try + 2 retries = spec §6.3.
  const client = new Anthropic({ apiKey, maxRetries: 2, fetch: options.fetch });
  const batcher = createBatcher(client, {
    pollIntervalMs: options.pollIntervalMs ?? 30_000,
    onProgress: options.onBatchProgress,
    onBatchCreated: options.onBatchCreated,
    deadlineMs: options.batchDeadlineMs,
    journal: options.batchJournal,
  });
  const now = options.now ?? (() => new Date());
  const prefixes = new Map<string, string>();

  return {
    async generate<T>(request: GenerateRequest<T>) {
      const model = options.models[request.purpose];
      const { type, schema } = zodOutputFormat(request.schema);
      if (request.cacheKey !== undefined) {
        // Everything that breaks the cache: the model, the output format, and the system text.
        const prefix = createHash("sha256")
          .update(`${model}\0${canonicalJson(schema)}\0${request.system}`)
          .digest("hex");
        const seen = prefixes.get(request.cacheKey);
        if (seen !== undefined && seen !== prefix) {
          throw new LlmError(`cacheKey ${request.cacheKey} was reused with a different prefix`);
        }
        prefixes.set(request.cacheKey, prefix);
      }
      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: request.maxTokens,
        system: [
          {
            type: "text",
            text: request.system,
            ...(request.cacheKey === undefined ? {} : { cache_control: { type: "ephemeral" } }),
          },
        ],
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { format: { type, schema } },
      };
      const batch = request.batch === true;
      const message = batch ? await batcher(params) : await client.messages.create(params);
      const usage = usageOf(message);
      options.ledger.record({
        runId: options.runId,
        at: now().toISOString(),
        purpose: request.purpose,
        model: message.model,
        featureId: request.featureId ?? null,
        batch,
        cacheKey: request.cacheKey ?? null,
        tokens: usage,
        ...(options.run === undefined ? {} : { runKind: options.run.kind, sha: options.run.sha }),
      });
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (message.stop_reason !== "end_turn") {
        throw new LlmOutputError(`model stopped with ${message.stop_reason}`, text);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmOutputError("model output is not JSON", text);
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        throw new LlmOutputError(
          `model output does not match the schema: ${schemaIssues(parsed.error.issues)}`,
          text,
        );
      }
      return { output: parsed.data, usage, model: message.model };
    },
  };
}
