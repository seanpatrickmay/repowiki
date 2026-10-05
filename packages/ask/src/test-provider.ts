import type { TokenUsage } from "@repowiki/core";
import type { ToolProvider, TurnRequest, TurnResult } from "@repowiki/llm";
import { ANSWER_TOOL } from "./prompt.ts";

/** One scripted model turn: a tool call, prose, a thrown error, or a whole result. Test-only. */
export type ScriptedTurn =
  | { tool: string; input: unknown; text?: string; also?: { tool: string; input: unknown } }
  | { text: string; stopReason?: string }
  | { error: Error }
  | TurnResult;

/** Each scripted turn's tokens: $0.003 at Haiku 4.5's price. */
export const TURN_USAGE: TokenUsage = { in: 2000, out: 200, cacheRead: 0, cacheWrite: 0 };
export const SCRIPTED_MODEL = "claude-haiku-4-5-20251001";

/** An `answer` call: sentences as [text, handles], a status and the pages to read next. */
export function answerTurn(
  sentences: readonly (readonly [string, readonly string[]])[],
  status: "answered" | "partial" | "not-found" = "answered",
  readNext: readonly string[] = [],
): ScriptedTurn {
  return {
    tool: ANSWER_TOOL,
    input: { status, sentences: sentences.map(([text, claims]) => ({ text, claims })), readNext },
  };
}

/** A ToolProvider that plays `script` in order and keeps a copy of every request. Test-only. */
export function scriptedProvider(script: readonly ScriptedTurn[]) {
  const requests: TurnRequest[] = [];
  let next = 0;
  let ids = 0;
  const provider: ToolProvider = {
    async turn(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const step = script[next++];
      if (step === undefined) throw new Error(`no scripted turn ${next}`);
      if ("error" in step) throw step.error;
      if ("content" in step) return step;
      if ("tool" in step) {
        const calls = [step, ...(step.also === undefined ? [] : [step.also])];
        return {
          content: [
            ...(step.text === undefined ? [] : [{ type: "text" as const, text: step.text }]),
            ...calls.map((call) => ({
              type: "tool_use" as const,
              id: `tu_${++ids}`,
              name: call.tool,
              input: call.input,
            })),
          ],
          stopReason: "tool_use",
          usage: TURN_USAGE,
          model: SCRIPTED_MODEL,
        };
      }
      return {
        content: [{ type: "text", text: step.text }],
        stopReason: step.stopReason ?? "end_turn",
        usage: TURN_USAGE,
        model: SCRIPTED_MODEL,
      };
    },
  };
  return { provider, requests };
}
