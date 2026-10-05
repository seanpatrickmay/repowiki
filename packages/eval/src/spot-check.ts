import { createHash } from "node:crypto";
import { z } from "zod";
import { judgedAnswer, visibleText } from "./judge.ts";
import type { AgentKind } from "./prompts.ts";
import { QuestionSet } from "./questions.ts";
import { EvalRunError, type JudgmentRecord, type RunInfo, type RunRecord } from "./records.ts";
import { latestRecords } from "./summary.ts";

/** Spec §9: the author spot-checks 10 of the judgments. */
export const SPOT_CHECK_SIZE = 10;
export const SPOT_CHECK_FILE = "spot-check.json";

/**
 * The owner's spot-check file. It is blind: each answer is shown with its question and reference
 * only, under an opaque entry key, so neither the agent that wrote it nor the judge's grade or
 * reason can anchor the owner's own grade. The report joins the key back to results.jsonl.
 */
export const SpotCheck = z.object({
  instructions: z.string(),
  /** The run the sample was drawn from; a file from another run is refused. */
  run: z.object({
    set: QuestionSet,
    repo: z.string(),
    head: z.string(),
    startedAt: z.string(),
  }),
  answers: z.array(
    z.object({
      entry: z.string().regex(/^[0-9a-f]{16}$/),
      questionId: z.string(),
      question: z.string(),
      reference: z.string(),
      answer: z.string(),
      /** The owner's own grade: 0 or 1, null until he marks it. */
      owner: z.union([z.literal(0), z.literal(1), z.null()]),
    }),
  ),
});
export type SpotCheck = z.infer<typeof SpotCheck>;

const INSTRUCTIONS =
  'Grade each answer against its reference yourself: set "owner" to the number 1 if the answer is correct or the number 0 if it is wrong, and change nothing else. The file does not say which agent wrote an answer or how the judge graded it. Then run pnpm eval:report on this run directory: the report counts how often you agree with the judge and shows the judge\'s reason where you do not.';

/** An answer's opaque key in the spot-check file, fixed by the run's start time. */
export function spotCheckEntry(startedAt: string, questionId: string, agent: AgentKind): string {
  return createHash("sha256")
    .update(`${startedAt}\0${questionId}\0${agent}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Ten judgments for the owner to grade (spec §9), drawn evenly from the run's agents in an order fixed
 * by the run's start time, so the sample does not depend on which answers the judge got right; the
 * file lists them by entry key, so their order does not tell the agents apart either. The
 * question, reference and answer are shown as the judge read them (`visibleText`, the answer cut
 * included), so the owner sees exactly the text the judge was given. A judgment whose question or
 * answer the run does not hold is an error, never a blank.
 */
export function spotCheckSample(info: RunInfo, records: readonly RunRecord[]): SpotCheck {
  const { answers, judgments } = latestRecords(records);
  const questions = new Map(info.questions.map((q) => [q.id, q]));
  const entry = (j: JudgmentRecord) => spotCheckEntry(info.startedAt, j.questionId, j.agent);
  const byAgent = info.agents.map((agent) =>
    [...judgments.values()]
      .filter((j) => j.agent === agent)
      .sort((a, b) => entry(a).localeCompare(entry(b)) || a.questionId.localeCompare(b.questionId)),
  );
  const picked: JudgmentRecord[] = [];
  for (let i = 0; picked.length < SPOT_CHECK_SIZE && byAgent.some((list) => i < list.length); i++) {
    for (const list of byAgent) {
      const j = list[i];
      if (j !== undefined && picked.length < SPOT_CHECK_SIZE) picked.push(j);
    }
  }
  picked.sort((a, b) => entry(a).localeCompare(entry(b)));
  return {
    instructions: INSTRUCTIONS,
    run: { set: info.set, repo: info.repo, head: info.head, startedAt: info.startedAt },
    answers: picked.map((j) => {
      const question = questions.get(j.questionId);
      const answer = answers.get(`${j.questionId}\0${j.agent}`);
      if (question === undefined || answer === undefined) {
        throw new EvalRunError(
          `the run holds a judgment of ${JSON.stringify(j.questionId)} (${j.agent}) without its ${question === undefined ? "question" : "answer"}`,
        );
      }
      return {
        entry: entry(j),
        questionId: j.questionId,
        question: visibleText(question.question),
        reference: visibleText(question.reference),
        answer: judgedAnswer(answer.answer),
        owner: null,
      };
    }),
  };
}
