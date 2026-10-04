import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AnswerRecord,
  appendRecord,
  EvalRunError,
  openRun,
  RESULTS_FILE,
  RUN_INFO_FILE,
  type RunInfo,
  readRecords,
  readRunInfo,
} from "./records.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-records-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const info: RunInfo = {
  set: "smoke",
  repo: "sample",
  head: "a".repeat(40),
  exportHash: "e".repeat(64),
  questionsHash: "f".repeat(64),
  writtenOn: null,
  turnLimit: 4,
  models: { evalAgent: "claude-haiku-4-5", evalJudge: "claude-haiku-4-5" },
  buildTokens: null,
  questions: [
    { id: "smoke-where", set: "smoke", kind: "where", question: "Where?", reference: "There." },
  ],
  startedAt: "2026-10-04T12:00:00.000Z",
};

const answer: AnswerRecord = {
  kind: "answer",
  questionId: "smoke-where",
  agent: "wiki",
  answer: "There.",
  stop: "answered",
  turns: 2,
  calls: [{ turn: 1, name: "search", input: { query: "where" }, isError: false }],
  usage: { in: 10, out: 2, cacheRead: 0, cacheWrite: 0 },
  usd: 0.00002,
  model: "claude-haiku-4-5-20251001",
  at: "2026-10-04T12:01:00.000Z",
};

describe("openRun", () => {
  it("writes run.json for a new run and returns the stored one on a resume", () => {
    const runDir = join(dir, "nested", "run");
    expect(openRun(runDir, info)).toEqual(info);
    expect(JSON.parse(readFileSync(join(runDir, RUN_INFO_FILE), "utf8"))).toEqual(info);
    expect(openRun(runDir, { ...info, startedAt: "2026-10-05T00:00:00.000Z" })).toEqual(info);
    expect(readRunInfo(runDir)).toEqual(info);
  });

  it("leaves only run.json in the directory, with no temporary file", () => {
    openRun(dir, info);
    expect(readdirSync(dir)).toEqual([RUN_INFO_FILE]);
  });

  it.each([
    ["exportHash", { exportHash: "0".repeat(64) }],
    ["head", { head: "b".repeat(40) }],
    ["turnLimit", { turnLimit: 5 }],
    ["set", { set: "dev" as const }],
  ])("refuses to resume a run whose %s differs", (field, change) => {
    openRun(dir, info);
    expect(() => openRun(dir, { ...info, ...change })).toThrow(
      new EvalRunError(`${dir} holds another run: its ${field} differs from this one's`),
    );
  });

  it("refuses to resume with other models, and a damaged run.json", () => {
    openRun(dir, info);
    expect(() => openRun(dir, { ...info, models: { ...info.models, evalJudge: "x" } })).toThrow(
      /its models differ/,
    );
    writeFileSync(join(dir, RUN_INFO_FILE), "{");
    expect(() => readRunInfo(dir)).toThrow(
      new EvalRunError(`cannot read ${join(dir, RUN_INFO_FILE)}`),
    );
  });
});

describe("readRecords", () => {
  it("reads every record, and none before the first", () => {
    expect(readRecords(dir)).toEqual([]);
    writeFileSync(join(dir, RESULTS_FILE), `${JSON.stringify(answer)}\n`);
    expect(readRecords(dir)).toEqual([answer]);
  });

  it("drops a last line cut short by a kill, and refuses a damaged line before it", () => {
    writeFileSync(join(dir, RESULTS_FILE), `${JSON.stringify(answer)}\n`);
    appendFileSync(join(dir, RESULTS_FILE), '{"kind":"answer","questionId":"smo');
    expect(readRecords(dir)).toEqual([answer]);
    writeFileSync(join(dir, RESULTS_FILE), `not json\n${JSON.stringify(answer)}\n`);
    expect(() => readRecords(dir)).toThrow(/line 1 is not a run record/);
  });
});

describe("appendRecord", () => {
  const second: AnswerRecord = { ...answer, questionId: "smoke-why", agent: "repo" };

  it("creates the file, and appends one line per record", () => {
    appendRecord(dir, answer);
    appendRecord(dir, second);
    expect(readFileSync(join(dir, RESULTS_FILE), "utf8")).toBe(
      `${JSON.stringify(answer)}\n${JSON.stringify(second)}\n`,
    );
    expect(readRecords(dir)).toEqual([answer, second]);
  });

  it("cuts a line a kill left half-written before it appends, and keeps every whole record", () => {
    writeFileSync(join(dir, RESULTS_FILE), `${JSON.stringify(answer)}\n`);
    appendFileSync(join(dir, RESULTS_FILE), '{"kind":"answer","questionId":"smo');
    expect(readRecords(dir)).toEqual([answer]);
    appendRecord(dir, second);
    expect(readRecords(dir)).toEqual([answer, second]);
    appendRecord(dir, answer);
    appendRecord(dir, second);
    expect(readRecords(dir)).toEqual([answer, second, answer, second]);
  });

  it("cuts a file that holds only a half-written line", () => {
    writeFileSync(join(dir, RESULTS_FILE), '{"kind":"ans');
    appendRecord(dir, answer);
    expect(readRecords(dir)).toEqual([answer]);
  });

  it("keeps a whole record that only lacks its newline", () => {
    writeFileSync(join(dir, RESULTS_FILE), JSON.stringify(answer));
    appendRecord(dir, second);
    expect(readRecords(dir)).toEqual([answer, second]);
  });

  it("refuses to append after a final line that is complete but not a run record", () => {
    writeFileSync(join(dir, RESULTS_FILE), '{"kind":"answer"}');
    expect(() => appendRecord(dir, second)).toThrow(/line 1 is not a run record/);
    expect(readFileSync(join(dir, RESULTS_FILE), "utf8")).toBe('{"kind":"answer"}');
  });
});

describe("a final line that is whole but invalid", () => {
  it("is reported, not dropped, and so is a terminated line that is not JSON", () => {
    writeFileSync(join(dir, RESULTS_FILE), `${JSON.stringify(answer)}\n{"kind":"answer"}\n`);
    expect(() => readRecords(dir)).toThrow(/line 2 is not a run record/);
    writeFileSync(join(dir, RESULTS_FILE), `${JSON.stringify(answer)}\nnot json\n`);
    expect(() => readRecords(dir)).toThrow(/line 2 is not a run record/);
    writeFileSync(join(dir, RESULTS_FILE), `${JSON.stringify(answer)}\n{"kind":"answer"}`);
    expect(() => readRecords(dir)).toThrow(/line 2 is not a run record/);
  });
});
