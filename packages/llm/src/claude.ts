import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { CONTROL_CHARACTERS, GitSha, type RunKind, type TokenUsage } from "@repowiki/core";
import type { z } from "zod";
import {
  type BatchJournal,
  type BatchProgress,
  canonicalJson,
  createBatcher,
  requestKey,
  wasCollected,
} from "./batcher.ts";
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
  run?: { kind: RunKind; sha: z.infer<typeof GitSha> };
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
  /**
   * Called with each batched request's journal key and the request's featureId before it is
   * queued, so a journal can tell whose rows it holds. A throwing hook is ignored.
   */
  onBatchRequest?: (requestKey: string, featureId: string | null) => void;
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

/** At most MAX_REPORTED_ISSUES issues, each of at most 200 code points, then "and N more". */
function schemaIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const text = `${issue.path.map(String).join(".")}: ${issue.message}`;
    // Core's CONTROL_CHARACTERS, the set the engine's prompt text uses for repository-controlled
    // strings: model-chosen keys can hold any of them, and an issue goes into a retry prompt.
    // Cut by code points, so the cut never leaves half of an astral character.
    const chars = Array.from(text.replace(CONTROL_CHARACTERS, "\uFFFD"));
    return chars.length <= MAX_ISSUE_LENGTH
      ? chars.join("")
      : `${chars.slice(0, MAX_ISSUE_LENGTH - 1).join("")}…`;
  });
  const more = issues.length - shown.length;
  return [...shown, ...(more > 0 ? [`and ${more} more issues`] : [])].join("; ");
}

/**
 * The Claude API provider. Output is structured JSON (output_config.format, which Haiku 4.5
 * supports); no thinking is requested. A cacheKey puts a cache breakpoint on the system prompt.
 */
export function createClaudeProvider(options: ClaudeProviderOptions): Provider {
  if (options.run !== undefined && !GitSha.safeParse(options.run.sha).success) {
    throw new LlmError(`run.sha must be a full 40-character git sha, got "${options.run.sha}"`);
  }
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
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      };
      const batch = request.batch === true;
      if (batch && options.onBatchRequest !== undefined) {
        try {
          options.onBatchRequest(requestKey(params), request.featureId ?? null);
        } catch {
          // An observer's bug must not stop the call.
        }
      }
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
        ...(batch ? { requestKey: requestKey(params) } : {}),
        ...(batch && wasCollected(message) ? { collected: true } : {}),
      });
      // The ledger row is written: an unusable answer below carries the same numbers.
      const answered = { usage, model: message.model };
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (message.stop_reason !== "end_turn") {
        const reason = message.stop_reason;
        throw new LlmOutputError(`model stopped with ${reason}`, text, answered, reason);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmOutputError("model output is not JSON", text, answered);
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        throw new LlmOutputError(
          `model output does not match the schema: ${schemaIssues(parsed.error.issues)}`,
          text,
          answered,
        );
      }
      return { output: parsed.data, usage, model: message.model };
    },
  };
}
