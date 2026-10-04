import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, ToolProvider } from "@repowiki/llm";
import { LlmOutputError } from "@repowiki/llm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JudgeVerdict } from "./judge.ts";
import { loadQuestions, selectQuestions } from "./questions.ts";
import { EvalRunError, RESULTS_FILE, RUN_INFO_FILE, type RunInfo, readRecords } from "./records.ts";
import { createRepoTools } from "./repo-tools.ts";
import { type EvalRunOptions, MAX_DIRECT_JUDGE_CALLS, runEval, UnpricedModelError } from "./run.ts";
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
  // How many calls had been made when each call settled: all of them, if the calls were made together.
  const madeWhenSettled: number[] = [];
  const provider: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      requests.push(request as GenerateRequest<unknown>);
      await Promise.resolve();
      madeWhenSettled.push(requests.length);
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
  return { provider, requests, madeWhenSettled };
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
    // No judge call settled before the last was made: one batch, not six calls in a row.
    expect(scripted.madeWhenSettled).toEqual([6, 6, 6, 6, 6, 6]);
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
    // What the failed judgments spent is recorded, so the report's cost line counts it too.
    const failures = readRecords(dir).filter((r) => r.kind === "judge-failure");
    expect(failures.map((r) => r.agent)).toEqual(["repo", "repo", "repo"]);
    expect(failures[0]).toMatchObject({
      questionId: "smoke-where",
      reason: "the judge's answer for smoke-where was unusable twice",
      usage: { in: 1000, out: 200, cacheRead: 0, cacheWrite: 0 },
      usd: 0.001,
      batch: true,
    });
    // A rerun judges those answers again: a failure is not a judgment.
    const rerun = await runEval(options());
    expect(rerun.unjudged).toBe(0);
    expect(rerun.records.filter((r) => r.kind === "judgment")).toHaveLength(6);
  });

  it("sends at most four judge calls at a time with --no-batch", async () => {
    let open = 0;
    let most = 0;
    const provider: Provider = {
      async generate<T>(request: GenerateRequest<T>) {
        open++;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open--;
        return {
          output: request.schema.parse(VERDICT),
          usage: { in: 500, out: 100, cacheRead: 0, cacheWrite: 0 },
          model: "claude-haiku-4-5-20251001",
        };
      },
    };
    const result = await runEval(options({ judge: provider, batchJudge: false }));
    expect(result.records.filter((r) => r.kind === "judgment")).toHaveLength(6);
    expect(most).toBe(MAX_DIRECT_JUDGE_CALLS);
    expect(MAX_DIRECT_JUDGE_CALLS).toBe(4);
  });

  it("refuses to go on when a recorded call's model still has no price", async () => {
    await runEval(options());
    const lines = readFileSync(join(dir, RESULTS_FILE), "utf8").trimEnd().split("\n");
    const first = { ...JSON.parse(lines[0] ?? ""), usd: null, model: "claude-unknown-9" };
    writeFileSync(
      join(dir, RESULTS_FILE),
      `${[JSON.stringify(first), ...lines.slice(1, 2)].join("\n")}\n`,
    );
    const agents = scriptedToolProvider([]);
    await expect(runEval(options({ agents: agents.provider }))).rejects.toThrow(
      new UnpricedModelError("claude-unknown-9"),
    );
    expect(agents.requests).toHaveLength(0);
  });

  it("records the answer of an agent that finished when the other one fails, and a rerun asks only the failed agent", async () => {
    const answering = scriptedToolProvider([], () => ({ answer: "wiki answer" }));
    const failing: ToolProvider = {
      async turn(request) {
        if (request.system.includes("wiki")) return answering.provider.turn(request);
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("overloaded");
      },
    };
    await expect(runEval(options({ agents: failing }))).rejects.toThrow("overloaded");
    const kept = readRecords(dir);
    expect(kept.map((r) => `${r.kind}/${r.questionId}/${r.agent}`)).toEqual([
      "answer/smoke-where/wiki",
    ]);
    const rerun = scriptedToolProvider([], (_q, request) => ({
      answer: request.system.includes("wiki") ? "wiki answer" : "repo answer",
    }));
    const result = await runEval(options({ agents: rerun.provider }));
    // smoke-where is asked of the repo agent only; the two other questions of both.
    expect(rerun.requests.filter((r) => r.system.includes("wiki"))).toHaveLength(2);
    expect(rerun.requests).toHaveLength(5);
    expect(result.records.filter((r) => r.kind === "answer")).toHaveLength(6);
  });

  it("refuses a model with no price before any call", async () => {
    const agents = scriptedToolProvider([]);
    const unpricedAgent = info({
      models: { evalAgent: "claude-unknown-9", evalJudge: "claude-haiku-4-5" },
    });
    await expect(
      runEval(options({ agents: agents.provider, info: unpricedAgent })),
    ).rejects.toThrow(new UnpricedModelError("claude-unknown-9"));
    expect(agents.requests).toHaveLength(0);
    const scripted = judge();
    const unpricedJudge = info({
      models: { evalAgent: "claude-haiku-4-5", evalJudge: "claude-unknown-9" },
    });
    const other = mkdtempSync(join(tmpdir(), "repowiki-eval-run-"));
    try {
      await expect(
        runEval(options({ runDir: other, judge: scripted.provider, info: unpricedJudge })),
      ).rejects.toThrow(new UnpricedModelError("claude-unknown-9"));
      expect(scripted.requests).toHaveLength(0);
      expect(readRecords(other)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("stops after recording an answer whose reported model has no price, instead of counting it as free", async () => {
    const agents = scriptedToolProvider([], () => ({
      content: [{ type: "text", text: "answer" }],
      stopReason: "end_turn",
      usage: { in: 1000, out: 100, cacheRead: 0, cacheWrite: 0 },
      model: "claude-unknown-9",
    }));
    await expect(runEval(options({ agents: agents.provider }))).rejects.toThrow(
      new UnpricedModelError("claude-unknown-9"),
    );
    // The first question's two paid answers are on disk; no further question is asked.
    expect(readRecords(dir).map((r) => `${r.questionId}/${r.agent}`)).toEqual([
      "smoke-where/wiki",
      "smoke-where/repo",
    ]);
    expect(agents.requests).toHaveLength(2);
  });

  it("records the judgments it was paid for, then stops when the judge's model has no price", async () => {
    const inner = judge();
    const unpriced: Provider = {
      async generate<T>(request: GenerateRequest<T>) {
        return { ...(await inner.provider.generate(request)), model: "claude-unknown-9" };
      },
    };
    await expect(runEval(options({ judge: unpriced }))).rejects.toThrow(
      new UnpricedModelError("claude-unknown-9"),
    );
    const judged = readRecords(dir).filter((r) => r.kind === "judgment");
    expect(judged).toHaveLength(6);
    expect(judged.every((r) => r.usd === null)).toBe(true);
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
