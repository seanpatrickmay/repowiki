import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONTROL_CHARACTERS } from "@repowiki/core";
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

const CONTROL = new RegExp(CONTROL_CHARACTERS.source, "u");

/** Text the author wrote: trimmed, not empty, capped, and no control character but a newline. */
const authored = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !CONTROL.test(text.replace(/\n/g, "")), "has a control character");

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
    repo: z.string().min(1),
    writtenOn: z.iso.date(),
    questions: z.array(question(z.enum(["dev", "held-out"]))),
  })
  .superRefine((file, ctx) => {
    addIdIssues(file.questions, ctx);
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
    repo: z.string().min(1),
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

/**
 * Reads and validates a question file. A message names the file and each problem's path, never
 * a question or a reference answer.
 */
export function loadQuestions(path: string): LoadedQuestions {
  let bytes: Buffer;
  let json: unknown;
  try {
    bytes = readFileSync(path);
    json = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new QuestionFileError(`cannot read question file ${path}`, { cause: error });
  }
  const parsed = QuestionFile.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
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
