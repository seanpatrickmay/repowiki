import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadQuestions, QuestionFileError, selectQuestions } from "./questions.ts";

/** The committed smoke file: questions about the test fixture, never the author's eval set. */
const SMOKE_QUESTIONS = fileURLToPath(
  new URL("./__fixtures__/smoke-questions.json", import.meta.url),
);

const KINDS = ["where", "how", "why", "what-changed"] as const;

/**
 * A schema-valid exit-criteria file of placeholder questions about the fixture repo. Test data
 * for the loader only: the real file is the author's and never lives in this repository.
 */
function exitFile(edit: (questions: Record<string, unknown>[]) => void = () => {}) {
  const questions: Record<string, unknown>[] = Array.from({ length: 30 }, (_, i) => ({
    id: `q${String(i + 1).padStart(2, "0")}`,
    set: i < 20 ? "dev" : "held-out",
    kind: KINDS[i % 4],
    question: `Placeholder question ${i + 1} about the sample fixture?`,
    reference: `PLACEHOLDER-REFERENCE-${i + 1}`,
  }));
  edit(questions);
  return { suite: "exit-criteria", repo: "sample", writtenOn: "2026-10-01", questions };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-questions-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(content: unknown): string {
  const path = join(dir, "questions.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("loadQuestions", () => {
  it("loads the author's 30 questions and hashes the file's bytes", () => {
    const { file, hash } = loadQuestions(write(exitFile()));
    expect(file.suite).toBe("exit-criteria");
    expect(file.questions).toHaveLength(30);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(loadQuestions(write(`${JSON.stringify(exitFile())}\n`)).hash).not.toBe(hash);
  });

  it.each([
    [
      "a 19/11 split",
      (q: Record<string, unknown>[]) => Object.assign(q[0] ?? {}, { set: "held-out" }),
    ],
    ["a duplicate id", (q: Record<string, unknown>[]) => Object.assign(q[1] ?? {}, { id: "q01" })],
    [
      "a missing kind",
      (q: Record<string, unknown>[]) => {
        for (const x of q) if (x.kind === "why") x.kind = "how";
      },
    ],
    [
      "an unknown field",
      (q: Record<string, unknown>[]) => Object.assign(q[2] ?? {}, { hint: "x" }),
    ],
    [
      "a control character",
      (q: Record<string, unknown>[]) => Object.assign(q[3] ?? {}, { question: "Where?\u0007" }),
    ],
    [
      "a smoke question",
      (q: Record<string, unknown>[]) => Object.assign(q[4] ?? {}, { set: "smoke" }),
    ],
  ])("refuses %s, naming paths but never a reference answer", (_name, edit) => {
    const path = write(exitFile(edit));
    expect(() => loadQuestions(path)).toThrow(QuestionFileError);
    expect(() => loadQuestions(path)).toThrow(new RegExp(`^invalid question file ${path}: `));
    expect(() => loadQuestions(path)).not.toThrow(/PLACEHOLDER-REFERENCE/);
  });

  it("allows newlines in a reference answer", () => {
    const path = write(exitFile((q) => Object.assign(q[0] ?? {}, { reference: "One.\nTwo." })));
    expect(loadQuestions(path).file.questions[0]?.reference).toBe("One.\nTwo.");
  });

  it("refuses a file it cannot read or parse", () => {
    expect(() => loadQuestions(join(dir, "missing.json"))).toThrow(/^cannot read question file /);
    expect(() => loadQuestions(write("{"))).toThrow(QuestionFileError);
  });
});

describe("selectQuestions", () => {
  it("asks a set's questions in file order", () => {
    const { file } = loadQuestions(write(exitFile()));
    expect(selectQuestions(file, "dev").map((q) => q.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `q${String(i + 1).padStart(2, "0")}`),
    );
    expect(selectQuestions(file, "held-out")).toHaveLength(10);
  });

  it("never runs the smoke file as an eval set, nor the author's file as the smoke set", () => {
    const smoke = loadQuestions(SMOKE_QUESTIONS).file;
    expect(() => selectQuestions(smoke, "dev")).toThrow(/smoke question file/);
    expect(() => selectQuestions(smoke, "held-out")).toThrow(/smoke question file/);
    const author = loadQuestions(write(exitFile())).file;
    expect(() => selectQuestions(author, "smoke")).toThrow(/only the smoke question file/);
  });

  it("finds the committed smoke file: three questions about the fixture repo", () => {
    const { file } = loadQuestions(SMOKE_QUESTIONS);
    expect(file).toMatchObject({ suite: "smoke", repo: "sample" });
    expect(selectQuestions(file, "smoke").map((q) => q.kind)).toEqual([
      "where",
      "how",
      "what-changed",
    ]);
  });
});
