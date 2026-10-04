import { callCostUsd, type Provider, type ToolProvider } from "@repowiki/llm";
import { runAgent } from "./agent.ts";
import { JudgeError, judgeAnswer } from "./judge.ts";
import { type AgentKind, agentSystemPrompt } from "./prompts.ts";
import type { EvalQuestion } from "./questions.ts";
import {
  AGENTS,
  type AnswerRecord,
  appendRecord,
  openRun,
  type RunInfo,
  type RunRecord,
  readRecords,
} from "./records.ts";
import type { ToolSet } from "./tools.ts";

export interface EvalRunOptions {
  runDir: string;
  info: RunInfo;
  wikiTools: ToolSet;
  repoTools: ToolSet;
  agents: ToolProvider;
  judge: Provider;
  /** Send the judge calls as one Message Batch (half price); the agents' turns never are. */
  batchJudge: boolean;
  /** Ask no further question once this invocation's agent calls have cost this much. */
  maxUsd: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface EvalRunResult {
  records: RunRecord[];
  /** Why the run stopped before asking every question, or null when it asked them all. */
  stopped: "budget" | null;
  /** What this invocation's calls cost (agents and judge), at the models' prices. */
  spentUsd: number;
  /** Answers the judge could not grade this time; a rerun grades them. */
  unjudged: number;
}

const key = (r: { questionId: string; agent: AgentKind }) => `${r.questionId}\0${r.agent}`;

/**
 * Runs a set (spec §9): each question to both agents (side by side, the same model and turn
 * limit), each answer recorded as soon as it exists, then every unjudged answer judged, the
 * judge calls together so they can go as one batch. A rerun with the same run directory resumes:
 * it asks only questions an agent has not answered and judges only unjudged answers, so no
 * question of a held-out set is asked twice.
 */
export async function runEval(options: EvalRunOptions): Promise<EvalRunResult> {
  const { runDir, wikiTools, repoTools, agents, judge } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const info = openRun(runDir, options.info);
  const records = readRecords(runDir);
  const append = (record: RunRecord) => {
    appendRecord(runDir, record);
    records.push(record);
  };
  const answered = new Set(records.flatMap((r) => (r.kind === "answer" ? [key(r)] : [])));
  let spent = 0;
  let stopped: EvalRunResult["stopped"] = null;
  const tools = { wiki: wikiTools, repo: repoTools };
  for (const [i, question] of info.questions.entries()) {
    const pending = AGENTS.filter(
      (agent) => !answered.has(key({ questionId: question.id, agent })),
    );
    if (pending.length === 0) continue;
    if (spent >= options.maxUsd) {
      stopped = "budget";
      log(
        `stopped before ${question.id}: this run has spent $${spent.toFixed(4)} (--max-usd ${options.maxUsd})`,
      );
      break;
    }
    log(
      `[${i + 1}/${info.questions.length}] ${question.id}: asking the ${pending.join(" and ")} agent${pending.length > 1 ? "s" : ""}`,
    );
    const answers = await Promise.all(
      pending.map((agent) =>
        runAgent({
          provider: agents,
          system: agentSystemPrompt(agent, info.repo, info.turnLimit),
          tools: tools[agent],
          question: question.question,
          turnLimit: info.turnLimit,
        }),
      ),
    );
    answers.forEach((answer, j) => {
      const agent = pending[j] as AgentKind;
      spent += answer.usd ?? 0;
      append({
        kind: "answer",
        questionId: question.id,
        agent,
        ...answer,
        at: now().toISOString(),
      });
      answered.add(key({ questionId: question.id, agent }));
    });
  }
  const judged = new Set(records.flatMap((r) => (r.kind === "judgment" ? [key(r)] : [])));
  const questions = new Map(info.questions.map((q) => [q.id, q]));
  const unjudged = records.flatMap((r) => (r.kind === "answer" && !judged.has(key(r)) ? [r] : []));
  if (unjudged.length > 0)
    log(`judging ${unjudged.length} answers${options.batchJudge ? " in one batch" : ""}`);
  const settled = await Promise.allSettled(
    unjudged.map((r) =>
      judgeAnswer(judge, questions.get(r.questionId) as EvalQuestion, r.answer, options.batchJudge),
    ),
  );
  let failed = 0;
  let firstError: unknown = null;
  settled.forEach((outcome, i) => {
    const r = unjudged[i] as AnswerRecord;
    if (outcome.status === "rejected") {
      failed++;
      if (outcome.reason instanceof JudgeError) {
        // The unusable attempts were paid for, though no judgment is recorded.
        spent += callCostUsd(info.models.evalJudge, outcome.reason.usage, options.batchJudge) ?? 0;
        log(`${r.questionId} (${r.agent}): ${outcome.reason.message}; a rerun judges it`);
      } else firstError ??= outcome.reason;
      return;
    }
    const j = outcome.value;
    const usd = j.model === null ? 0 : callCostUsd(j.model, j.usage, j.batch);
    spent += usd ?? 0;
    append({
      kind: "judgment",
      questionId: r.questionId,
      agent: r.agent,
      ...j,
      usd,
      at: now().toISOString(),
    });
  });
  // Paid judgments are recorded first; a provider failure then stops the run, and a rerun goes on.
  if (firstError !== null) throw firstError;
  return { records, stopped, spentUsd: spent, unjudged: failed };
}
