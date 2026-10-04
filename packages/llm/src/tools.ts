import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { LlmRole, TokenUsage } from "@repowiki/core";
import type { FetchLike } from "./cassette.ts";
import type { TokenLedger } from "./ledger.ts";
import { LlmError, type ModelConfig } from "./provider.ts";

/** A tool the model may call: its name, what it does, and its input's JSON schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError: boolean;
}

export type TurnBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TurnMessage {
  role: "user" | "assistant";
  content: readonly TurnBlock[];
}

export interface TurnRequest {
  purpose: LlmRole;
  system: string;
  tools: readonly ToolDefinition[];
  messages: readonly TurnMessage[];
  maxTokens: number;
  /** "auto": the model may call at most one tool this turn; "none": it must answer in text. */
  toolChoice: "auto" | "none";
  /**
   * Put a cache breakpoint on the last block, so the next turn of the conversation reads this
   * prefix from the cache. A prefix under the model's minimum (4,096 tokens on Haiku 4.5) is
   * simply not cached.
   */
  cache: boolean;
  temperature?: number;
}

export interface TurnResult {
  /** The model's text and tool calls, in order. */
  content: (TextBlock | ToolUseBlock)[];
  /** Why the model stopped ("end_turn", "tool_use", "max_tokens", …), or null if unreported. */
  stopReason: string | null;
  usage: TokenUsage;
  /** The model id the API reported. */
  model: string;
}

/**
 * One model turn of a tool-use conversation, for the eval's agents (spec §9). A sibling of
 * Provider, which returns structured output only: an agent's turns depend on each other, so they
 * are never batched.
 */
export interface ToolProvider {
  turn(request: TurnRequest): Promise<TurnResult>;
}

export interface ToolProviderOptions {
  models: ModelConfig;
  ledger: TokenLedger;
  runId: string;
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Replaces global fetch, e.g. with a cassette in tests. */
  fetch?: FetchLike;
  now?: () => Date;
}

/**
 * Every text the provider sends goes through `toWellFormed()`: a lone surrogate (half of an astral
 * character, left by a cut that counted UTF-16 units) becomes U+FFFD, as the API refuses it.
 */
function blockParam(block: TurnBlock): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text.toWellFormed() };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content.toWellFormed(),
        ...(block.isError ? { is_error: true } : {}),
      };
  }
}

/** The request's messages as API params; empty text blocks are left out, as the API refuses them. */
function messageParams(request: TurnRequest): MessageParam[] {
  const messages = request.messages.map((message, index) => {
    const content = message.content
      .filter((block) => block.type !== "text" || block.text !== "")
      .map(blockParam);
    if (content.length === 0) throw new LlmError(`message ${index} has no content`);
    return { role: message.role, content };
  });
  const last = messages.at(-1)?.content.at(-1);
  if (request.cache && last !== undefined) {
    Object.assign(last, { cache_control: { type: "ephemeral" } });
  }
  return messages;
}

/**
 * The Claude API tool-use provider: the role's model, the tools, at most one tool call per turn
 * (so a turn limit bounds the tool calls), and one ledger row per turn. No thinking is requested.
 */
export function createClaudeToolProvider(options: ToolProviderOptions): ToolProvider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LlmError("ANTHROPIC_API_KEY is not set; run with node --env-file=.env");
  }
  // The SDK retries 429, 5xx, and network errors with backoff: 1 try + 2 retries = spec §6.3.
  const client = new Anthropic({ apiKey, maxRetries: 2, fetch: options.fetch });
  const now = options.now ?? (() => new Date());
  return {
    async turn(request) {
      const params: MessageCreateParamsNonStreaming = {
        model: options.models[request.purpose],
        max_tokens: request.maxTokens,
        system: [{ type: "text", text: request.system.toWellFormed() }],
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description.toWellFormed(),
          input_schema: tool.inputSchema,
        })),
        tool_choice:
          request.toolChoice === "none"
            ? { type: "none" }
            : { type: "auto", disable_parallel_tool_use: true },
        messages: messageParams(request),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      };
      const message = await client.messages.create(params);
      const usage: TokenUsage = {
        in: message.usage.input_tokens,
        out: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      };
      options.ledger.record({
        runId: options.runId,
        at: now().toISOString(),
        purpose: request.purpose,
        model: message.model,
        featureId: null,
        batch: false,
        cacheKey: null,
        tokens: usage,
      });
      const content = message.content.flatMap((block): (TextBlock | ToolUseBlock)[] => {
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "tool_use") {
          return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
        }
        return [];
      });
      return { content, stopReason: message.stop_reason, usage, model: message.model };
    },
  };
}
