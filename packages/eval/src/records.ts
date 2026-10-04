import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitSha, IsoDateTime, Sha256Hex, TokenUsage } from "@repowiki/core";
import { z } from "zod";
import { JudgeVerdict } from "./judge.ts";
import type { AgentKind } from "./prompts.ts";
import { EvalQuestion, QuestionSet } from "./questions.ts";

export const AGENTS: readonly AgentKind[] = ["wiki", "repo"];
const Agent = z.enum(["wiki", "repo"]);

/** What a run is: the questions, the wiki and repository, and the settings both agents share. */
export const RunInfo = z.object({
  set: QuestionSet,
  repo: z.string().min(1),
  /** The wiki's sha: the repo agent reads the repository at this commit. */
  head: GitSha,
  /** SHA-256 of export.json, and of the question file, when the run began. */
  exportHash: Sha256Hex,
  questionsHash: Sha256Hex,
  /** The author's statement of when he wrote the questions; null for the smoke set. */
  writtenOn: z.iso.date().nullable(),
  turnLimit: z.int().positive(),
  models: z.object({ evalAgent: z.string().min(1), evalJudge: z.string().min(1) }),
  /** The build's tokens from the export's runs (all four classes), or null when it has none. */
  buildTokens: z.int().nonnegative().nullable(),
  questions: z.array(EvalQuestion).min(1),
  startedAt: IsoDateTime,
});
export type RunInfo = z.infer<typeof RunInfo>;

export const AnswerRecord = z.object({
  kind: z.literal("answer"),
  questionId: z.string().min(1),
  agent: Agent,
  answer: z.string(),
  stop: z.enum(["answered", "turn-limit", "max-tokens", "other"]),
  turns: z.int().positive(),
  calls: z.array(
    z.object({
      turn: z.int().positive(),
      name: z.string(),
      input: z.unknown(),
      isError: z.boolean(),
    }),
  ),
  usage: TokenUsage,
  usd: z.number().nonnegative().nullable(),
  model: z.string().nullable(),
  at: IsoDateTime,
});
export type AnswerRecord = z.infer<typeof AnswerRecord>;

export const JudgmentRecord = z.object({
  kind: z.literal("judgment"),
  questionId: z.string().min(1),
  agent: Agent,
  score: z.union([z.literal(0), z.literal(1)]),
  verdict: JudgeVerdict.nullable(),
  reason: z.string(),
  usage: TokenUsage,
  usd: z.number().nonnegative().nullable(),
  model: z.string().nullable(),
  batch: z.boolean(),
  at: IsoDateTime,
});
export type JudgmentRecord = z.infer<typeof JudgmentRecord>;

export const RunRecord = z.discriminatedUnion("kind", [AnswerRecord, JudgmentRecord]);
export type RunRecord = z.infer<typeof RunRecord>;

export const RUN_INFO_FILE = "run.json";
export const RESULTS_FILE = "results.jsonl";

/** A run directory that cannot be used: another run's, or unreadable. */
export class EvalRunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The fields that make two runs the same run; a resumed run must match on every one. */
const IDENTITY = ["set", "repo", "head", "exportHash", "questionsHash", "turnLimit"] as const;

/**
 * Opens `runDir` for `info`: a new directory gets run.json; an existing one must hold the same
 * run (same set, wiki, question file, turn limit and models), so a resume never mixes two runs
 * and a held-out run cannot be repeated against a changed question file or wiki.
 */
export function openRun(runDir: string, info: RunInfo): RunInfo {
  const path = join(runDir, RUN_INFO_FILE);
  if (!existsSync(path)) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, { flag: "wx" });
    return info;
  }
  const stored = readRunInfo(runDir);
  for (const field of IDENTITY) {
    if (stored[field] !== info[field]) {
      throw new EvalRunError(`${runDir} holds another run: its ${field} differs from this one's`);
    }
  }
  if (
    stored.models.evalAgent !== info.models.evalAgent ||
    stored.models.evalJudge !== info.models.evalJudge
  ) {
    throw new EvalRunError(`${runDir} holds another run: its models differ from this one's`);
  }
  return stored;
}

/** The run.json of an existing run directory. */
export function readRunInfo(runDir: string): RunInfo {
  const path = join(runDir, RUN_INFO_FILE);
  try {
    return RunInfo.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new EvalRunError(`cannot read ${path}`, { cause: error });
  }
}

/** The run's records so far. A last line cut short by a killed run is dropped; it is redone. */
export function readRecords(runDir: string): RunRecord[] {
  const path = join(runDir, RESULTS_FILE);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const records: RunRecord[] = [];
  lines.forEach((line, i) => {
    if (line === "") return;
    try {
      records.push(RunRecord.parse(JSON.parse(line)));
    } catch (error) {
      const last = lines.slice(i + 1).every((rest) => rest === "");
      if (!last)
        throw new EvalRunError(`${path} line ${i + 1} is not a run record`, { cause: error });
    }
  });
  return records;
}
