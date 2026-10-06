import { type AskIndexes, askQuestion, ungroundedToken } from "@repowiki/ask";
import { ASK_QUESTION_MAX_LENGTH, type AskResponse } from "@repowiki/core";
import {
  type EvalQuestion,
  JudgeError,
  judgeAnswer,
  MAX_DIRECT_JUDGE_CALLS,
  settleAll,
} from "@repowiki/eval";
import { callCostUsd, type Provider, type ToolProvider } from "@repowiki/llm";
import { cut, handleClaim, markdownText, oneLine, type WikiView } from "@repowiki/query";
import { CliError } from "./manifest-cli.ts";
import { DEFAULT_QUESTION_USD } from "./serve-cli.ts";

/** One question's result: the ask's response, how long it took, and the judge's grade. */
export interface AskEvalRow {
  id: string;
  kind: string;
  question: string;
  response: AskResponse;
  /** Milliseconds from the question to its answer. */
  ms: number;
  /** The judge's 0/1 grade, or null when the judgment failed. */
  score: 0 | 1 | null;
  judgeUsd: number | null;
  /** The shown sentences the harness's own check finds grounded (groundedSentences). */
  grounded: number;
}

export interface AskEvalResult {
  rows: AskEvalRow[];
  /** Questions not asked because the next could have crossed --max-usd. */
  overBudget: string[];
  spentUsd: number;
}

/** A run as it stands: complete once every answer is judged; until then rows are unjudged. */
export interface AskEvalProgress extends AskEvalResult {
  complete: boolean;
}

/** An answer as the judge reads it: its sentences, joined as one answer. */
export const answerText = (response: AskResponse): string =>
  response.sentences.map((s) => s.text).join(" ");

/**
 * How many of an answered or partial response's sentences pass spec v2 #4 §12.3's check, made
 * again here from the handles the question's conversation showed (AskResult.shown), not from the
 * response's own shape: every source a sentence cites is a shown handle, and the sentence names
 * no file, function or setting those claims do not write. A not-found, budget or error answer
 * shows none.
 */
export function groundedSentences(
  view: WikiView,
  response: AskResponse,
  shown: readonly string[],
): number {
  if (response.status !== "answered" && response.status !== "partial") return 0;
  const rendered = new Set(shown);
  return response.sentences.filter((sentence) => {
    const handles = sentence.sources.map((n) => {
      const source = response.sources[n - 1];
      return source === undefined ? "" : `${source.pageId}#${source.claimId}`;
    });
    if (handles.length === 0 || !handles.every((h) => rendered.has(h))) return false;
    const claims = handles.flatMap((h) => handleClaim(view, h) ?? []);
    return (
      claims.length === handles.length && ungroundedToken(view, sentence.text, claims) === null
    );
  }).length;
}

/**
 * Refuses, as one CliError naming them, the questions the ask cannot take (over
 * ASK_QUESTION_MAX_LENGTH code points once trimmed, as AskRequest counts): the eval's question
 * file allows longer ones, and such a question would fail only after its turns were paid for.
 */
export function checkAskableQuestions(questions: readonly EvalQuestion[]): void {
  const long = questions.filter((q) => [...q.question.trim()].length > ASK_QUESTION_MAX_LENGTH);
  if (long.length > 0) {
    throw new CliError(
      `the ask takes questions of at most ${ASK_QUESTION_MAX_LENGTH} characters; longer: ${long.map((q) => q.id).join(", ")}`,
    );
  }
}

/**
 * Asks each question through askQuestion with no cache (spec v2 #4 §7), one at a time, while the
 * next question's ceiling fits under `maxUsd` (C12), after refusing any question the ask cannot
 * take; then judges every answer with the M7 judge, the calls together so they go as one batch
 * (with --no-batch, at most MAX_DIRECT_JUDGE_CALLS at once). Every judge attempt is counted in
 * `spentUsd`: a judgment the judge answered unusably twice is left unjudged (logged on one line)
 * and an unpriced one is priced as `judgeModel`; any other judge failure is rethrown once every
 * judgment has settled.
 */
export async function runAskEval(options: {
  view: WikiView;
  indexes: AskIndexes;
  questions: readonly EvalQuestion[];
  provider: ToolProvider;
  judge: Provider;
  model: string;
  /** The judge role's configured model, which prices a judgment its reply did not price. */
  judgeModel: string;
  batchJudge: boolean;
  maxUsd: number;
  perQuestionCeilingUsd: readonly number[];
  clock?: () => number;
  log?: (line: string) => void;
  /**
   * Called with the run so far after each question is answered, before rethrowing a failure,
   * and once judged (complete), so what was paid for is written as it is spent.
   */
  record?: (progress: AskEvalProgress) => void;
}): Promise<AskEvalResult> {
  const clock = options.clock ?? (() => performance.now());
  const log = options.log ?? (() => {});
  checkAskableQuestions(options.questions);
  const asked: Omit<AskEvalRow, "score" | "judgeUsd">[] = [];
  const overBudget: string[] = [];
  let spent = 0;
  const record = (rows: AskEvalRow[], complete: boolean) =>
    options.record?.({ rows, overBudget: [...overBudget], spentUsd: spent, complete });
  const unjudged = () => asked.map((row) => ({ ...row, score: null, judgeUsd: null }));
  let committed = 0;
  for (const [i, question] of options.questions.entries()) {
    const ceiling = options.perQuestionCeilingUsd[i] ?? DEFAULT_QUESTION_USD;
    if (committed + ceiling > options.maxUsd + 1e-12) {
      overBudget.push(question.id);
      continue;
    }
    log(`[${i + 1}/${options.questions.length}] ${question.id}: asking`);
    const started = clock();
    let paid = 0;
    let response: AskResponse;
    let shown: string[];
    try {
      ({ response, shown } = await askQuestion({
        provider: options.provider,
        view: options.view,
        indexes: options.indexes,
        question: question.question,
        page: null,
        model: options.model,
        questionUsd: DEFAULT_QUESTION_USD,
        onSpend: (usd) => {
          paid += usd;
        },
      }));
    } catch (error) {
      // The turns it took were paid for: record them before the run stops.
      spent += paid;
      record(unjudged(), false);
      throw error;
    }
    const ms = clock() - started;
    spent += response.cost.usd ?? DEFAULT_QUESTION_USD;
    committed += ceiling - DEFAULT_QUESTION_USD + (response.cost.usd ?? DEFAULT_QUESTION_USD);
    asked.push({
      id: question.id,
      kind: question.kind,
      question: question.question,
      response,
      ms,
      grounded: groundedSentences(options.view, response, shown),
    });
    record(unjudged(), false);
  }
  if (asked.length > 0)
    log(`judging ${asked.length} answers${options.batchJudge ? " in one batch" : ""}`);
  const byId = new Map(options.questions.map((q) => [q.id, q]));
  const judged = await settleAll(
    asked.map(
      (row) => () =>
        judgeAnswer(
          options.judge,
          byId.get(row.id) as EvalQuestion,
          answerText(row.response),
          options.batchJudge,
        ),
    ),
    options.batchJudge ? asked.length : MAX_DIRECT_JUDGE_CALLS,
  );
  // A reply priced under its own model id, else under the configured judge model.
  const priced = (model: string | null, usage: JudgeError["usage"]) =>
    (model === null ? null : callCostUsd(model, usage, options.batchJudge)) ??
    callCostUsd(options.judgeModel, usage, options.batchJudge);
  const failures: unknown[] = [];
  const rows = asked.map((row, i): AskEvalRow => {
    const outcome = judged[i];
    if (outcome?.status === "rejected") {
      if (!(outcome.reason instanceof JudgeError)) {
        failures.push(outcome.reason);
        return { ...row, score: null, judgeUsd: null };
      }
      // The unusable attempts were paid for, though there is no grade: count them.
      const usd = priced(null, outcome.reason.usage);
      if (usd !== null) spent += usd;
      log(`${row.id}: ${cut(oneLine(outcome.reason.message), 200)}; left unjudged`);
      return { ...row, score: null, judgeUsd: usd };
    }
    const j = outcome?.value;
    if (j === undefined) return { ...row, score: null, judgeUsd: null };
    const usd = j.model === null ? 0 : priced(j.model, j.usage);
    if (usd !== null) spent += usd;
    return { ...row, score: j.score, judgeUsd: usd };
  });
  record(rows, failures.length === 0);
  if (failures.length > 0) throw failures[0];
  return { rows, overBudget, spentUsd: spent };
}

/** The middle value, or null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Spec v2 #4 §12.5's bars: median and most per question, and median time to the answer. */
export const MEDIAN_USD_BAR = 0.015;
export const MAX_USD_BAR = 0.05;
export const MEDIAN_SECONDS_BAR = 8;

const usd4 = (usd: number | null) => (usd === null ? "unknown" : `$${usd.toFixed(4)}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * report.md (spec v2 #4 §7): every question's status, grade, turns, cost and time; the accuracy,
 * the medians and the most a question cost; that every shown sentence cites a claim the model
 * was shown; and §12.5's bars. Question text never appears; ids are kebab-case.
 */
export function renderAskReport(at: {
  repo: string;
  head: string;
  model: string;
  set: string;
  startedAt: string;
  result: AskEvalResult;
  extra?: readonly string[];
}): string {
  const { rows } = at.result;
  const correct = rows.filter((r) => r.score === 1).length;
  const costs = rows.map((r) => r.response.cost.usd ?? DEFAULT_QUESTION_USD);
  const times = rows.map((r) => r.ms);
  const shown = rows.flatMap((r) =>
    r.response.status === "answered" || r.response.status === "partial" ? r.response.sentences : [],
  );
  const grounded = rows.reduce((sum, r) => sum + r.grounded, 0);
  const medianUsd = median(costs);
  const maxUsd = costs.length === 0 ? null : Math.max(...costs);
  const medianMs = median(times);
  const met = (ok: boolean) => (ok ? "met" : "not met");
  const lines = [
    `# Ask eval: ${markdownText(at.repo, 80)} at ${at.head.slice(0, 7)}`,
    "",
    `${rows.length} ${at.set} questions asked through the ask with ${markdownText(at.model, 60)} (at most ${usd4(DEFAULT_QUESTION_USD)} a question, no answer cache), each judged by the M7 judge. The run began ${at.startedAt}.`,
    "",
    "| Question | Kind | Status | Correct | Turns | Cost | Time |",
    "|---|---|---|---|---:|---:|---:|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.response.status} | ${r.score === null ? "unjudged" : r.score === 1 ? "yes" : "no"} | ${r.response.cost.turns} | ${usd4(r.response.cost.usd)} | ${seconds(r.ms)} |`,
    ),
    "",
    "## Totals",
    "",
    `- Accuracy: ${correct} of ${rows.length}${rows.length === 0 ? "" : ` (${Math.round((100 * correct) / rows.length)}%)`}${rows.some((r) => r.score === null) ? `; ${rows.filter((r) => r.score === null).length} unjudged` : ""}.`,
    `- Cost a question: median ${usd4(medianUsd)}, most ${usd4(maxUsd)}; the run cost ${usd4(at.result.spentUsd)} with judging.`,
    `- Time from the question to its answer: median ${medianMs === null ? "none" : seconds(medianMs)}, most ${times.length === 0 ? "none" : seconds(Math.max(...times))}.`,
    `- Grounding: ${grounded} of ${shown.length} shown sentences cite only claims the model was shown and name only what they write (checked again from each question's shown handles).`,
    `- Not asked (the next question could have crossed --max-usd): ${at.result.overBudget.length === 0 ? "none" : at.result.overBudget.join(", ")}.`,
    "",
    "## Cost and speed (spec v2 #4 §12.5)",
    "",
    `- Median cost at most ${usd4(MEDIAN_USD_BAR)}: ${medianUsd === null ? "no answers" : met(medianUsd <= MEDIAN_USD_BAR)}.`,
    `- Most a question cost at most ${usd4(MAX_USD_BAR)}: ${maxUsd === null ? "no answers" : met(maxUsd <= MAX_USD_BAR)}.`,
    `- Median time at most ${MEDIAN_SECONDS_BAR} s: ${medianMs === null ? "no answers" : met(medianMs <= MEDIAN_SECONDS_BAR * 1000)}.`,
    ...(at.extra ?? []),
  ];
  return `${lines.join("\n")}\n`;
}
