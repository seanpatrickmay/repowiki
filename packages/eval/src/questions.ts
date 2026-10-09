import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { INVISIBLE_CHARACTERS } from "@repowiki/core";
import { cut, oneLine } from "@repowiki/query";
import { z } from "zod";

/** Spec §9's four kinds of question. */
export const QuestionKind = z.enum(["where", "how", "why", "what-changed"]);
export type QuestionKind = z.infer<typeof QuestionKind>;

/** Which questions a run asks: the author's dev or held-out set, or the fixture's smoke set. */
export const QuestionSet = z.enum(["dev", "held-out", "smoke"]);
export type QuestionSet = z.infer<typeof QuestionSet>;

/** Spec §9: 30 questions, 20 dev and 10 held out. */
export const EXIT_CRITERIA_COUNTS = { dev: 20, "held-out": 10 } as const;

export const MAX_QUESTION_LENGTH = 1000;
export const MAX_REFERENCE_LENGTH = 2000;

/** The largest question file read; the author's 30 questions are a few tens of KB. */
export const MAX_QUESTION_FILE_BYTES = 1024 * 1024;

const INVISIBLE = new RegExp(INVISIBLE_CHARACTERS.source, "u");

/**
 * Text the author wrote: trimmed, not empty, capped, and no control or invisible format character
 * but a newline (a zero-width space or a tag character would hide text from the reader).
 */
const authored = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (text) => !INVISIBLE.test(text.replace(/\n/g, "")),
      "has a control or invisible character",
    );

/** A repository's name, as the export holds it: printed in every report, so a plain name. */
const RepoName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "expected a repository name");

/** Questions asked again in another set, by their text with case and spacing ignored. */
function addRepeatIssues(
  questions: readonly { set: string; question: string }[],
  ctx: z.RefinementCtx,
) {
  const first = new Map<string, { set: string; index: number }>();
  questions.forEach(({ set, question }, index) => {
    const key = question.toLowerCase().replace(/\s+/g, " ").trim();
    const seen = first.get(key);
    if (seen === undefined) first.set(key, { set, index });
    else if (seen.set !== set) {
      ctx.addIssue({
        code: "custom",
        message: `repeats question ${seen.index} of the ${seen.set} set`,
        path: ["questions", index, "question"],
      });
    }
  });
}

const question = <S extends z.ZodType<QuestionSet>>(set: S) =>
  z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "expected a short kebab-case id"),
    set,
    kind: QuestionKind,
    question: authored(MAX_QUESTION_LENGTH),
    reference: authored(MAX_REFERENCE_LENGTH),
  });

export const EvalQuestion = question(QuestionSet);
export type EvalQuestion = z.infer<typeof EvalQuestion>;

function addIdIssues(questions: readonly { id: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  questions.forEach(({ id }, index) => {
    if (seen.has(id)) {
      ctx.addIssue({ code: "custom", message: `duplicate id ${id}`, path: ["questions", index] });
    }
    seen.add(id);
  });
}

/**
 * The author's question file (spec §9): 30 questions with reference answers about one repo, 20
 * dev and 10 held out, covering all four kinds. `writtenOn` is the author's statement of when he
 * wrote them; every report prints it.
 */
export const ExitCriteriaQuestions = z
  .strictObject({
    suite: z.literal("exit-criteria"),
    repo: RepoName,
    writtenOn: z.iso.date(),
    questions: z.array(question(z.enum(["dev", "held-out"]))),
  })
  .superRefine((file, ctx) => {
    addIdIssues(file.questions, ctx);
    addRepeatIssues(file.questions, ctx);
    for (const set of ["dev", "held-out"] as const) {
      const n = file.questions.filter((q) => q.set === set).length;
      if (n !== EXIT_CRITERIA_COUNTS[set]) {
        const message = `expected ${EXIT_CRITERIA_COUNTS[set]} ${set} questions, found ${n}`;
        ctx.addIssue({ code: "custom", message, path: ["questions"] });
      }
    }
    for (const kind of QuestionKind.options) {
      if (!file.questions.some((q) => q.kind === kind)) {
        ctx.addIssue({ code: "custom", message: `no ${kind} question`, path: ["questions"] });
      }
    }
  });

/** A few questions about the test fixture: they check the harness end to end and score nothing. */
export const SmokeQuestions = z
  .strictObject({
    suite: z.literal("smoke"),
    repo: RepoName,
    questions: z
      .array(question(z.literal("smoke")))
      .min(1)
      .max(5),
  })
  .superRefine((file, ctx) => addIdIssues(file.questions, ctx));

export const QuestionFile = z.discriminatedUnion("suite", [ExitCriteriaQuestions, SmokeQuestions]);
export type QuestionFile = z.infer<typeof QuestionFile>;

/** A question file that cannot be read, or holds the wrong questions for the run. */
export class QuestionFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface LoadedQuestions {
  file: QuestionFile;
  /** SHA-256 of the file's bytes: the held-out guard refuses a file changed after its run. */
  hash: string;
}

/** A key the file chose, as an error message shows it: one short printable quoted line. */
const quote = (key: PropertyKey) => JSON.stringify(cut(oneLine(String(key)), 40));

/** A schema problem as one line: its path and message, every file-chosen key quoted. */
function problem(issue: z.core.$ZodIssue): string {
  const path = issue.path
    .map((p) =>
      typeof p === "number" || /^[A-Za-z0-9_-]{1,40}$/.test(String(p)) ? String(p) : quote(p),
    )
    .join(".");
  const message =
    issue.code === "unrecognized_keys"
      ? `unrecognized key${issue.keys.length === 1 ? "" : "s"} ${issue.keys.slice(0, 3).map(quote).join(", ")}${issue.keys.length > 3 ? ` and ${issue.keys.length - 3} more` : ""}`
      : issue.message;
  return `${path || "(root)"}: ${message}`;
}

/**
 * Reads and validates a question file (a regular file of at most 1 MiB). A message names the
 * file and each problem's path, never a question or a reference answer; a file that is not JSON
 * carries no cause, as JSON.parse's message quotes the file's text.
 */
export function loadQuestions(path: string): LoadedQuestions {
  let bytes: Buffer;
  try {
    const stat = statSync(path);
    if (!stat.isFile())
      throw new QuestionFileError(`cannot read question file ${path}: not a file`);
    if (stat.size > MAX_QUESTION_FILE_BYTES) {
      throw new QuestionFileError(`question file ${path} is over the 1 MiB limit`);
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof QuestionFileError) throw error;
    throw new QuestionFileError(`cannot read question file ${path}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new QuestionFileError(`question file ${path} is not JSON`);
  }
  const parsed = QuestionFile.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 10).map(problem);
    throw new QuestionFileError(`invalid question file ${path}: ${problems.join("; ")}`);
  }
  return { file: parsed.data, hash: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * The questions a run asks, in file order. The smoke file runs only as the smoke set, and the
 * author's file never does, so the two can never be mistaken for each other.
 */
export function selectQuestions(file: QuestionFile, set: QuestionSet): EvalQuestion[] {
  if (file.suite === "smoke" && set !== "smoke") {
    throw new QuestionFileError("this is the smoke question file; run it with --set smoke");
  }
  if (file.suite === "exit-criteria" && set === "smoke") {
    throw new QuestionFileError("--set smoke runs only the smoke question file");
  }
  return file.questions.filter((q) => q.set === set);
}
