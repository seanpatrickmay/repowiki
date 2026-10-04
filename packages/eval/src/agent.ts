import type { TokenUsage } from "@repowiki/core";
import {
  callCostUsd,
  type ToolProvider,
  type ToolResultBlock,
  type TurnMessage,
} from "@repowiki/llm";
import { LAST_TURN_NOTE, questionTurn } from "./prompts.ts";
import type { ToolSet } from "./tools.ts";

/** The output cap of one agent turn: a tool call, or an answer of ANSWER_WORDS words. */
export const MAX_TURN_OUTPUT_TOKENS = 1024;

/** Both agents answer at temperature 0, so a rerun of a question asks the model the same way. */
export const AGENT_TEMPERATURE = 0;

/** One tool call the agent made, for the run's record (the result itself is not kept). */
export interface ToolCall {
  turn: number;
  name: string;
  input: unknown;
  isError: boolean;
}

/**
 * How the agent stopped: it answered; it answered on the last turn, where tools are forbidden;
 * its answer was cut at the output cap; or the API stopped it for another reason (a refusal).
 */
export type AgentStop = "answered" | "turn-limit" | "max-tokens" | "other";

export interface AgentAnswer {
  answer: string;
  stop: AgentStop;
  /** Model turns taken, at most the turn limit. */
  turns: number;
  calls: ToolCall[];
  /** Every turn's tokens, summed. */
  usage: TokenUsage;
  /** The cost of every turn at its model's price, or null when a model has no price. */
  usd: number | null;
  /** The model id the API reported for the last turn (a run always takes at least one turn). */
  model: string | null;
}

export interface AgentOptions {
  provider: ToolProvider;
  system: string;
  tools: ToolSet;
  question: string;
  turnLimit: number;
}

const sum = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  in: a.in + b.in,
  out: a.out + b.out,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

/** The conversation with LAST_TURN_NOTE after the last user turn's blocks (a copy). */
function withLastTurnNote(messages: readonly TurnMessage[]): TurnMessage[] {
  const final = messages.at(-1) as TurnMessage;
  const note = { type: "text" as const, text: LAST_TURN_NOTE };
  return [...messages.slice(0, -1), { role: final.role, content: [...final.content, note] }];
}

/**
 * Runs one agent on one question: a tool-use loop of at most `turnLimit` model turns, each with
 * at most one tool call. The last turn forbids tools, so every run ends with an answer. Each
 * turn but the last puts a cache breakpoint at the end of the conversation, so the next turn
 * reads what came before from the cache once it passes the model's minimum. The last turn sets
 * no breakpoint: changing tool_choice invalidates the message cache, so a write there would
 * cost something no later turn reads. The last turn also ends with LAST_TURN_NOTE, telling the
 * agent to answer now.
 */
export async function runAgent(options: AgentOptions): Promise<AgentAnswer> {
  const { provider, system, tools, turnLimit } = options;
  if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new RangeError("turnLimit must be >= 1");
  const messages: TurnMessage[] = [
    { role: "user", content: [{ type: "text", text: questionTurn(options.question) }] },
  ];
  const calls: ToolCall[] = [];
  let usage: TokenUsage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  let usd: number | null = 0;
  let model: string | null = null;
  for (let turn = 1; ; turn++) {
    const last = turn === turnLimit;
    const result = await provider.turn({
      purpose: "evalAgent",
      system,
      tools: tools.definitions,
      messages: last ? withLastTurnNote(messages) : messages,
      maxTokens: MAX_TURN_OUTPUT_TOKENS,
      toolChoice: last ? "none" : "auto",
      cache: !last,
      temperature: AGENT_TEMPERATURE,
    });
    usage = sum(usage, result.usage);
    const cost = callCostUsd(result.model, result.usage, false);
    usd = usd === null || cost === null ? null : usd + cost;
    model = result.model;
    const uses = result.content.flatMap((b) => (b.type === "tool_use" ? [b] : []));
    const text = result.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
    if (result.stopReason === "max_tokens" || uses.length === 0 || last) {
      // A last turn that ended normally is "turn-limit"; a refusal there keeps its own label. A
      // model that called a tool anyway on the last turn answered with its text: no tool runs.
      const stop: AgentStop =
        result.stopReason === "max_tokens"
          ? "max-tokens"
          : result.stopReason === "end_turn" || (last && result.stopReason === "tool_use")
            ? last
              ? "turn-limit"
              : "answered"
            : "other";
      return { answer: text, stop, turns: turn, calls, usage, usd, model };
    }
    // The API refuses a whitespace-only text block, which a model may write before a tool call.
    const echoed = result.content.filter((b) => b.type !== "text" || b.text.trim() !== "");
    messages.push({ role: "assistant", content: echoed });
    const results = uses.map((use, i): ToolResultBlock => {
      if (i > 0) {
        const content = "Not run: call one tool per turn.";
        return { type: "tool_result", toolUseId: use.id, content, isError: true };
      }
      const output = tools.run(use.name, use.input);
      calls.push({ turn, name: use.name, input: use.input, isError: output.isError });
      return {
        type: "tool_result",
        toolUseId: use.id,
        content: output.text,
        isError: output.isError,
      };
    });
    messages.push({ role: "user", content: results });
  }
}
