import { join } from "node:path";
import { parseArgs } from "node:util";
import { estimateTokens } from "@repowiki/engine";
import {
  type AgentKind,
  ANSWER_WORDS,
  agentSystemPrompt,
  type EvalQuestion,
  type EvalRunOptions,
  type EvalRunResult,
  JUDGE_SYSTEM,
  judgeTurn,
  MAX_TOOL_RESULT_CHARS,
  MAX_TURN_OUTPUT_TOKENS,
  QuestionSet,
  questionTurn,
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
import { CliError } from "./manifest-cli.ts";
import { priced, problemLine } from "./wiki-cli.ts";

export const EVAL_USAGE =
  "usage: pnpm eval:run <repo-path> --questions <file> --set dev|held-out|smoke [--out dir] [--run-dir dir] [--turns N] [--max-usd N] [--config file.json] [--no-batch] [--dry-run] [--verbose]";

/** Both agents' turn limit unless --turns says otherwise (spec §9: the same for both). */
export const DEFAULT_TURN_LIMIT = 15;
const MAX_TURN_LIMIT = 50;
/** The run asks no further question once it has spent this much, unless --max-usd says otherwise. */
export const DEFAULT_MAX_USD = 5;

export interface EvalArgs {
  repo: string;
  questions: string;
  set: QuestionSet;
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
    const flag = /'(-[^'=\s]*)/.exec((err as Error).message)?.[1];
    const shown = flag?.slice(0, 40).replace(/[^\x21-\x7e]/g, "?");
    throw new CliError(
      `${shown === undefined ? "bad option" : `bad option ${shown}`}; ${EVAL_USAGE}`,
      {
        cause: err,
      },
    );
  }
  const v = parsed.values;
  const [repo, ...extra] = parsed.positionals;
  if (repo === undefined || repo === "" || extra.length > 0) throw new CliError(EVAL_USAGE);
  const set = QuestionSet.safeParse(v.set);
  if (!set.success) throw fail("--set must be dev, held-out or smoke");
  if (v.questions === undefined || v.questions === "") throw fail("--questions is required");
  if (set.data === "held-out" && v["run-dir"] !== undefined) {
    throw fail("the held-out set always runs in <out>/eval/held-out, so --run-dir cannot be given");
  }
  const turns = Number(v.turns ?? DEFAULT_TURN_LIMIT);
  if (!/^\d+$/.test(v.turns ?? "15") || turns < 1 || turns > MAX_TURN_LIMIT) {
    throw fail(`--turns must be a whole number from 1 to ${MAX_TURN_LIMIT}`);
  }
  const maxUsd = Number(v["max-usd"] ?? DEFAULT_MAX_USD);
  if (!/^\d+(\.\d+)?$/.test(v["max-usd"] ?? "5") || !(maxUsd > 0)) {
    throw fail("--max-usd must be a number of dollars above 0");
  }
  return {
    repo,
    questions: v.questions,
    set: set.data,
    out: v.out ?? null,
    runDir: v["run-dir"] ?? null,
    turnLimit: turns,
    maxUsd,
    config: v.config ?? null,
    batch: v["no-batch"] !== true,
    dryRun: v["dry-run"] === true,
    verbose: v.verbose === true,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      questions: { type: "string" },
      set: { type: "string" },
      out: { type: "string" },
      "run-dir": { type: "string" },
      turns: { type: "string" },
      "max-usd": { type: "string" },
      config: { type: "string" },
      "no-batch": { type: "boolean" },
      "dry-run": { type: "boolean" },
      verbose: { type: "boolean" },
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

/** Turns an agent is assumed to take on a typical question: the wiki agent searches and reads. */
export const ASSUMED_TURNS: Readonly<Record<AgentKind, number>> = { wiki: 4, repo: 8 };
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
  /** Both agents on every question, with the assumed turns and no cache hits. */
  agentsUsd: number;
  /** Both agents on every question taking every turn with full tool results, no cache hits. */
  ceilingUsd: number;
  judgeUsd: number;
}

export interface EvalEstimateInput {
  questions: readonly EvalQuestion[];
  repoName: string;
  turnLimit: number;
  tools: Readonly<Record<AgentKind, readonly ToolDefinition[]>>;
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
  let ceilingUsd = 0;
  let judgeUsd = 0;
  for (const question of input.questions) {
    for (const agent of ["wiki", "repo"] as const) {
      const prefix = estimateTokens(
        agentSystemPrompt(agent, input.repoName, turnLimit) +
          JSON.stringify(input.tools[agent]) +
          questionTurn(question.question),
      );
      const turns = Math.min(ASSUMED_TURNS[agent], turnLimit);
      agentsUsd += priced(
        models.evalAgent,
        conversation(prefix, ASSUMED_TURN_GROWTH, turns),
        turns * ASSUMED_TURN_OUTPUT,
        false,
      );
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
    }
  }
  return { questions: input.questions.length, agentsUsd, ceilingUsd, judgeUsd };
}

/** The estimate as the one line eval:run prints before any call. */
export function estimateLine(
  estimate: EvalEstimate,
  args: Pick<EvalArgs, "turnLimit" | "maxUsd" | "batch">,
): string {
  const money = (x: number) => `$${x.toFixed(2)}`;
  return `${estimate.questions} questions to both agents: about ${money(estimate.agentsUsd)} (assuming ${ASSUMED_TURNS.wiki} wiki and ${ASSUMED_TURNS.repo} repo turns a question, no cache hits), at most ${money(estimate.ceilingUsd)} if every question takes all ${args.turnLimit} turns with full tool results; judging about ${money(estimate.judgeUsd)}${args.batch ? " (batched)" : ""}; no question is asked once the run has spent ${money(args.maxUsd)} (--max-usd)`;
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
