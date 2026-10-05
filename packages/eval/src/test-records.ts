import type { EvalQuestion } from "./questions.ts";
import type { AnswerRecord, JudgmentRecord, RunInfo, RunRecord } from "./records.ts";

/** Run records for the summary, spot-check and report tests. Test-only. */
const KINDS = ["where", "how", "why", "what-changed"] as const;
export const questions: EvalQuestion[] = KINDS.map((kind, i) => ({
  id: `q${i + 1}`,
  set: "held-out",
  kind,
  question: `Placeholder ${kind} question?`,
  reference: `Reference ${i + 1}.`,
}));

export function info(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    set: "held-out",
    repo: "sample",
    head: "a".repeat(40),
    exportHash: "e".repeat(64),
    questionsHash: "f".repeat(64),
    writtenOn: "2026-10-01",
    turnLimit: 15,
    agents: ["wiki", "repo"],
    models: { evalAgent: "claude-haiku-4-5", evalJudge: "claude-haiku-4-5" },
    buildTokens: 1_000_000,
    questions,
    startedAt: "2026-10-04T12:00:00.000Z",
    ...overrides,
  };
}

export const AT = "2026-10-04T12:30:00.000Z";
export const answer = (
  questionId: string,
  agent: "wiki" | "repo",
  tokens: number,
): AnswerRecord => ({
  kind: "answer",
  questionId,
  agent,
  answer: `${agent} answer to ${questionId}`,
  stop: tokens > 100_000 ? "turn-limit" : "answered",
  turns: 3,
  calls: [],
  usage: { in: tokens - 1000, out: 1000, cacheRead: 0, cacheWrite: 0 },
  usd: tokens / 1_000_000,
  model: "claude-haiku-4-5-20251001",
  at: AT,
});
export const judgment = (
  questionId: string,
  agent: "wiki" | "repo",
  score: 0 | 1,
): JudgmentRecord => ({
  kind: "judgment",
  questionId,
  agent,
  score,
  verdict: {
    facts: [{ fact: "x", essential: true, present: score === 1 }],
    contradicts: false,
    reason: "r",
  },
  reason: score === 1 ? "States the reference." : "Names | another\nfile.",
  usage: { in: 500, out: 100, cacheRead: 0, cacheWrite: 0 },
  usd: 0.0005,
  model: "claude-haiku-4-5-20251001",
  batch: true,
  at: AT,
});

/** Wiki: 3 of 4 right at 20,000 tokens each; repo: 4 of 4 at 80,000 on average, one on its last turn. */
export function records(): RunRecord[] {
  return questions.flatMap((q, i) => [
    answer(q.id, "wiki", 20_000),
    answer(q.id, "repo", i === 0 ? 110_000 : 70_000),
    judgment(q.id, "wiki", i === 3 ? 0 : 1),
    judgment(q.id, "repo", 1),
  ]);
}
