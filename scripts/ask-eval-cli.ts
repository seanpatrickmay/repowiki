import { parseArgs } from "node:util";
import { MAX_ANSWER_WORDS } from "@repowiki/ask";
import { estimateTokens } from "@repowiki/engine";
import {
  type EvalQuestion,
  JUDGE_MAX_TOKENS,
  JUDGE_SYSTEM,
  judgeTurn,
  MAX_JUDGED_ANSWER_CHARS,
  MAX_RETRY_PROBLEM_CHARS,
  QuestionSet,
  retryTurn,
} from "@repowiki/eval";
import { CliError } from "./manifest-cli.ts";
import { DEFAULT_QUESTION_USD } from "./serve-cli.ts";
import { badOption, once, priced } from "./wiki-cli.ts";

export const ASK_EVAL_USAGE =
  "usage: pnpm ask:eval <repo-path> --questions <file> [--set dev|smoke] [--out dir] [--config file.json] [--max-usd N] [--no-batch] [--dry-run]";

/** The run asks no question once its next one could cross this, unless --max-usd says otherwise. */
export const DEFAULT_ASK_EVAL_USD = 1.5;
const MAX_ASK_EVAL_USD = 20;

export interface AskEvalArgs {
  repo: string;
  questions: string;
  set: "dev" | "smoke";
  out: string | null;
  config: string | null;
  maxUsd: number;
  batch: boolean;
  dryRun: boolean;
}

const fail = (problem: string) => new CliError(`${problem}; ${ASK_EVAL_USAGE}`);

/**
 * `<repo> --questions <file>` plus flags (spec v2 #4 §7). Only the dev set (and the fixture's
 * smoke set) runs: the held-out set's value is that nothing has tuned against it (R25), and the
 * history suite is F08's, not the sidebar's.
 */
export function parseAskEvalArgs(argv: readonly string[]): AskEvalArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw badOption(err, ASK_EVAL_USAGE);
  }
  const v = parsed.values;
  const [repo, ...extra] = parsed.positionals;
  if (repo === undefined || repo === "" || extra.length > 0) throw new CliError(ASK_EVAL_USAGE);
  const setText = once("--set", v.set, ASK_EVAL_USAGE) ?? "dev";
  const set = QuestionSet.safeParse(setText);
  if (set.success && set.data === "held-out") {
    throw fail(
      "ask:eval never runs the held-out set: its value is that nothing has tuned against it (spec v2 #4 R25)",
    );
  }
  if (!set.success || (set.data !== "dev" && set.data !== "smoke")) {
    throw fail("--set must be dev (or smoke, for the fixture)");
  }
  const questions = once("--questions", v.questions, ASK_EVAL_USAGE);
  if (questions === undefined) throw fail("--questions is required");
  const usdText = once("--max-usd", v["max-usd"], ASK_EVAL_USAGE) ?? String(DEFAULT_ASK_EVAL_USD);
  const maxUsd = Number(usdText);
  if (!/^\d+(\.\d+)?$/.test(usdText) || !(maxUsd > 0 && maxUsd <= MAX_ASK_EVAL_USD)) {
    throw fail(`--max-usd must be a number of dollars above 0 and up to ${MAX_ASK_EVAL_USD}`);
  }
  return {
    repo,
    questions,
    set: set.data,
    out: once("--out", v.out, ASK_EVAL_USAGE) ?? null,
    config: once("--config", v.config, ASK_EVAL_USAGE) ?? null,
    maxUsd,
    batch: once("--no-batch", v["no-batch"], ASK_EVAL_USAGE) !== true,
    dryRun: once("--dry-run", v["dry-run"], ASK_EVAL_USAGE) === true,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      questions: { type: "string", multiple: true },
      set: { type: "string", multiple: true },
      out: { type: "string", multiple: true },
      config: { type: "string", multiple: true },
      "max-usd": { type: "string", multiple: true },
      "no-batch": { type: "boolean", multiple: true },
      "dry-run": { type: "boolean", multiple: true },
    },
  });
}

/** Output tokens of a typical judgment, as eval:run assumes. */
const ASSUMED_JUDGE_OUTPUT = 600;

export interface AskEvalEstimate {
  questions: number;
  askUsd: number;
  judgeUsd: number;
  /** Every question at its cap, and every judgment retried at its output cap. */
  ceilingUsd: number;
  /** The most one question and its judgment can cost: the next one is asked only if it fits. */
  perQuestionCeilingUsd: number[];
}

/**
 * ask:eval's cost before any call (C12): the typical question's cost on this export, and judging
 * each answer of MAX_ANSWER_WORDS words as eval:run estimates it; the ceiling is every question
 * at the ask's cap and every judgment retried. An unpriced model is a CliError.
 */
export function estimateAskEval(input: {
  questions: readonly EvalQuestion[];
  typicalUsd: number;
  judgeModel: string;
  batchJudge: boolean;
}): AskEvalEstimate {
  let judgeUsd = 0;
  let ceilingUsd = 0;
  const perQuestionCeilingUsd: number[] = [];
  for (const question of input.questions) {
    const turn = judgeTurn(question, "x".repeat(MAX_ANSWER_WORDS * 7));
    judgeUsd += priced(
      input.judgeModel,
      estimateTokens(JUDGE_SYSTEM + turn),
      ASSUMED_JUDGE_OUTPUT,
      input.batchJudge,
    );
    const longest = judgeTurn(question, "x".repeat(MAX_JUDGED_ANSWER_CHARS + 1));
    const retry = retryTurn("x".repeat(MAX_RETRY_PROBLEM_CHARS));
    const judgeCeiling = priced(
      input.judgeModel,
      estimateTokens(JUDGE_SYSTEM + longest) + estimateTokens(JUDGE_SYSTEM + longest + retry),
      2 * JUDGE_MAX_TOKENS,
      input.batchJudge,
    );
    perQuestionCeilingUsd.push(DEFAULT_QUESTION_USD + judgeCeiling);
    ceilingUsd += DEFAULT_QUESTION_USD + judgeCeiling;
  }
  return {
    questions: input.questions.length,
    askUsd: input.typicalUsd * input.questions.length,
    judgeUsd,
    ceilingUsd,
    perQuestionCeilingUsd,
  };
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** The one line ask:eval prints before any call. */
export function askEvalEstimateLine(
  estimate: AskEvalEstimate,
  args: Pick<AskEvalArgs, "set" | "maxUsd" | "batch">,
): string {
  return `${estimate.questions} ${args.set} questions through the ask: about ${money(estimate.askUsd + estimate.judgeUsd)} (asking ${money(estimate.askUsd)}, judging ${money(estimate.judgeUsd)}${args.batch ? ", batched" : ""}), at most ${money(estimate.ceilingUsd)} if every question reaches its ${money(DEFAULT_QUESTION_USD)} cap and every judgment is retried; a question is asked only while it fits under ${money(args.maxUsd)} (--max-usd)`;
}
