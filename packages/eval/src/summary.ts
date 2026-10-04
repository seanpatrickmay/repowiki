import type { TokenUsage, WikiExport } from "@repowiki/core";
import type { AgentKind } from "./prompts.ts";
import {
  AGENTS,
  type AnswerRecord,
  type JudgmentRecord,
  type RunInfo,
  type RunRecord,
} from "./records.ts";

/** Spec §9's pass test, on the held-out set: wiki accuracy ≥ 90% of repo accuracy… */
export const ACCURACY_SHARE = 0.9;
/** …and wiki tokens ≤ 40% of repo tokens. */
export const TOKEN_SHARE = 0.4;

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
  agents: Record<AgentKind, AgentStats>;
  /** Every question answered by both agents, and every answer judged. */
  complete: boolean;
  /** Spec §9's two conditions, when the run is complete. */
  pass: { accuracy: boolean; tokens: boolean } | null;
  /** Questions after which the build has paid for itself: a number, "never", or null (unknown). */
  breakEven: number | "never" | null;
  agentUsd: number;
  judgeUsd: number;
}

/** Each question's answer and judgment per agent, keyed `<questionId>\0<agent>`; the last one wins. */
export function latestRecords(records: readonly RunRecord[]) {
  const answers = new Map<string, AnswerRecord>();
  const judgments = new Map<string, JudgmentRecord>();
  for (const r of records) {
    const key = `${r.questionId}\0${r.agent}`;
    if (r.kind === "answer") answers.set(key, r);
    else judgments.set(key, r);
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
    const usd = mine.reduce((sum, m) => sum + (m.a.usd ?? 0), 0);
    return {
      answered: mine.length,
      judged: judged.length,
      correct,
      accuracy: judged.length === n ? correct / n : null,
      tokensPerQuestion: mine.length === 0 ? null : tokens / mine.length,
      usdPerQuestion: mine.length === 0 ? null : usd / mine.length,
      lastTurn: mine.filter((m) => m.a.stop === "turn-limit").length,
    };
  };
  const agents = { wiki: stats("wiki"), repo: stats("repo") };
  const complete = AGENTS.every((a) => agents[a].judged === n);
  const { wiki, repo } = agents;
  const pass =
    complete && wiki.accuracy !== null && repo.accuracy !== null
      ? {
          accuracy: wiki.accuracy >= ACCURACY_SHARE * repo.accuracy,
          tokens: (wiki.tokensPerQuestion ?? 0) <= TOKEN_SHARE * (repo.tokensPerQuestion ?? 0),
        }
      : null;
  const saved =
    wiki.tokensPerQuestion === null || repo.tokensPerQuestion === null
      ? null
      : repo.tokensPerQuestion - wiki.tokensPerQuestion;
  const breakEven =
    info.buildTokens === null || saved === null
      ? null
      : saved <= 0
        ? "never"
        : info.buildTokens / saved;
  const sumUsd = (kind: RunRecord["kind"]) =>
    records.reduce((s, r) => s + (r.kind === kind ? (r.usd ?? 0) : 0), 0);
  return {
    info,
    agents,
    complete,
    pass,
    breakEven,
    agentUsd: sumUsd("answer"),
    judgeUsd: sumUsd("judgment"),
  };
}
