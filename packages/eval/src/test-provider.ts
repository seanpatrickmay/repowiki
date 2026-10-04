import type { TokenUsage } from "@repowiki/core";
import type { ToolProvider, TurnRequest, TurnResult } from "@repowiki/llm";

/** One scripted model turn: a tool call, an answer, or a whole result. Test-only. */
export type ScriptedTurn =
  | { tool: string; input: unknown; text?: string }
  | { answer: string; stopReason?: string }
  | TurnResult;

export const TURN_USAGE: TokenUsage = { in: 1000, out: 100, cacheRead: 0, cacheWrite: 0 };
export const SCRIPTED_MODEL = "claude-haiku-4-5-20251001";

/**
 * A ToolProvider that plays `script` in order (per call, across conversations) and keeps every
 * request; `answerFor` answers turns past the script's end, keyed by the conversation's question.
 */
export function scriptedToolProvider(
  script: readonly ScriptedTurn[],
  answerFor?: (question: string, request: TurnRequest) => ScriptedTurn,
) {
  const requests: TurnRequest[] = [];
  let next = 0;
  let ids = 0;
  const provider: ToolProvider = {
    async turn(request) {
      // Copy the messages: the agent appends to its array after the call.
      requests.push({ ...request, messages: [...request.messages] });
      const first = request.messages[0]?.content[0];
      const question = first?.type === "text" ? first.text : "";
      const step = script[next++] ?? answerFor?.(question, request);
      if (step === undefined) throw new Error(`no scripted turn ${next}`);
      if ("content" in step) return step;
      if ("tool" in step) {
        return {
          content: [
            ...(step.text === undefined ? [] : [{ type: "text" as const, text: step.text }]),
            { type: "tool_use", id: `tu_${++ids}`, name: step.tool, input: step.input },
          ],
          stopReason: "tool_use",
          usage: TURN_USAGE,
          model: SCRIPTED_MODEL,
        };
      }
      return {
        content: [{ type: "text", text: step.answer }],
        stopReason: step.stopReason ?? "end_turn",
        usage: TURN_USAGE,
        model: SCRIPTED_MODEL,
      };
    },
  };
  return { provider, requests };
}
