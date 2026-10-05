import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GitSha, IsoDateTime, Sha256Hex, TokenUsage } from "@repowiki/core";
import { z } from "zod";
import { JudgeVerdict } from "./judge.ts";
import type { AgentKind } from "./prompts.ts";
import { EvalQuestion, QuestionSet } from "./questions.ts";

export const Agent = z.enum(["wiki", "repo", "mcp", "repo+mcp"] satisfies AgentKind[]);
/** Every agent kind, in the order reports list them. */
export const AGENTS: readonly AgentKind[] = Agent.options;
/** The agents a run asks unless --agents says otherwise: M7's two, so a v1 run is unchanged. */
export const DEFAULT_AGENTS: readonly AgentKind[] = ["wiki", "repo"];

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
  /** The agents asked, each once per question; a run.json from M7 has none and means wiki, repo. */
  agents: z
    .array(Agent)
    .min(1)
    .refine((a) => new Set(a).size === a.length, "an agent is listed twice")
    .default([...DEFAULT_AGENTS]),
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

/**
 * A judgment that failed (the judge's output was unusable twice): no grade, but its calls were
 * paid for, so the report's cost counts them. A rerun judges the answer again.
 */
export const JudgeFailureRecord = z.object({
  kind: z.literal("judge-failure"),
  questionId: z.string().min(1),
  agent: Agent,
  reason: z.string(),
  usage: TokenUsage,
  usd: z.number().nonnegative().nullable(),
  model: z.string().nullable(),
  batch: z.boolean(),
  at: IsoDateTime,
});
export type JudgeFailureRecord = z.infer<typeof JudgeFailureRecord>;

export const RunRecord = z.discriminatedUnion("kind", [
  AnswerRecord,
  JudgmentRecord,
  JudgeFailureRecord,
]);
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
  removeStaleTemporaries(runDir);
  if (!existsSync(join(runDir, RUN_INFO_FILE)) && createRunInfo(runDir, info)) return info;
  const stored = readRunInfo(runDir);
  for (const field of IDENTITY) {
    if (stored[field] !== info[field]) {
      throw new EvalRunError(`${runDir} holds another run: its ${field} differs from this one's`);
    }
  }
  if (stored.agents.join(",") !== info.agents.join(",")) {
    throw new EvalRunError(`${runDir} holds another run: its agents differ from this one's`);
  }
  if (
    stored.models.evalAgent !== info.models.evalAgent ||
    stored.models.evalJudge !== info.models.evalJudge
  ) {
    throw new EvalRunError(`${runDir} holds another run: its models differ from this one's`);
  }
  return stored;
}

const codeOf = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

/**
 * Creates `path` with `text` atomically, never over a file that exists: written to a temporary
 * file, then linked to its name (which fails when the file exists) and the temporary removed, so a
 * kill never leaves a half-written file. Where the file system has no hard links (exFAT, some
 * network shares), the temporary is renamed to the name if nothing holds it yet. Returns false when
 * the file already exists.
 */
export function createOnce(path: string, text: string, link = linkSync): boolean {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text);
    try {
      link(temporary, path);
    } catch (error) {
      const code = codeOf(error);
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") {
        throw error;
      }
      if (existsSync(path)) return false;
      renameSync(temporary, path);
    }
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Removes the temporary files a killed run left in `runDir`: only the eval's own
 * (`run.json.<pid>.tmp`, `report.md.<pid>.tmp`, `spot-check.json.<pid>.tmp`), never another file
 * in a directory the owner chose.
 */
function removeStaleTemporaries(runDir: string): void {
  if (!existsSync(runDir)) return;
  for (const name of readdirSync(runDir)) {
    if (/^(run\.json|report\.md|spot-check\.json)\.\d+\.tmp$/.test(name)) {
      rmSync(join(runDir, name), { force: true });
    }
  }
}

/** Writes run.json once, atomically (createOnce); false when it already exists. */
function createRunInfo(runDir: string, info: RunInfo): boolean {
  mkdirSync(runDir, { recursive: true });
  return createOnce(join(runDir, RUN_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
}

/**
 * Refuses records that no run of `info` writes: a record of a question the run does not hold, or
 * a second answer or judgment of one question by one agent (a run appends each once; a hand-edited
 * or doubly appended file would otherwise be read with the last one winning).
 */
export function checkRecords(runDir: string, info: RunInfo, records: readonly RunRecord[]): void {
  const path = join(runDir, RESULTS_FILE);
  const ids = new Set(info.questions.map((q) => q.id));
  const seen = new Set<string>();
  for (const r of records) {
    if (!ids.has(r.questionId)) {
      throw new EvalRunError(
        `${path} holds a record of ${JSON.stringify(r.questionId)}, which is not one of this run's questions`,
      );
    }
    if (r.kind === "judge-failure") continue;
    const key = `${r.kind}\0${r.questionId}\0${r.agent}`;
    if (seen.has(key)) {
      throw new EvalRunError(
        `${path} holds a second ${r.kind} of ${JSON.stringify(r.questionId)} (${r.agent})`,
      );
    }
    seen.add(key);
  }
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

function parseRecordLine(path: string, lineNumber: number, line: string): RunRecord {
  try {
    return RunRecord.parse(JSON.parse(line));
  } catch (error) {
    throw new EvalRunError(`${path} line ${lineNumber} is not a run record`, { cause: error });
  }
}

/** Whether `line` is not JSON at all: the mark of a write a kill cut short. */
function isCutShort(line: string): boolean {
  try {
    JSON.parse(line);
    return false;
  } catch {
    return true;
  }
}

/**
 * The run's records so far. Only a last line with no newline after it that is not even JSON,
 * the mark of a write a killed run left half done, is dropped (it is redone). Any other line that
 * is not a run record, the last included, is an error: it is a paid result, never silently lost.
 */
export function readRecords(runDir: string): RunRecord[] {
  const path = join(runDir, RESULTS_FILE);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const records: RunRecord[] = [];
  lines.forEach((line, i) => {
    if (line === "") return;
    if (i === lines.length - 1 && isCutShort(line)) return;
    records.push(parseRecordLine(path, i + 1, line));
  });
  return records;
}

/**
 * Appends `record` to the run's results as one line. A file a kill left without a final newline
 * is repaired first: a half-written last line is cut off, so the new record never joins it, and a
 * whole record that only lacks its newline is kept. A last line that is whole but not a run
 * record is refused, as `readRecords` does.
 */
export function appendRecord(runDir: string, record: RunRecord): void {
  const path = join(runDir, RESULTS_FILE);
  const line = `${JSON.stringify(RunRecord.parse(record))}\n`;
  mkdirSync(runDir, { recursive: true });
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    if (text !== "" && !text.endsWith("\n")) {
      const cut = text.lastIndexOf("\n") + 1;
      const tail = text.slice(cut);
      if (isCutShort(tail)) {
        truncateSync(path, Buffer.byteLength(text.slice(0, cut)));
      } else {
        parseRecordLine(path, text.slice(0, cut).split("\n").length, tail);
        appendFileSync(path, "\n");
      }
    }
  }
  appendFileSync(path, line);
}
