import type { AskAnswerStatus, AskProgress, AskResponse, TokenUsage } from "@repowiki/core";
import {
  callCostUsd,
  priceFor,
  type TextBlock,
  type ToolProvider,
  type ToolResultBlock,
  type ToolUseBlock,
  type TurnMessage,
  type TurnRequest,
} from "@repowiki/llm";
import { cut, oneLine, type WikiView } from "@repowiki/query";
import { buildResponse, type CheckedAnswer, checkAnswer } from "./answer.ts";
import { type AskIndexes, hintedPage, turnOnePack } from "./pack.ts";
import { ANSWER_TOOL, answerTool, askSystemPrompt, MAX_TURNS } from "./prompt.ts";
import { createAskTools } from "./tools.ts";

/** The output cap of one ask turn: a tool call, or an answer of 120 words with its handles. */
export const ASK_MAX_TOKENS = 1024;

/** Answers are asked at temperature 0, so the same question is asked the same way. */
export const ASK_TEMPERATURE = 0;

/** Characters a token, for a turn's upper bound: engine's estimateTokens rate (upper-side). */
export const BOUND_CHARS_PER_TOKEN = 2.5;

/**
 * The system prompt the API adds to a turn that has tools, which the request's own characters do
 * not show: 346 tokens with tool choice auto and 313 with a forced tool on Claude 4 models, Haiku
 * 4.5 included; 500 leaves a margin (M9 final review: a forced turn counted 1,648 input tokens
 * against a bound of 1,630 without it).
 */
export const TOOL_USE_PROMPT_TOKENS = 500;

/**
 * The most one ask turn may take, its retries included (the provider's timeoutMs): past it the
 * question ends as an error answer, which is never cached, and the session is free again.
 */
export const ASK_TURN_TIMEOUT_MS = 60_000;

/** What the model is told after a turn that answered in prose instead of calling a tool. */
export const CALL_ANSWER_NOW = `Call ${ANSWER_TOOL} now.`;

/** A question the ask cannot price, refused before its first call (as runEval refuses one). */
export class AskError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface AskQuestionOptions {
  provider: ToolProvider;
  view: WikiView;
  indexes: AskIndexes;
  /** The question as AskRequest parsed it: trimmed, 1 to 500 code points. */
  question: string;
  /** The page the reader is on, as sent; resolved through the view or ignored. */
  page: string | null;
  /** The ask role's configured model id, which prices each turn's upper bound. */
  model: string;
  /** The question's cap in dollars (--question-usd). */
  questionUsd: number;
  onStatus?: (progress: AskProgress) => void;
  /**
   * Called after each turn the model answered, with what it cost (its upper bound when it cannot
   * be priced), so a caller still counts the spend if the question then throws.
   */
  onSpend?: (usd: number) => void;
  now?: () => Date;
}

export interface AskResult {
  response: AskResponse;
  /** Every turn's tokens, summed. */
  tokens: TokenUsage;
  /** Why an error answer is one: the provider's message on one line; else null. */
  error: string | null;
  /**
   * Every handle rendered into this conversation (the pack's, then each page read's), once each:
   * what a cited handle must be one of, so a harness can check the answer independently.
   */
  shown: string[];
}

const NO_TOKENS: TokenUsage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  in: a.in + b.in,
  out: a.out + b.out,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

/**
 * The most a turn can cost: its whole input at BOUND_CHARS_PER_TOKEN characters a token plus the
 * API's tool-use prompt (TOOL_USE_PROMPT_TOKENS), and its output cap, at the model's price (spec
 * v2 #4 R10).
 */
export function turnBound(model: string, request: TurnRequest): number {
  const chars =
    request.system.length +
    JSON.stringify(request.tools).length +
    JSON.stringify(request.messages).length;
  const input = Math.ceil(chars / BOUND_CHARS_PER_TOKEN) + TOOL_USE_PROMPT_TOKENS;
  const tokens = { in: input, out: request.maxTokens };
  return callCostUsd(model, { ...tokens, cacheRead: 0, cacheWrite: 0 }, false) ?? Infinity;
}

/** True when an answer should be asked once more: unusable, or over half its sentences refused. */
function wantsRetry(checked: CheckedAnswer): boolean {
  if (checked.status === null) return true;
  if (checked.status === "not-found") return false;
  const refused = checked.refusals.length;
  return refused > 0 && refused * 2 > refused + checked.sentences.length;
}

/** The retry turn's text: each refused sentence's number and reason, never its text. */
export function retryText(checked: CheckedAnswer): string {
  const why =
    checked.status === null
      ? "your answer did not match the answer tool's input schema"
      : checked.refusals.map((r) => `sentence ${r.n}: ${r.reason}`).join("; ");
  return `Not shown to the reader: ${why}. Call ${ANSWER_TOOL} again: cite only handles of claims you were shown, and name files, functions and settings only as the cited claims write them.`;
}

/**
 * Answers one question (spec v2 #4 §6.3): the turn-1 pack, then at most MAX_TURNS model turns of
 * which each but a forced one may call one tool (`search`, `read_page`, or `answer`, which ends
 * the loop); turn MAX_TURNS forces `answer`, as does the turn after one answered in prose, and
 * any turn whose upper bound leaves no room under the question's cap for another. A turn whose
 * bound would cross the cap is not taken (status budget). An answer with every sentence refused,
 * or more than half, is asked once more with the reasons; the second result stands. A forced
 * turn that does not call `answer` ends the question with no answer whatever the provider sent,
 * so a question takes at most MAX_TURNS turns, plus one for the retry. No prompt
 * caching (R11), temperature 0, purpose `ask`.
 */
export async function askQuestion(options: AskQuestionOptions): Promise<AskResult> {
  const { provider, view, indexes, question, model } = options;
  if (priceFor(model) === null) {
    throw new AskError(
      `no price for model ${cut(oneLine(model), 60)}: the ask cannot count what it spends`,
    );
  }
  const now = options.now ?? (() => new Date());
  const onStatus = options.onStatus ?? (() => {});
  const pack = turnOnePack(view, indexes, question, hintedPage(view, options.page));
  const shown = new Set(pack.shown);
  const tools = createAskTools(view, indexes.pages, {
    searched: (query) => onStatus({ step: "search", query: cut(oneLine(query), 200) }),
    read: (page) => {
      for (const handle of page.handles) shown.add(handle);
      onStatus({ step: "read", pageId: page.pageId, title: cut(oneLine(page.title), 200) });
    },
  });
  const system = askSystemPrompt(view.wiki.repo);
  const definitions = [...tools.definitions, answerTool];
  const messages: TurnMessage[] = [{ role: "user", content: [{ type: "text", text: pack.text }] }];
  let tokens = NO_TOKENS;
  let usd: number | null = 0;
  let spent = 0;
  let turns = 0;
  let reported: string | null = null;
  let forceNext = false;
  let retried = false;
  let checked: CheckedAnswer | null = null;
  let stop: "budget" | "error" | null = null;
  let error: string | null = null;
  const request = (force: boolean): TurnRequest => ({
    purpose: "ask",
    system,
    tools: definitions,
    messages: [...messages],
    maxTokens: ASK_MAX_TOKENS,
    toolChoice: force ? { tool: ANSWER_TOOL } : "auto",
    cache: false,
    temperature: ASK_TEMPERATURE,
  });
  for (let turn = 1; ; turn++) {
    let next = request(forceNext || turn >= MAX_TURNS);
    const bound = turnBound(model, next);
    const left = options.questionUsd - spent;
    if (bound > left) {
      stop = "budget";
      break;
    }
    if (next.toolChoice === "auto" && 2 * bound > left) next = request(true);
    let result: Awaited<ReturnType<ToolProvider["turn"]>>;
    try {
      result = await provider.turn(next);
    } catch (failure) {
      stop = "error";
      error = cut(oneLine(failure instanceof Error ? failure.message : String(failure)), 300);
      break;
    }
    turns++;
    tokens = add(tokens, result.usage);
    const cost = callCostUsd(result.model, result.usage, false);
    usd = usd === null || cost === null ? null : usd + cost;
    spent += cost ?? bound;
    options.onSpend?.(cost ?? bound);
    reported = result.model;
    const uses = result.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const echoed: (TextBlock | ToolUseBlock)[] = result.content.filter(
      (b) => b.type !== "text" || b.text.trim() !== "",
    );
    const first = uses[0];
    if (first?.name === ANSWER_TOOL) {
      const answer = checkAnswer(view, first.input, shown);
      if (!retried && wantsRetry(answer)) {
        retried = true;
        const saved = messages.length;
        messages.push({ role: "assistant", content: echoed });
        messages.push({
          role: "user",
          content: [
            ...uses.map(
              (use): ToolResultBlock => ({
                type: "tool_result",
                toolUseId: use.id,
                content: use === first ? retryText(answer) : "Not run: call one tool per turn.",
                isError: true,
              }),
            ),
          ],
        });
        if (turnBound(model, request(true)) <= options.questionUsd - spent) {
          forceNext = true;
          continue;
        }
        messages.length = saved;
      }
      checked = answer;
      break;
    }
    if (next.toolChoice !== "auto") {
      // A forced turn that did not answer (prose, or another tool when the provider ignored
      // tool_choice) ends the question: the turn bound is the loop's, not the provider's.
      checked = { status: null, sentences: [], readNext: [], refusals: [] };
      break;
    }
    if (first === undefined) {
      messages.push({
        role: "assistant",
        content: echoed.length > 0 ? echoed : [{ type: "text", text: "(no answer yet)" }],
      });
      messages.push({ role: "user", content: [{ type: "text", text: CALL_ANSWER_NOW }] });
      forceNext = true;
      continue;
    }
    messages.push({ role: "assistant", content: echoed });
    const results = uses.map((use, i): ToolResultBlock => {
      if (i > 0) {
        const content = "Not run: call one tool per turn.";
        return { type: "tool_result", toolUseId: use.id, content, isError: true };
      }
      const output = tools.run(use.name, use.input);
      return {
        type: "tool_result",
        toolUseId: use.id,
        content: output.text,
        isError: output.isError,
      };
    });
    messages.push({ role: "user", content: results });
  }
  const status: AskAnswerStatus =
    stop ?? (checked?.status === null || checked === null ? "not-found" : checked.status);
  const response = buildResponse({
    view,
    indexes,
    question,
    status,
    sentences: checked?.sentences ?? [],
    readNext: checked?.readNext ?? [],
    refused: checked === null ? 0 : checked.status === null ? 1 : checked.refusals.length,
    cost: { turns, usd, model: reported },
    answeredAt: now(),
  });
  return { response, tokens, error, shown: [...shown] };
}
