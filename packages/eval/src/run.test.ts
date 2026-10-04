import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider } from "@repowiki/llm";
import { LlmOutputError } from "@repowiki/llm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JudgeVerdict } from "./judge.ts";
import { loadQuestions, selectQuestions } from "./questions.ts";
import { EvalRunError, RESULTS_FILE, RUN_INFO_FILE, type RunInfo, readRecords } from "./records.ts";
import { createRepoTools } from "./repo-tools.ts";
import { type EvalRunOptions, runEval } from "./run.ts";
import { scriptedToolProvider } from "./test-provider.ts";
import { type SampleWiki, SMOKE_QUESTIONS, sampleWiki } from "./test-wiki.ts";
import { createWikiTools } from "./wiki-tools.ts";

let sample: SampleWiki;
let dir: string;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-eval-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const questions = selectQuestions(loadQuestions(SMOKE_QUESTIONS).file, "smoke");

function info(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    set: "smoke",
    repo: "sample",
    head: sample.sha,
    exportHash: "e".repeat(64),
    questionsHash: "f".repeat(64),
    writtenOn: null,
    turnLimit: 4,
    models: { evalAgent: "claude-haiku-4-5", evalJudge: "claude-haiku-4-5" },
    buildTokens: 50_000,
    questions,
    startedAt: "2026-10-04T12:00:00.000Z",
    ...overrides,
  };
}

const VERDICT: JudgeVerdict = {
  facts: [{ fact: "the answer", essential: true, present: true }],
  contradicts: false,
  reason: "States it.",
};

/** A judge that grades every answer 1, or throws what `fail` returns for an answer, and counts calls. */
function judge(fail: (answer: string) => Error | null = () => null) {
  const requests: GenerateRequest<unknown>[] = [];
  let settledBeforeLastCall = false;
  let open = 0;
  const provider: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      requests.push(request as GenerateRequest<unknown>);
      open++;
      await Promise.resolve();
      if (open < requests.length) settledBeforeLastCall = true;
      const answer = JSON.parse(String(request.messages[0]?.content)).candidate as string;
      const error = fail(answer);
      if (error !== null) throw error;
      return {
        output: request.schema.parse(VERDICT),
        usage: { in: 500, out: 100, cacheRead: 0, cacheWrite: 0 },
        model: "claude-haiku-4-5-20251001",
      };
    },
  };
  return { provider, requests, together: () => !settledBeforeLastCall };
}

function options(overrides: Partial<EvalRunOptions> = {}): EvalRunOptions {
  return {
    runDir: dir,
    info: info(),
    wikiTools: createWikiTools(sample.wiki),
    repoTools: createRepoTools(sample.repo.dir, sample.sha),
    // Every agent answers at once, naming the agent from its system prompt.
    agents: scriptedToolProvider([], (_q, request) => ({
      answer: request.system.includes("wiki") ? "wiki answer" : "repo answer",
    })).provider,
    judge: judge().provider,
    batchJudge: true,
    maxUsd: 5,
    now: () => new Date("2026-10-04T12:30:00Z"),
    ...overrides,
  };
}

describe("runEval", () => {
  it("asks each question to both agents, then judges every answer in one go", async () => {
    const scripted = judge();
    const result = await runEval(options({ judge: scripted.provider }));
    expect(result.stopped).toBeNull();
    expect(result.unjudged).toBe(0);
    const answers = result.records.filter((r) => r.kind === "answer");
    expect(answers.map((r) => `${r.questionId}/${r.agent}`)).toEqual([
      "smoke-where/wiki",
      "smoke-where/repo",
      "smoke-how/wiki",
      "smoke-how/repo",
      "smoke-what-changed/wiki",
      "smoke-what-changed/repo",
    ]);
    expect(result.records.filter((r) => r.kind === "judgment")).toHaveLength(6);
    expect(scripted.requests.every((r) => r.batch === true)).toBe(true);
    expect(scripted.together()).toBe(true);
    expect(readRecords(dir)).toEqual(result.records);
    expect(JSON.parse(readFileSync(join(dir, RUN_INFO_FILE), "utf8"))).toEqual(info());
    // Six agent answers of one turn ($0.0015 each) and six judge calls ($0.001 each, halved).
    expect(result.spentUsd).toBeCloseTo(6 * 0.0015 + 6 * 0.0005, 10);
  });

  it("resumes: asks no question twice and judges only what is unjudged", async () => {
    await runEval(options());
    const lines = readFileSync(join(dir, RESULTS_FILE), "utf8").trimEnd().split("\n");
    // Keep every answer and the first judgment, as if the run was killed while judging.
    writeFileSync(join(dir, RESULTS_FILE), `${lines.slice(0, 7).join("\n")}\n`);
    const agents = scriptedToolProvider([]);
    const scripted = judge();
    const result = await runEval(options({ agents: agents.provider, judge: scripted.provider }));
    expect(agents.requests).toHaveLength(0);
    expect(scripted.requests).toHaveLength(5);
    expect(result.records.filter((r) => r.kind === "judgment")).toHaveLength(6);
  });

  it("refuses a run directory that holds another run", async () => {
    await runEval(options());
    const other = options({ info: info({ questionsHash: "a".repeat(64) }) });
    await expect(runEval(other)).rejects.toThrow(
      new EvalRunError(`${dir} holds another run: its questionsHash differs from this one's`),
    );
  });

  it("stops before the next question once the run has spent --max-usd, and a rerun goes on", async () => {
    const lines: string[] = [];
    const first = await runEval(options({ maxUsd: 0.002, log: (l) => lines.push(l) }));
    expect(first.stopped).toBe("budget");
    expect(first.records.filter((r) => r.kind === "answer")).toHaveLength(2);
    expect(lines).toContain(
      "stopped before smoke-how: this run has spent $0.0030 (--max-usd 0.002)",
    );
    const rest = await runEval(options());
    expect(rest.stopped).toBeNull();
    expect(rest.records.filter((r) => r.kind === "answer")).toHaveLength(6);
  });

  it("leaves an answer the judge cannot grade unjudged, for a rerun to grade", async () => {
    const unusable = () => new LlmOutputError("model output is not JSON", "{");
    const grading = judge((answer) => (answer === "repo answer" ? unusable() : null));
    const lines: string[] = [];
    const result = await runEval(options({ judge: grading.provider, log: (l) => lines.push(l) }));
    expect(result.unjudged).toBe(3);
    expect(result.records.filter((r) => r.kind === "judgment")).toHaveLength(3);
    expect(lines).toContain(
      "smoke-where (repo): the judge's answer for smoke-where was unusable twice; a rerun judges it",
    );
    const rerun = await runEval(options());
    expect(rerun.unjudged).toBe(0);
    expect(rerun.records.filter((r) => r.kind === "judgment")).toHaveLength(6);
  });

  it("counts the tokens of an answer the judge could not grade", async () => {
    const used = {
      usage: { in: 500, out: 100, cacheRead: 0, cacheWrite: 0 },
      model: "claude-haiku-4-5",
    };
    const unusable = () => new LlmOutputError("model output is not JSON", "{", used);
    const grading = judge((answer) => (answer === "repo answer" ? unusable() : null));
    const result = await runEval(options({ judge: grading.provider }));
    // Six agent answers, three graded judgments, and three failed ones of two attempts each.
    expect(result.spentUsd).toBeCloseTo(6 * 0.0015 + 3 * 0.0005 + 3 * 0.001, 10);
  });

  it("records the judgments it was paid for before a provider failure stops the run", async () => {
    const down = judge((answer) =>
      answer === "repo answer" ? new Error("connection reset") : null,
    );
    await expect(runEval(options({ judge: down.provider }))).rejects.toThrow("connection reset");
    const judged = readRecords(dir).filter((r) => r.kind === "judgment");
    expect(judged.map((r) => r.agent)).toEqual(["wiki", "wiki", "wiki"]);
  });
});
