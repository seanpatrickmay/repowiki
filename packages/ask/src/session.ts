import type {
  AskProgress,
  AskRequest,
  AskResponse,
  AskStatus,
  TokenUsage,
  WikiExport,
} from "@repowiki/core";
import type { ToolProvider } from "@repowiki/llm";
import { cut, oneLine, WikiView } from "@repowiki/query";
import { buildResponse } from "./answer.ts";
import { type AnswerCache, answerKey, exportHash } from "./cache.ts";
import { askQuestion } from "./loop.ts";
import { type AskIndexes, askIndexes, hintedPage } from "./pack.ts";
import { ASK_PROMPT_VERSION } from "./prompt.ts";

/** A question asked while another is in flight (spec v2 #4 R10: one at a time). */
export class BusyError extends Error {
  constructor() {
    super("another question is being answered");
    this.name = new.target.name;
  }
}

export interface AskSessionOptions {
  wiki: WikiExport;
  provider: ToolProvider;
  /** The ask role's configured model id. */
  model: string;
  /** The cap of one question, and of the whole session, in dollars (R10). */
  questionUsd: number;
  maxUsd: number;
  cache: AnswerCache;
  /** One terminal line per question. */
  log: (line: string) => void;
  now?: () => Date;
}

export interface SessionTotals {
  questions: number;
  cached: number;
  usd: number;
}

/** One serve session's answering: the export it started with, its cache, caps and spend. */
export interface AskSession {
  readonly head: string;
  readonly view: WikiView;
  readonly indexes: AskIndexes;
  status(): AskStatus;
  /** Answers one request; throws BusyError while another is in flight. */
  ask(request: AskRequest, onStatus?: (progress: AskProgress) => void): Promise<AskResponse>;
  totals(): SessionTotals;
  /** Resolves once no question is in flight. */
  idle(): Promise<void>;
}

const money = (usd: number) => `$${usd.toFixed(4)}`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * A serve session (spec v2 #4 §6.4): the export snapshot and its indexes, built once; the answer
 * cache (R12; a hit costs nothing and is allowed past the session cap); the session cap (a
 * question starts only if the spend so far plus the question cap stays within it, so the cap is
 * never crossed); one question in flight; and one terminal line per question, a question that
 * throws included (what it spent before throwing is counted, then it rethrows). Only answered,
 * partial and not-found answers are cached; "Ask again" (`fresh`) skips the cache and replaces
 * the entry.
 */
export function createAskSession(options: AskSessionOptions): AskSession {
  const { wiki, provider, model, questionUsd, maxUsd, cache, log } = options;
  const now = options.now ?? (() => new Date());
  const view = new WikiView(wiki);
  const indexes = askIndexes(view);
  const hash = exportHash(wiki);
  let spent = 0;
  let flight: Promise<unknown> | null = null;
  const totals: SessionTotals = { questions: 0, cached: 0, usd: 0 };
  const affordable = () => spent + questionUsd <= maxUsd + 1e-12;
  const shown = (question: string) => JSON.stringify(cut(oneLine(question), 60));
  const sessionLine = () => `(session ${money(spent)} of $${maxUsd.toFixed(2)})`;

  async function answer(
    request: AskRequest,
    onStatus: ((progress: AskProgress) => void) | undefined,
    onSpend: (usd: number) => void,
  ): Promise<{ response: AskResponse; tokens: TokenUsage; error: string | null }> {
    if (!affordable()) {
      const response = buildResponse({
        view,
        indexes,
        question: request.question,
        status: "budget",
        sentences: [],
        readNext: [],
        refused: 0,
        cost: { turns: 0, usd: 0, model: null },
        answeredAt: now(),
      });
      return { response, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, error: null };
    }
    return askQuestion({
      provider,
      view,
      indexes,
      question: request.question,
      page: request.page,
      model,
      questionUsd,
      onStatus,
      onSpend,
      now,
    });
  }

  return {
    head: wiki.head,
    view,
    indexes,
    status() {
      return affordable()
        ? {
            mode: "answer",
            head: wiki.head,
            model,
            questionUsd,
            sessionLeftUsd: Math.max(0, maxUsd - spent),
          }
        : { mode: "routing", head: wiki.head, reason: "budget" };
    },
    async ask(request, onStatus) {
      const page = hintedPage(view, request.page);
      const key = answerKey({
        exportHash: hash,
        model,
        promptVersion: ASK_PROMPT_VERSION,
        page,
        question: request.question,
      });
      const hit = request.fresh ? undefined : cache.get(key);
      if (hit !== undefined) {
        totals.questions++;
        totals.cached++;
        log(`ask ${shown(request.question)} \u2192 ${hit.response.status} (cached)`);
        return { ...hit.response, question: request.question, cached: true };
      }
      if (flight !== null) throw new BusyError();
      let paid = 0;
      const pending = answer({ ...request, page }, onStatus, (usd) => {
        paid += usd;
      });
      flight = pending;
      try {
        let result: Awaited<typeof pending>;
        try {
          result = await pending;
        } catch (failure) {
          // What the question spent before it threw still counts toward the session cap.
          totals.questions++;
          spent += paid;
          totals.usd = spent;
          const message = failure instanceof Error ? failure.message : String(failure);
          log(
            `ask ${shown(request.question)} \u2192 failed (${cut(oneLine(message), 120)}), ${money(paid)} ${sessionLine()}`,
          );
          throw failure;
        }
        const { response, tokens, error } = result;
        totals.questions++;
        // An unpriced turn is counted at the question's cap, so the session cap still holds.
        const usd = response.cost.turns === 0 ? 0 : (response.cost.usd ?? questionUsd);
        spent += usd;
        totals.usd = spent;
        if (["answered", "partial", "not-found"].includes(response.status)) {
          // A cache that cannot be written loses only the saving: the reader still gets the answer.
          try {
            cache.append({
              v: 1,
              key,
              exportHash: hash,
              model,
              promptVersion: ASK_PROMPT_VERSION,
              response,
              tokens,
              at: now().toISOString(),
            });
          } catch (failure) {
            const message = failure instanceof Error ? failure.message : String(failure);
            log(`ask cache: the answer was not saved (${cut(oneLine(message), 120)})`);
          }
        }
        const why = error === null ? "" : ` (${cut(oneLine(error), 120)})`;
        log(
          `ask ${shown(request.question)} \u2192 ${response.status}${why}, ${count(response.cost.turns, "turn")}, ${response.cost.usd === null ? "unknown cost" : money(response.cost.usd)} ${sessionLine()}`,
        );
        return response;
      } finally {
        flight = null;
      }
    },
    totals: () => ({ ...totals }),
    async idle() {
      while (flight !== null) await flight.catch(() => {});
    },
  };
}
