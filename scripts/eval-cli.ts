import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { estimateTokens } from "@repowiki/engine";
import {
  Agent,
  type AgentKind,
  ANSWER_WORDS,
  agentSystemPrompt,
  DEFAULT_AGENTS,
  type EvalQuestion,
  EvalRunError,
  type EvalRunOptions,
  type EvalRunResult,
  JUDGE_MAX_TOKENS,
  JUDGE_SYSTEM,
  judgeTurn,
  MAX_JUDGED_ANSWER_CHARS,
  MAX_RETRY_PROBLEM_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TURN_OUTPUT_TOKENS,
  QuestionSet,
  questionTurn,
  retryTurn,
  runEval,
} from "@repowiki/eval";
import {
  type BatchJournal,
  type ClaudeProviderOptions,
  createClaudeProvider,
  type ModelConfig,
  type Provider,
  type TokenLedger,
  type ToolDefinition,
} from "@repowiki/llm";
import { andList } from "@repowiki/query";
import { CliError } from "./manifest-cli.ts";
import { badOption, once, priced, problemLine } from "./wiki-cli.ts";

export const EVAL_USAGE =
  "usage: pnpm eval:run <repo-path> --questions <file> --set dev|held-out|smoke [--agents wiki,repo] [--out dir] [--run-dir dir] [--turns N] [--max-usd N] [--config file.json] [--no-batch] [--dry-run] [--verbose]";

/** Both agents' turn limit unless --turns says otherwise (spec \u00A79: the same for both). */
export const DEFAULT_TURN_LIMIT = 15;
const MAX_TURN_LIMIT = 50;
/** The run asks no further question once it has spent this much, unless --max-usd says otherwise. */
export const DEFAULT_MAX_USD = 5;
/** The highest --max-usd: a typo of a few zeros must not lift the budget stop. */
const MAX_MAX_USD = 100;

export interface EvalArgs {
  repo: string;
  questions: string;
  set: QuestionSet;
  /** --agents, in the order given (the held-out set's, in v1's order); null for wiki,repo. */
  agents: AgentKind[] | null;
  out: string | null;
  runDir: string | null;
  turnLimit: number;
  maxUsd: number;
  config: string | null;
  batch: boolean;
  dryRun: boolean;
  verbose: boolean;
}

const fail = (problem: string) => new CliError(`${problem}; ${EVAL_USAGE}`);

/** `<repo> --questions <file> --set <set>` plus flags; every usage error is a CliError. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw badOption(err, EVAL_USAGE);
  }
  const v = parsed.values;
  const [repo, ...extra] = parsed.positionals;
  if (repo === undefined || repo === "" || extra.length > 0) throw new CliError(EVAL_USAGE);
  const set = QuestionSet.safeParse(once("--set", v.set, EVAL_USAGE));
  if (!set.success) throw fail("--set must be dev, held-out or smoke");
  const questions = once("--questions", v.questions, EVAL_USAGE);
  if (questions === undefined) throw fail("--questions is required");
  const runDir = once("--run-dir", v["run-dir"], EVAL_USAGE) ?? null;
  if (set.data === "held-out" && runDir !== null) {
    throw fail("the held-out set always runs in <out>/eval/held-out, so --run-dir cannot be given");
  }
  let agents = parseAgents(once("--agents", v.agents, EVAL_USAGE));
  if (set.data === "held-out" && agents !== null) {
    const same =
      agents.length === DEFAULT_AGENTS.length && DEFAULT_AGENTS.every((a) => agents?.includes(a));
    if (!same) {
      throw fail(
        "the held-out set is v1's single-use sign-off of the wiki and repo agents, so --agents can only be wiki,repo with it",
      );
    }
    // In any order, the same run as v1's: asked, stored and reported in v1's order.
    agents = [...DEFAULT_AGENTS];
  }
  const turnsText = once("--turns", v.turns, EVAL_USAGE) ?? String(DEFAULT_TURN_LIMIT);
  const turns = Number(turnsText);
  if (!/^\d+$/.test(turnsText) || turns < 1 || turns > MAX_TURN_LIMIT) {
    throw fail(`--turns must be a whole number from 1 to ${MAX_TURN_LIMIT}`);
  }
  const usdText = once("--max-usd", v["max-usd"], EVAL_USAGE) ?? String(DEFAULT_MAX_USD);
  const maxUsd = Number(usdText);
  if (!/^\d+(\.\d+)?$/.test(usdText) || !(maxUsd > 0 && maxUsd <= MAX_MAX_USD)) {
    throw fail(`--max-usd must be a number of dollars above 0 and up to ${MAX_MAX_USD}`);
  }
  return {
    repo,
    questions,
    set: set.data,
    agents,
    out: once("--out", v.out, EVAL_USAGE) ?? null,
    runDir,
    turnLimit: turns,
    maxUsd,
    config: once("--config", v.config, EVAL_USAGE) ?? null,
    batch: once("--no-batch", v["no-batch"], EVAL_USAGE) !== true,
    dryRun: once("--dry-run", v["dry-run"], EVAL_USAGE) === true,
    verbose: once("--verbose", v.verbose, EVAL_USAGE) === true,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      questions: { type: "string", multiple: true },
      set: { type: "string", multiple: true },
      agents: { type: "string", multiple: true },
      out: { type: "string", multiple: true },
      "run-dir": { type: "string", multiple: true },
      turns: { type: "string", multiple: true },
      "max-usd": { type: "string", multiple: true },
      config: { type: "string", multiple: true },
      "no-batch": { type: "boolean", multiple: true },
      "dry-run": { type: "boolean", multiple: true },
      verbose: { type: "boolean", multiple: true },
    },
  });
}

/**
 * Where a run's files go: the held-out set always in `<out>/eval/held-out`, so a second run finds
 * the first; any other set in `--run-dir`, or a new `<out>/eval/<set>-<time>`.
 */
export function runDirFor(out: string, set: QuestionSet, runDir: string | null, now: Date): string {
  if (set === "held-out") return join(out, "eval", "held-out");
  return runDir ?? join(out, "eval", `${set}-${now.toISOString().replace(/[:.]/g, "-")}`);
}

/**
 * Turns an agent is assumed to take on a typical question: the wiki agent searches and reads; the
 * repo agent lists, greps and reads.
 */
export const ASSUMED_TURNS: Readonly<Record<AgentKind, number>> = {
  wiki: 4,
  repo: 8,
};
/** Tokens a typical turn adds to the conversation: one tool call and its result. */
export const ASSUMED_TURN_GROWTH = 2_700;
/** Output tokens of a typical turn, and of a judgment. */
export const ASSUMED_TURN_OUTPUT = 300;
export const ASSUMED_JUDGE_OUTPUT = 600;

/** Input tokens of a conversation whose every turn resends what came before. */
const conversation = (prefix: number, growth: number, turns: number) =>
  turns * prefix + (growth * turns * (turns - 1)) / 2;

export interface EvalEstimate {
  questions: number;
  agents: readonly AgentKind[];
  /** Every agent on every question, with the assumed turns and no cache hits. */
  agentsUsd: number;
  /** The same, per agent. */
  byAgent: Readonly<Partial<Record<AgentKind, number>>>;
  /** Every agent on every question taking every turn with full tool results, no cache hits. */
  ceilingUsd: number;
  judgeUsd: number;
  /** Every judgment retried once, each answer as long as the judge reads, at its output cap. */
  judgeCeilingUsd: number;
}

export interface EvalEstimateInput {
  questions: readonly EvalQuestion[];
  repoName: string;
  turnLimit: number;
  agents: readonly AgentKind[];
  /** Each asked agent's tool definitions. */
  tools: Readonly<Partial<Record<AgentKind, readonly ToolDefinition[]>>>;
  models: Pick<ModelConfig, "evalAgent" | "evalJudge">;
  batchJudge: boolean;
}

/**
 * The run's cost, stated before any call (owner directive), from estimateTokens (2.5 characters
 * a token, so upper-side) and the models' prices. A model with no price is a CliError.
 */
export function estimateEval(input: EvalEstimateInput): EvalEstimate {
  const { turnLimit, models } = input;
  const ceilingGrowth = estimateTokens("x".repeat(MAX_TOOL_RESULT_CHARS)) + MAX_TURN_OUTPUT_TOKENS;
  let agentsUsd = 0;
  const byAgent: Partial<Record<AgentKind, number>> = {};
  let ceilingUsd = 0;
  let judgeUsd = 0;
  let judgeCeilingUsd = 0;
  for (const question of input.questions) {
    for (const agent of input.agents) {
      const prefix = estimateTokens(
        agentSystemPrompt(agent, input.repoName, turnLimit) +
          JSON.stringify(input.tools[agent] ?? []) +
          questionTurn(question.question),
      );
      const turns = Math.min(ASSUMED_TURNS[agent], turnLimit);
      const typical = priced(
        models.evalAgent,
        conversation(prefix, ASSUMED_TURN_GROWTH, turns),
        turns * ASSUMED_TURN_OUTPUT,
        false,
      );
      agentsUsd += typical;
      byAgent[agent] = (byAgent[agent] ?? 0) + typical;
      ceilingUsd += priced(
        models.evalAgent,
        conversation(prefix, ceilingGrowth, turnLimit),
        turnLimit * MAX_TURN_OUTPUT_TOKENS,
        false,
      );
      // An answer of ANSWER_WORDS words is about seven characters a word.
      const turn = judgeTurn(question, "x".repeat(ANSWER_WORDS * 7));
      judgeUsd += priced(
        models.evalJudge,
        estimateTokens(JUDGE_SYSTEM + turn),
        ASSUMED_JUDGE_OUTPUT,
        input.batchJudge,
      );
      // At most: the answer at the judge's cut, and a retry that adds the problem turn.
      const longest = judgeTurn(question, "x".repeat(MAX_JUDGED_ANSWER_CHARS + 1));
      const retry = retryTurn("x".repeat(MAX_RETRY_PROBLEM_CHARS));
      judgeCeilingUsd += priced(
        models.evalJudge,
        estimateTokens(JUDGE_SYSTEM + longest) + estimateTokens(JUDGE_SYSTEM + longest + retry),
        2 * JUDGE_MAX_TOKENS,
        input.batchJudge,
      );
    }
  }
  return {
    questions: input.questions.length,
    agents: input.agents,
    agentsUsd,
    byAgent,
    ceilingUsd,
    judgeUsd,
    judgeCeilingUsd,
  };
}

/** The estimate as the one line eval:run prints before any call, each agent's share named. */
export function estimateLine(
  estimate: EvalEstimate,
  args: Pick<EvalArgs, "turnLimit" | "maxUsd" | "batch">,
): string {
  const money = (x: number) => `$${x.toFixed(2)}`;
  const turns = (agent: AgentKind) => Math.min(ASSUMED_TURNS[agent], args.turnLimit);
  const shares = estimate.agents.map(
    (a) => `${a} ${money(estimate.byAgent[a] ?? 0)} at ${turns(a)} turns`,
  );
  return `${estimate.questions} questions to the ${andList(estimate.agents)} agent${estimate.agents.length === 1 ? "" : "s"}: about ${money(estimate.agentsUsd)} (${shares.join(", ")} a question, no cache hits), at most ${money(estimate.ceilingUsd)} if every question takes all ${args.turnLimit} turns with full tool results; judging about ${money(estimate.judgeUsd)}${args.batch ? " (batched)" : ""}, at most ${money(estimate.judgeCeilingUsd)} if every judgment is retried; no question is asked once the run has spent ${money(args.maxUsd)} (--max-usd)`;
}

/** A run's scores, one per agent it asked, in the order asked: "wiki 7 of 10, repo 5 of 10". */
export function scoreLine(summary: {
  info: { agents: readonly AgentKind[]; questions: readonly unknown[] };
  agents: Readonly<Record<AgentKind, { correct: number }>>;
}): string {
  const n = summary.info.questions.length;
  return summary.info.agents.map((a) => `${a} ${summary.agents[a].correct} of ${n}`).join(", ");
}

/** --agents: a comma-separated list of agent kinds, each once; null when not given. */
export function parseAgents(text: string | undefined): AgentKind[] | null {
  if (text === undefined) return null;
  const names = text.split(",").map((name) => name.trim());
  const agents: AgentKind[] = [];
  for (const name of names) {
    const agent = Agent.safeParse(name);
    if (!agent.success) {
      throw fail(`--agents takes a comma-separated list of ${Agent.options.join(", ")}`);
    }
    if (agents.includes(agent.data)) throw fail(`--agents lists ${agent.data} twice`);
    agents.push(agent.data);
  }
  return agents;
}

/**
 * Refuses a run whose export changed between the read its estimate and identity came from and
 * the build lock: from the lock on no wiki:build or wiki:update can change it, so the run's
 * exportHash names the export the run read.
 */
export function requireSameExport(path: string, bytes: Uint8Array): void {
  let now: Buffer;
  try {
    now = readFileSync(path);
  } catch (error) {
    throw new EvalRunError(`cannot read ${path}`, { cause: error });
  }
  if (!now.equals(bytes)) {
    throw new EvalRunError(
      `${path} changed while eval:run started (a wiki:build or wiki:update ran); run it again`,
    );
  }
}

/**
 * A progress line of eval:run as it is printed: the run's own lines quote question ids and a
 * judge's complaint about an answer, so each is one printable line, redacted of API keys.
 */
export function logLine(line: string): void {
  console.error(problemLine(line));
}

export interface JudgeProviderOptions {
  models: ModelConfig;
  ledger: TokenLedger;
  runId: string;
  /** The wiki store's batch journal (buildJournal), so a killed run's judge batch is collected. */
  journal: BatchJournal;
  log: (line: string) => void;
  /** Replaces the key, the transport or the poll interval; tests only. */
  client?: Pick<ClaudeProviderOptions, "apiKey" | "fetch" | "pollIntervalMs">;
}

/**
 * The judge's provider: Claude, its Message Batches journaled in the wiki store the way
 * wiki:build journals its pages, so a rerun after a kill collects the batch it already paid for.
 */
export function createJudgeProvider(options: JudgeProviderOptions): Provider {
  return createClaudeProvider({
    models: options.models,
    ledger: options.ledger,
    runId: options.runId,
    batchJournal: options.journal,
    onBatchCreated: (b) => options.log(`batch ${b.id} created (${b.requests} requests)`),
    onBatchProgress: (p) =>
      options.log(`batch ${p.id}: ${p.status} (${p.processing} processing, ${p.succeeded} done)`),
    ...options.client,
  });
}

/**
 * runEval, then the journal's flush: the judgments are in results.jsonl by then, so the batch
 * requests their answers came from are forgotten (a kill before this leaves them, and a rerun
 * collects the batch again at no cost). Runs on a failure too, so a rerun never replays an
 * unusable answer. The cost of that: a judgment collected from a batch but not recorded (appending
 * it to results.jsonl failed, e.g. a full disk) is forgotten too, and a rerun pays for it again.
 */
export async function runEvalJournaled(
  journal: { flush(): void },
  options: EvalRunOptions,
): Promise<EvalRunResult> {
  try {
    return await runEval(options);
  } finally {
    journal.flush();
  }
}
