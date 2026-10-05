import { createHash } from "node:crypto";
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

/** The committed history smoke file: questions about historyWiki(), never the owner's suite. */
const HISTORY_SMOKE = fileURLToPath(
  new URL("./__fixtures__/history-smoke-questions.json", import.meta.url),
);

const KINDS = ["where", "how", "why", "what-changed"] as const;

/** A schema-valid history suite of placeholder questions (spec v2 #5 §8.1). Test data only. */
function historyFile(edit: (questions: Record<string, unknown>[]) => void = () => {}) {
  const questions: Record<string, unknown>[] = Array.from({ length: 10 }, (_, i) => ({
    id: `h${String(i + 1).padStart(2, "0")}`,
    set: "history",
    kind: i < 5 ? "as-of" : "what-changed",
    question: `Placeholder history question ${i + 1}?`,
    reference: `PLACEHOLDER-HISTORY-${i + 1}`,
  }));
  edit(questions);
  return { suite: "history", repo: "sample", writtenOn: "2026-10-05", questions };
}

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
    [
      "a zero-width space",
      (q: Record<string, unknown>[]) => Object.assign(q[5] ?? {}, { question: "Where\u200B?" }),
    ],
    [
      "a tag character in a reference",
      (q: Record<string, unknown>[]) =>
        Object.assign(q[6] ?? {}, { reference: "PLACEHOLDER-REFERENCE\u{E0041}" }),
    ],
    [
      "a held-out question that repeats a dev one",
      (q: Record<string, unknown>[]) =>
        Object.assign(q[25] ?? {}, {
          question: " placeholder QUESTION 1 about the  sample fixture? ",
        }),
    ],
    ["a 21/9 split", (q: Record<string, unknown>[]) => Object.assign(q[29] ?? {}, { set: "dev" })],
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

  it("refuses a file it cannot read or parse, in words that tell the two apart", () => {
    expect(() => loadQuestions(join(dir, "missing.json"))).toThrow(/^cannot read question file /);
    expect(() => loadQuestions(dir)).toThrow(`cannot read question file ${dir}: not a file`);
    const bad = write('{"HELDOUT ANSWER text": 1,');
    expect(() => loadQuestions(bad)).toThrow(
      new QuestionFileError(`question file ${bad} is not JSON`),
    );
    try {
      loadQuestions(bad);
    } catch (error) {
      // No cause: JSON.parse's message quotes the file's text.
      expect((error as Error).cause).toBeUndefined();
    }
    const big = write(" ".repeat(1024 * 1024 + 1));
    expect(() => loadQuestions(big)).toThrow(`question file ${big} is over the 1 MiB limit`);
  });

  it("names an unknown key only as a short printable quote", () => {
    const path = write({ ...exitFile(), [`\u001b[31m${"k".repeat(200)}`]: 1 });
    const message = (() => {
      try {
        loadQuestions(path);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('unrecognized key "\uFFFD[31mkkk');
    expect(message).not.toContain("\u001b");
    expect(message.length).toBeLessThan(path.length + 150);
  });

  it("refuses a repo name that is not one, and hashes the file's exact bytes", () => {
    for (const repo of ["../../etc", "a\nb", "x".repeat(101), ""]) {
      expect(() => loadQuestions(write({ ...exitFile(), repo })), repo).toThrow(/repo: /);
    }
    const text = JSON.stringify(exitFile());
    expect(loadQuestions(write(text)).hash).toBe(createHash("sha256").update(text).digest("hex"));
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

describe("the history suite", () => {
  it("loads 10 as-of and what-changed questions and runs them only as the history set", () => {
    const { file } = loadQuestions(write(historyFile()));
    expect(selectQuestions(file, "history")).toHaveLength(10);
    expect(() => selectQuestions(file, "dev")).toThrow(/run it with --set history/);
    const author = loadQuestions(write(exitFile())).file;
    expect(() => selectQuestions(author, "history")).toThrow(
      /--set history runs only the history question file/,
    );
  });

  it("needs 8 to 20 questions, two of each kind, and no kind of v1's", () => {
    expect(() => loadQuestions(write(historyFile((q) => q.splice(7))))).toThrow(QuestionFileError);
    expect(() =>
      loadQuestions(
        write(
          historyFile((q) => {
            for (const x of q.slice(0, -1)) x.kind = "as-of";
          }),
        ),
      ),
    ).toThrow(/at least 2 what-changed questions, found 1/);
    expect(() =>
      loadQuestions(
        write(
          historyFile((q) => {
            Object.assign(q[0] ?? {}, { kind: "where" });
          }),
        ),
      ),
    ).toThrow(QuestionFileError);
  });

  it("keeps the as-of kind out of the author's exit-criteria file", () => {
    expect(() =>
      loadQuestions(
        write(
          exitFile((q) => {
            Object.assign(q[0] ?? {}, { kind: "as-of" });
          }),
        ),
      ),
    ).toThrow(QuestionFileError);
  });

  it("finds the committed history smoke file: three questions about historyWiki()", () => {
    const { file } = loadQuestions(HISTORY_SMOKE);
    expect(file).toMatchObject({ suite: "smoke", repo: "sample" });
    expect(selectQuestions(file, "smoke").map((q) => q.kind)).toEqual([
      "as-of",
      "as-of",
      "what-changed",
    ]);
  });
});
