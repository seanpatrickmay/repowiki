import { createHash } from "node:crypto";
import { z } from "zod";
import { JudgeVerdict, judgedAnswer, visibleText } from "./judge.ts";
import { AGENTS, type JudgmentRecord, type RunInfo, type RunRecord } from "./records.ts";

/** Spec §9: the author spot-checks 10 of the judgments. */
export const SPOT_CHECK_SIZE = 10;
export const SPOT_CHECK_FILE = "spot-check.json";

export const SpotCheck = z.object({
  instructions: z.string(),
  judgments: z.array(
    z.object({
      questionId: z.string(),
      agent: z.enum(["wiki", "repo"]),
      question: z.string(),
      reference: z.string(),
      answer: z.string(),
      judgeScore: z.union([z.literal(0), z.literal(1)]),
      judgeReason: z.string(),
      facts: JudgeVerdict.shape.facts.nullable(),
      /** The owner's own grade: 0 or 1, null until he marks it. */
      owner: z.union([z.literal(0), z.literal(1), z.null()]),
    }),
  ),
});
export type SpotCheck = z.infer<typeof SpotCheck>;

const INSTRUCTIONS =
  'Grade each answer against its reference yourself: set "owner" to 1 (correct) or 0 (wrong). Then run pnpm eval:report on this run directory; the report counts how often you agree with the judge.';

/**
 * Ten judgments for the owner to grade (spec §9), drawn evenly from both agents in an order fixed
 * by the run's start time, so the sample does not depend on which answers the judge got right. The
 * question, reference and answer are shown as the judge read them (`visibleText`, the answer cut
 * included), so the owner sees exactly the text the judge was given.
 */
export function spotCheckSample(info: RunInfo, records: readonly RunRecord[]): SpotCheck {
  const answers = new Map(
    records.flatMap((r) =>
      r.kind === "answer" ? [[`${r.questionId}\0${r.agent}`, r.answer] as const] : [],
    ),
  );
  const questions = new Map(info.questions.map((q) => [q.id, q]));
  const order = (j: JudgmentRecord) =>
    createHash("sha256").update(`${info.startedAt}\0${j.questionId}\0${j.agent}`).digest("hex");
  const judgments = records.flatMap((r) => (r.kind === "judgment" ? [r] : []));
  const byAgent = AGENTS.map((agent) =>
    judgments.filter((j) => j.agent === agent).sort((a, b) => (order(a) < order(b) ? -1 : 1)),
  );
  const picked: JudgmentRecord[] = [];
  for (let i = 0; picked.length < SPOT_CHECK_SIZE && byAgent.some((list) => i < list.length); i++) {
    for (const list of byAgent) {
      const j = list[i];
      if (j !== undefined && picked.length < SPOT_CHECK_SIZE) picked.push(j);
    }
  }
  return {
    instructions: INSTRUCTIONS,
    judgments: picked.map((j) => ({
      questionId: j.questionId,
      agent: j.agent,
      question: visibleText(questions.get(j.questionId)?.question ?? ""),
      reference: visibleText(questions.get(j.questionId)?.reference ?? ""),
      answer: judgedAnswer(answers.get(`${j.questionId}\0${j.agent}`) ?? ""),
      judgeScore: j.score,
      judgeReason: j.reason,
      facts: j.verdict?.facts ?? null,
      owner: null,
    })),
  };
}
