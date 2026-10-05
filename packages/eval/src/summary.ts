import type { TokenUsage, WikiExport } from "@repowiki/core";
import type { AgentKind } from "./prompts.ts";
import {
  AGENTS,
  type AnswerRecord,
  type JudgmentRecord,
  type RunInfo,
  type RunRecord,
} from "./records.ts";

/** Spec §9's pass test, on the held-out set: wiki accuracy at least 90% of repo accuracy… */
export const ACCURACY_PERCENT = 90;
/** …and wiki tokens at most 40% of repo tokens. */
export const TOKEN_PERCENT = 40;
export const ACCURACY_SHARE = ACCURACY_PERCENT / 100;
export const TOKEN_SHARE = TOKEN_PERCENT / 100;

/** Every token an answer cost, all four classes: caching changes the price, not the count. */
export const tokensOf = (t: TokenUsage): number => t.in + t.out + t.cacheRead + t.cacheWrite;

/**
 * The tokens of the wiki's build (spec §9's break-even numerator): the newest build run in the
 * export's runs, all four token classes, or null when the export records none.
 */
export function buildTokensOf(wiki: WikiExport): number | null {
  const build = wiki.runs.findLast((run) => run.kind === "build");
  return build === undefined ? null : tokensOf(build.tokens);
}

export interface AgentStats {
  answered: number;
  judged: number;
  correct: number;
  /** Correct over the set's questions, once every answer is judged. */
  accuracy: number | null;
  /** Mean tokens per answered question. */
  tokensPerQuestion: number | null;
  usdPerQuestion: number | null;
  /** Answers given on the last turn, where tools are forbidden. */
  lastTurn: number;
}

export interface EvalSummary {
  info: RunInfo;
  /** Every agent kind's figures; an agent the run did not ask has none answered. */
  agents: Record<AgentKind, AgentStats>;
  /** Every question answered by every asked agent, and every answer judged. */
  complete: boolean;
  /**
   * Spec §9's two conditions, when the run asked the wiki and repo agents, is complete, and the
   * repo agent got at least one answer right (at 0, 90% of its accuracy is 0 and any wiki
   * accuracy would meet it).
   */
  pass: { accuracy: boolean; tokens: boolean } | null;
  /**
   * Questions after which the build has paid for itself: a number, "never", or null (unknown, or
   * the run is incomplete).
   */
  breakEven: number | "never" | null;
  /** What the calls cost, failed judgments included; null when any call's cost is unknown. */
  agentUsd: number | null;
  judgeUsd: number | null;
}

/** The sum of the records' costs, or null when any of them is unknown. */
const costOf = (records: readonly { usd: number | null }[]): number | null =>
  records.some((r) => r.usd === null) ? null : records.reduce((sum, r) => sum + (r.usd ?? 0), 0);

/** Each question's answer and judgment per agent, keyed `<questionId>\0<agent>`; the last one wins. */
export function latestRecords(records: readonly RunRecord[]) {
  const answers = new Map<string, AnswerRecord>();
  const judgments = new Map<string, JudgmentRecord>();
  for (const r of records) {
    const key = `${r.questionId}\0${r.agent}`;
    if (r.kind === "answer") answers.set(key, r);
    else if (r.kind === "judgment") judgments.set(key, r);
  }
  return { answers, judgments };
}

/** The figures a report states, from a run's records. */
export function summarize(info: RunInfo, records: readonly RunRecord[]): EvalSummary {
  const { answers, judgments } = latestRecords(records);
  const n = info.questions.length;
  const stats = (agent: AgentKind): AgentStats => {
    const mine = info.questions.flatMap((q) => {
      const a = answers.get(`${q.id}\0${agent}`);
      return a === undefined ? [] : [{ a, j: judgments.get(`${q.id}\0${agent}`) }];
    });
    const judged = mine.filter((m) => m.j !== undefined);
    const correct = judged.filter((m) => m.j?.score === 1).length;
    const tokens = mine.reduce((sum, m) => sum + tokensOf(m.a.usage), 0);
    const usd = costOf(mine.map((m) => m.a));
    return {
      answered: mine.length,
      judged: judged.length,
      correct,
      accuracy: judged.length === n ? correct / n : null,
      tokensPerQuestion: mine.length === 0 ? null : tokens / mine.length,
      usdPerQuestion: mine.length === 0 || usd === null ? null : usd / mine.length,
      lastTurn: mine.filter((m) => m.a.stop === "turn-limit").length,
    };
  };
  const agents = Object.fromEntries(AGENTS.map((a) => [a, stats(a)])) as Record<
    AgentKind,
    AgentStats
  >;
  const complete = info.agents.every((a) => agents[a].judged === n);
  const v1 = info.agents.includes("wiki") && info.agents.includes("repo");
  const { wiki, repo } = agents;
  // Once complete, both agents answered all n questions: compare whole-number totals, exactly.
  const total = (agent: AgentKind) =>
    info.questions.reduce((sum, q) => {
      const a = answers.get(`${q.id}\0${agent}`);
      return sum + (a === undefined ? 0 : tokensOf(a.usage));
    }, 0);
  const pass =
    complete && v1 && repo.correct > 0
      ? {
          accuracy: 100 * wiki.correct >= ACCURACY_PERCENT * repo.correct,
          tokens: 100 * total("wiki") <= TOKEN_PERCENT * total("repo"),
        }
      : null;
  const saved = complete && v1 ? total("repo") - total("wiki") : null;
  const breakEven =
    info.buildTokens === null || saved === null
      ? null
      : saved <= 0
        ? "never"
        : (info.buildTokens * n) / saved;
  const ofKind = (kinds: readonly RunRecord["kind"][]) =>
    costOf(records.filter((r) => kinds.includes(r.kind)));
  return {
    info,
    agents,
    complete,
    pass,
    breakEven,
    agentUsd: ofKind(["answer"]),
    judgeUsd: ofKind(["judgment", "judge-failure"]),
  };
}
