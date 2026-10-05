import { callCostUsd, type Provider, priceFor, type ToolProvider } from "@repowiki/llm";
import type { ToolSet } from "@repowiki/query";
import { runAgent } from "./agent.ts";
import { JudgeError, judgeAnswer } from "./judge.ts";
import { type AgentKind, agentSystemPrompt } from "./prompts.ts";
import type { EvalQuestion } from "./questions.ts";
import {
  type AnswerRecord,
  appendRecord,
  checkRecords,
  EvalRunError,
  openRun,
  type RunInfo,
  type RunRecord,
  readRecords,
} from "./records.ts";

export interface EvalRunOptions {
  runDir: string;
  info: RunInfo;
  /** Each asked agent's tools (info.agents); a ToolSet may answer later (the MCP client's). */
  tools: Partial<Readonly<Record<AgentKind, ToolSet>>>;
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

/** A model with no price: the run could not count what it spends, so it never counts it as free. */
export class UnpricedModelError extends EvalRunError {
  readonly model: string;

  constructor(model: string, options?: ErrorOptions) {
    super(`no price for model ${model}: the run cannot count what it spends`, options);
    this.model = model;
  }
}

const requirePrice = (model: string) => {
  if (priceFor(model) === null) throw new UnpricedModelError(model);
};

/** With --no-batch, the most judge calls in flight at once, so a low rate limit is not flooded. */
export const MAX_DIRECT_JUDGE_CALLS = 4;

/** Runs `tasks` with at most `limit` in flight, and settles them all, in order. */
async function settleAll<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const settled: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        settled[i] = { status: "fulfilled", value: await (tasks[i] as () => Promise<T>)() };
      } catch (reason) {
        settled[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return settled;
}

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]) =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const key = (r: { questionId: string; agent: AgentKind }) => `${r.questionId}\0${r.agent}`;

/**
 * Runs a set (spec §9): each question to every agent of info.agents (side by side, the same
 * model and turn limit), each answer recorded as soon as it exists, then every unjudged answer judged, the
 * judge calls together so they can go as one batch (with --no-batch, at most
 * MAX_DIRECT_JUDGE_CALLS at a time). A rerun with the same run directory resumes: it asks only
 * questions an agent has not answered and judges only unjudged answers, so no question of a
 * held-out set is asked twice. A judgment that fails is recorded with what it cost.
 */
export async function runEval(options: EvalRunOptions): Promise<EvalRunResult> {
  const { runDir, agents, judge } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const info = openRun(runDir, options.info);
  for (const agent of info.agents) {
    if (options.tools[agent] === undefined)
      throw new EvalRunError(`no tools for the ${agent} agent`);
  }
  const records = readRecords(runDir);
  checkRecords(runDir, info, records);
  const append = (record: RunRecord) => {
    appendRecord(runDir, record);
    records.push(record);
  };
  const answered = new Set(records.flatMap((r) => (r.kind === "answer" ? [key(r)] : [])));
  const unaskedQuestions = () =>
    info.questions.some((q) =>
      info.agents.some((agent) => !answered.has(key({ questionId: q.id, agent }))),
    );
  const unjudgedAnswers = () => {
    const judged = new Set(records.flatMap((r) => (r.kind === "judgment" ? [key(r)] : [])));
    return records.flatMap((r) => (r.kind === "answer" && !judged.has(key(r)) ? [r] : []));
  };
  // Refuse an unpriced model before the first paid call, so no spend ever goes uncounted: the one
  // a recorded call reported too, so an unpriced stop holds on a rerun until the model has a price.
  for (const r of records) {
    if (r.usd === null) requirePrice(r.model ?? info.models.evalAgent);
  }
  if (unaskedQuestions()) requirePrice(info.models.evalAgent);
  if (unaskedQuestions() || unjudgedAnswers().length > 0) requirePrice(info.models.evalJudge);
  let spent = 0;
  let stopped: EvalRunResult["stopped"] = null;
  for (const [i, question] of info.questions.entries()) {
    const pending = info.agents.filter(
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
      `[${i + 1}/${info.questions.length}] ${question.id}: asking the ${listed(pending)} agent${pending.length > 1 ? "s" : ""}`,
    );
    const outcomes = await Promise.allSettled(
      pending.map((agent) =>
        runAgent({
          provider: agents,
          system: agentSystemPrompt(agent, info.repo, info.turnLimit),
          tools: options.tools[agent] as ToolSet,
          question: question.question,
          turnLimit: info.turnLimit,
        }),
      ),
    );
    // Every answer that finished was paid for: record it, even when its sibling failed.
    let unpriced: string | null = null;
    for (const [j, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") continue;
      const agent = pending[j] as AgentKind;
      const answer = outcome.value;
      if (answer.usd === null) unpriced ??= answer.model ?? info.models.evalAgent;
      else spent += answer.usd;
      append({
        kind: "answer",
        questionId: question.id,
        agent,
        ...answer,
        at: now().toISOString(),
      });
      answered.add(key({ questionId: question.id, agent }));
    }
    const failure = outcomes.find((o) => o.status === "rejected");
    if (failure !== undefined) throw failure.reason;
    if (unpriced !== null) throw new UnpricedModelError(unpriced);
  }
  const questions = new Map(info.questions.map((q) => [q.id, q]));
  const unjudged = unjudgedAnswers();
  if (unjudged.length > 0)
    log(
      `judging ${unjudged.length} answer${unjudged.length === 1 ? "" : "s"}${options.batchJudge ? " in one batch" : ""}`,
    );
  const settled = await settleAll(
    unjudged.map(
      (r) => () =>
        judgeAnswer(
          judge,
          questions.get(r.questionId) as EvalQuestion,
          r.answer,
          options.batchJudge,
        ),
    ),
    options.batchJudge ? unjudged.length : MAX_DIRECT_JUDGE_CALLS,
  );
  let failed = 0;
  let firstError: unknown = null;
  settled.forEach((outcome, i) => {
    const r = unjudged[i] as AnswerRecord;
    if (outcome.status === "rejected") {
      failed++;
      if (outcome.reason instanceof JudgeError) {
        // The unusable attempts were paid for, though no judgment is recorded: record the cost.
        const cost = callCostUsd(info.models.evalJudge, outcome.reason.usage, options.batchJudge);
        if (cost === null) firstError ??= new UnpricedModelError(info.models.evalJudge);
        else spent += cost;
        append({
          kind: "judge-failure",
          questionId: r.questionId,
          agent: r.agent,
          reason: outcome.reason.message,
          usage: outcome.reason.usage,
          usd: cost,
          model: info.models.evalJudge,
          batch: options.batchJudge,
          at: now().toISOString(),
        });
        log(`${r.questionId} (${r.agent}): ${outcome.reason.message}; a rerun judges it`);
      } else firstError ??= outcome.reason;
      return;
    }
    const j = outcome.value;
    const usd = j.model === null ? 0 : callCostUsd(j.model, j.usage, j.batch);
    if (usd === null) firstError ??= new UnpricedModelError(j.model as string);
    else spent += usd;
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
